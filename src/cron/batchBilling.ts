import crypto from "crypto";
import { GoRevMockConnector } from "../services/gorev";
import { queryAdmin, closePool } from "../services/db";
import { sendSMSNotification, sendEmailNotification } from "../services/notifications";
import { logger } from "../services/logger";
import dotenv from "dotenv";

dotenv.config();

const APP_URL = process.env.APP_URL || "http://localhost:3000";

/**
 * SHA-256 helper for hashing identity verification parameters.
 */
export function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value.trim()).digest("hex");
}

/**
 * Executes the billing statement ingestion workflow.
 * @param isCron If true, shuts down database connections and executes process.exit(0) upon completion.
 */
export async function runBatchIngestion(isCron: boolean = false): Promise<{ processed: number; succeeded: number }> {
  logger.info("Starting batch billing statement ingestion...");
  
  const connector = new GoRevMockConnector();
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
      const hashedZip = hashKey(stmt.zipCode);
      const hashedSsnLast4 = hashKey(stmt.ssnLast4);

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

      // 6. Dispatch notifications
      const smsSuccess = await sendSMSNotification({
        toPhone: stmt.phone,
        verificationUrl,
        tokenId,
      });

      const emailSuccess = await sendEmailNotification({
        toEmail: stmt.email,
        verificationUrl,
        tokenId,
      });

      if (smsSuccess || emailSuccess) {
        successCount++;
      }

      logger.info("Successfully processed billing record", {
        tokenId,
        patientId: stmt.patientId, // Patient ID is safe to log, but name/due-amount is stripped by logger
        smsDispatched: smsSuccess,
        emailDispatched: emailSuccess,
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
if (require.main === module) {
  runBatchIngestion(true).catch(async (error) => {
    logger.error("Critical error in batch billing script execution", { error: error.message });
    try {
      await closePool();
    } catch (dbErr: any) {
      logger.error("Error closing connection pool during crash cleanup", { error: dbErr.message });
    }
    process.exit(1);
  });
}
