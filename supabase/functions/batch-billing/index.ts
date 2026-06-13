// Deno Edge Function: /batch-billing
// Triggered by pg_cron or admin trigger.
// Scans Supabase Storage for index.csv and PDFs, ingests statements, sends alerts, and archives.

import { createClient } from "npm:@supabase/supabase-js";
import { queryAdmin } from "../shared/db.ts";
import { processStatementRecord, StatementRecord } from "../shared/ingest.ts";
import { logger } from "../shared/logger.ts";

// Initialize Supabase Client for storage operations
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
    const dataRows = csvRows.slice(1);

    logger.info(`Processing ${dataRows.length} billing rows from CSV...`);
    let succeededCount = 0;

    for (const row of dataRows) {
      if (row.length < 8) continue; // skip invalid rows
      
      const [patientId, patientName, email, phone, zipCode, _ssnLast4, totalDueStr, pdfFilename] = row;
      const totalDue = parseFloat(totalDueStr);

      // Verify corresponding PDF statement file exists in storage root
      const pdfExists = files?.some((f) => f.name === pdfFilename);
      if (!pdfExists) {
        logger.error(`Skipped ingestion: corresponding statement PDF was not found in storage`, { pdfFilename, patientId });
        continue;
      }

      // Use shared ingestion pipeline
      const record: StatementRecord = {
        patientId,
        patientName,
        email,
        phone,
        zipCode,
        totalDue,
        customerAccountId: patientId,
        statementDate: new Date().toISOString().slice(0, 10),
        pdfFilename,
      };

      const result = await processStatementRecord(record, supabase);
      if (result.success) {
        succeededCount++;
      }
    }

    // Archive the CSV file to prevent reprocessing on next run
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
