import crypto from "crypto";
import { GoRevMockConnector, GoRevPdfConnector, IGoRevConnector } from "../services/gorev";
import { queryAdmin, closePool } from "../services/db";
import { sendSMSNotification, sendEmailNotification } from "../services/notifications";
import { logger } from "../services/logger";
import dotenv from "dotenv";

dotenv.config();

const APP_URL = process.env.PROD_APP_URL || process.env.APP_URL || "http://localhost:3000";

/**
 * SHA-256 helper for hashing identity verification parameters.
 */
export function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value.trim()).digest("hex");
}

/**
 * Executes the billing statement ingestion workflow.
 * @param isCron If true, shuts down database connections and executes process.exit(0) upon completion.
 * @param pdfFilePath Optional path to a GoRev batch PDF file. When provided, uses GoRevPdfConnector
 *                    instead of GoRevMockConnector. Supports both single-patient and multi-patient PDFs.
 */
export async function runBatchIngestion(
  isCron: boolean = false,
  pdfFilePath?: string
): Promise<{ processed: number; succeeded: number }> {
  logger.info("Starting batch billing statement ingestion...", {
    source: pdfFilePath ? "PDF file" : "Mock connector",
    pdfFilePath: pdfFilePath || "N/A",
  });

  // Choose the appropriate connector based on whether a PDF file was provided
  let connector: IGoRevConnector;
  if (pdfFilePath) {
    connector = new GoRevPdfConnector(pdfFilePath);
    logger.info("Using GoRevPdfConnector for PDF processing", { filePath: pdfFilePath });
  } else {
    connector = new GoRevMockConnector();
    logger.info("Using GoRevMockConnector (development mode)");
  }

  let statements = [];
  
  try {
    statements = await connector.fetchRecentBillingStatements();
  } catch (err: any) {
    logger.error("Failed to retrieve statements from GoRev stream", { error: err.message });
    if (isCron) {
      await closePool();
      process.exit(1);
    }
    throw err;
  }

  let processedCount = 0;
  let successCount = 0;

  for (const stmt of statements) {
    processedCount++;
    try {
      // 1. Insert billing statement into the database (admin query)
      const statementRes = await queryAdmin(
        `INSERT INTO billing_statements (patient_id, total_due, statement_pdf_url, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING statement_id`,
        [
          stmt.patientId,
          stmt.totalDue,
          stmt.statementPdfUrl,
          JSON.stringify(stmt.metadata),
        ]
      );
      
      const statementId = statementRes.rows[0].statement_id;

      // 2. Generate hashed verification keys (SHA-256)
      //    If demographics are not yet linked (PDF source without CSV), use available data
      const hashedZip = stmt.zipCode ? hashKey(stmt.zipCode) : hashKey("PENDING");
      const hashedSsnLast4 = stmt.ssnLast4 ? hashKey(stmt.ssnLast4) : hashKey("PENDING");

      // 3. Create the verification token (admin query)
      const tokenRes = await queryAdmin(
        `INSERT INTO verification_tokens (statement_id, hashed_zip, hashed_ssn_last4)
         VALUES ($1, $2, $3)
         RETURNING token_id`,
        [statementId, hashedZip, hashedSsnLast4]
      );
      
      const tokenId = tokenRes.rows[0].token_id;

      // 4. Log the audit event 'GENERATED'
      await queryAdmin(
        `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
         VALUES ($1, 'GENERATED', '127.0.0.1', 'GoRev Batch Cron')`,
        [tokenId]
      );

      // 5. Construct unauthenticated verification URL
      const verificationUrl = `${APP_URL}/?token=${tokenId}`;

      // 6. Dispatch notifications (only if demographics are available)
      let smsSuccess = false;
      let emailSuccess = false;

      if (stmt.phone) {
        smsSuccess = await sendSMSNotification({
          toPhone: stmt.phone,
          verificationUrl,
          tokenId,
        });
      } else {
        logger.info("Skipping SMS — no phone number available (demographics not yet linked)", {
          patientId: stmt.patientId,
        });
      }

      if (stmt.email) {
        emailSuccess = await sendEmailNotification({
          toEmail: stmt.email,
          verificationUrl,
          tokenId,
        });
      } else {
        logger.info("Skipping email — no email address available (demographics not yet linked)", {
          patientId: stmt.patientId,
        });
      }

      if (smsSuccess || emailSuccess || (!stmt.phone && !stmt.email)) {
        // Count as success even without notifications if demographics aren't linked yet
        successCount++;
      }

      logger.info("Successfully processed billing record", {
        tokenId,
        patientId: stmt.patientId,
        smsDispatched: smsSuccess,
        emailDispatched: emailSuccess,
        demographicsLinked: !!(stmt.phone || stmt.email),
      });

    } catch (recordError: any) {
      logger.error("Failed to process individual billing statement", {
        patientId: stmt.patientId,
        error: recordError.message,
      });
    }
  }

  logger.info("Batch statement ingestion completed.", {
    totalRecords: processedCount,
    notifiedSuccessfully: successCount,
  });

  if (isCron) {
    logger.info("Cron execution finished. Closing connection pool and terminating process...");
    await closePool();
    process.exit(0);
  }

  return { processed: processedCount, succeeded: successCount };
}

// Execute batch run immediately if this module is run directly in terminal
// Supports: npx ts-node src/cron/batchBilling.ts --pdf "C:\path\to\batch.pdf"
if (require.main === module) {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  let pdfFilePath: string | undefined;

  const pdfArgIndex = args.indexOf("--pdf");
  if (pdfArgIndex !== -1 && args[pdfArgIndex + 1]) {
    pdfFilePath = args[pdfArgIndex + 1];
  }

  runBatchIngestion(true, pdfFilePath).catch(async (error) => {
    logger.error("Critical error in batch billing script execution", { error: error.message });
    try {
      await closePool();
    } catch (dbErr: any) {
      logger.error("Error closing connection pool during crash cleanup", { error: dbErr.message });
    }
    process.exit(1);
  });
}
