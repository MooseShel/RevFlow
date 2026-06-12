// Deno Edge Function: /batch-billing
// Triggered by pg_cron or admin trigger.
// Scans Supabase Storage for index.csv and PDFs, ingests statements, sends alerts, and archives.

import { createClient } from "npm:@supabase/supabase-js";
import { queryAdmin } from "../shared/db.ts";
import { sendSMSNotification, sendEmailNotification } from "../shared/notifications.ts";
import { logger } from "../shared/logger.ts";

const APP_URL = Deno.env.get("APP_URL") || "https://mooseshel.github.io/RevFlow";

// Initialize Supabase Client for storage operations
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * SHA-256 helper for hashing keys in Deno
 */
async function hashKey(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const rawData = encoder.encode(value.trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", rawData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parses simple CSV content safely
 */
function parseCSV(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      // Splits commas, removing wrapping quotes
      return line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    });
}

Deno.serve(async (req: Request) => {
  // Enforce Service Role Auth Key for security
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.split(" ")[1] !== supabaseServiceKey) {
    logger.warn("Unauthorized batch trigger attempt: invalid auth token");
    return new Response(JSON.stringify({ error: "Unauthorized access" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  logger.info("Starting batch billing statement ingestion from Storage Drop-Box...");

  try {
    // 1. List files in the 'billing-uploads' storage bucket
    const { data: files, error: listError } = await supabase.storage
      .from("billing-uploads")
      .list("", { limit: 100 });

    if (listError) {
      logger.error("Failed to list files in storage bucket", { error: listError.message });
      throw listError;
    }

    // 2. Find the index.csv file
    const csvFile = files?.find((f) => f.name.toLowerCase().endsWith(".csv"));

    if (!csvFile) {
      logger.info("No pending index.csv found in storage bucket root. Skipping ingestion.");
      return new Response(JSON.stringify({ message: "No pending batch files found." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    logger.info(`Found pending batch CSV file: ${csvFile.name}. Starting download...`);

    // 3. Download the CSV file
    const { data: blobData, error: downloadError } = await supabase.storage
      .from("billing-uploads")
      .download(csvFile.name);

    if (downloadError) {
      logger.error("Failed to download batch CSV file", { filename: csvFile.name, error: downloadError.message });
      throw downloadError;
    }

    const csvText = await blobData.text();
    const csvRows = parseCSV(csvText);

    if (csvRows.length <= 1) {
      logger.warn("CSV batch file contains no data rows or only header. Deleting file...");
      await supabase.storage.from("billing-uploads").remove([csvFile.name]);
      return new Response(JSON.stringify({ message: "Ingestion skipped: empty CSV file." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Header structure: patient_id, name, email, phone, zip, ssn_last4, total_due, pdf_filename
    const header = csvRows[0];
    const dataRows = csvRows.slice(1);

    logger.info(`Processing ${dataRows.length} billing rows from CSV...`);
    let succeededCount = 0;

    for (const row of dataRows) {
      if (row.length < 8) continue; // skip invalid rows
      
      const [patientId, patientName, email, phone, zipCode, ssnLast4, totalDueStr, pdfFilename] = row;
      const totalDue = parseFloat(totalDueStr);

      try {
        // 4. Verify corresponding PDF statement file exists in storage root
        const pdfExists = files?.some((f) => f.name === pdfFilename);
        if (!pdfExists) {
          logger.error(`Skipped ingestion: corresponding statement PDF was not found in storage`, { pdfFilename, patientId });
          continue;
        }

        // 5. Ingest statement details (admin database query)
        const statementRes = await queryAdmin(
          `INSERT INTO billing_statements (patient_id, total_due, statement_pdf_url, metadata)
           VALUES ($1, $2, $3, $4)
           RETURNING statement_id`,
          [
            patientId,
            totalDue,
            pdfFilename, // Storing filename relative to storage bucket
            JSON.stringify({ patientName, facilityName: "GoRev Medical Facility", statementDate: new Date().toISOString().slice(0, 10) }),
          ]
        );
        const statementId = statementRes.rows[0].statement_id;

        // 6. Generate SHA-256 verification hashes
        const hashedZip = await hashKey(zipCode);
        const hashedSsnLast4 = await hashKey(ssnLast4);

        // 7. Create verification token (admin database query)
        const tokenRes = await queryAdmin(
          `INSERT INTO verification_tokens (statement_id, hashed_zip, hashed_ssn_last4)
           VALUES ($1, $2, $3)
           RETURNING token_id`,
          [statementId, hashedZip, hashedSsnLast4]
        );
        const tokenId = tokenRes.rows[0].token_id;

        // 8. Log the audit event 'GENERATED'
        await queryAdmin(
          `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
           VALUES ($1, 'GENERATED', '127.0.0.1', 'Serverless Storage Ingestion')`,
          [tokenId]
        );

        // 9. Move PDF statement to archive subfolder inside storage bucket
        const { error: moveError } = await supabase.storage
          .from("billing-uploads")
          .move(pdfFilename, `archive/${pdfFilename}`);

        if (moveError) {
          logger.error("Failed to archive PDF statement file in storage", { pdfFilename, error: moveError.message });
          throw moveError;
        }

        // 10. Dispatch notifications
        const verificationUrl = `${APP_URL}/?token=${tokenId}`;
        const smsSuccess = await sendSMSNotification({
          toPhone: phone,
          verificationUrl,
          tokenId,
        });

        const emailSuccess = await sendEmailNotification({
          toEmail: email,
          verificationUrl,
          tokenId,
        });

        if (smsSuccess || emailSuccess) {
          succeededCount++;
        }

        logger.info("Successfully processed batch row statement and notification", {
          patientId,
          tokenId,
        });

      } catch (rowErr: any) {
        logger.error("Error processing statement row in batch loop", { patientId, error: rowErr.message });
      }
    }

    // 11. Archive the CSV file to prevent reprocessing on next run
    const archivedCsvName = `archive/index_${Date.now()}.csv`;
    const { error: moveCsvError } = await supabase.storage
      .from("billing-uploads")
      .move(csvFile.name, archivedCsvName);

    if (moveCsvError) {
      logger.error("Failed to archive batch CSV index file", { filename: csvFile.name, error: moveCsvError.message });
    }

    logger.info("Batch ingestion run completed.", {
      totalProcessed: dataRows.length,
      alertsDispatched: succeededCount,
    });

    return new Response(JSON.stringify({
      success: true,
      processed: dataRows.length,
      notified: succeededCount,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: any) {
    logger.error("Fatal error inside batch billing function execution", { error: error.message });
    return new Response(JSON.stringify({ error: "Internal processing error occurred." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
