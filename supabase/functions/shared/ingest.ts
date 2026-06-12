// Shared Ingestion Pipeline
// Processes a single patient billing record: DB insert, token generation, audit logging,
// PDF archiving, and notification dispatch (Resend email + Twilio SMS).
// Used by both upload-batch (portal uploads) and batch-billing (CSV/cron).

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js";
import { queryAdmin } from "./db.ts";
import { sendSMSNotification, sendEmailNotification } from "./notifications.ts";
import { logger } from "./logger.ts";

const APP_URL = Deno.env.get("APP_URL") || "https://mooseshel.github.io/RevFlow";

/**
 * SHA-256 helper for hashing identity verification keys in Deno
 */
async function hashKey(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const rawData = encoder.encode(value.trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", rawData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface StatementRecord {
  patientId?: string;
  patientName: string;
  email: string;
  phone: string;
  zipCode: string;
  ssnLast4: string;
  totalDue: number;
  facilityName: string;
  statementDate: string;
  pdfFilename: string;
}

export interface IngestResult {
  success: boolean;
  tokenId?: string;
  emailSent: boolean;
  smsSent: boolean;
  error?: string;
}

/**
 * Processes a single patient billing statement through the full pipeline:
 * 1. Insert billing_statements row
 * 2. Hash ZIP + SSN last 4
 * 3. Insert verification_tokens
 * 4. Log GENERATED audit event
 * 5. Move PDF to archive/ in storage bucket
 * 6. Dispatch Resend email notification
 * 7. Dispatch Twilio SMS notification
 *
 * @param record - Patient statement data
 * @param supabase - Supabase client for storage operations
 * @returns IngestResult with success status and notification details
 */
export async function processStatementRecord(
  record: StatementRecord,
  supabase: SupabaseClient
): Promise<IngestResult> {
  const patientId = record.patientId || `PAT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  try {
    // 1. Insert billing statement
    const statementRes = await queryAdmin(
      `INSERT INTO billing_statements (patient_id, total_due, statement_pdf_url, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING statement_id`,
      [
        patientId,
        record.totalDue,
        record.pdfFilename,
        JSON.stringify({
          patientName: record.patientName,
          facilityName: record.facilityName,
          statementDate: record.statementDate || new Date().toISOString().slice(0, 10),
        }),
      ]
    );
    const statementId = statementRes.rows[0].statement_id;

    // 2. Hash verification keys
    const hashedZip = await hashKey(record.zipCode);
    const hashedSsnLast4 = await hashKey(record.ssnLast4);

    // 3. Create verification token
    const tokenRes = await queryAdmin(
      `INSERT INTO verification_tokens (statement_id, hashed_zip, hashed_ssn_last4)
       VALUES ($1, $2, $3)
       RETURNING token_id`,
      [statementId, hashedZip, hashedSsnLast4]
    );
    const tokenId = tokenRes.rows[0].token_id;

    // 4. Log GENERATED audit event
    await queryAdmin(
      `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
       VALUES ($1, 'GENERATED', '0.0.0.0', 'RevFlow Upload Portal')`,
      [tokenId]
    );

    // 5. Archive PDF in storage bucket
    try {
      const { error: moveError } = await supabase.storage
        .from("billing-uploads")
        .move(record.pdfFilename, `archive/${record.pdfFilename}`);

      if (moveError) {
        logger.warn("Failed to archive PDF in storage (non-fatal)", {
          pdfFilename: record.pdfFilename,
          error: moveError.message,
        });
      }
    } catch (archiveErr: any) {
      logger.warn("Archive operation threw (non-fatal)", { error: archiveErr.message });
    }

    // 6. Dispatch notifications
    const verificationUrl = `${APP_URL}/?token=${tokenId}`;

    let smsSent = false;
    let emailSent = false;

    if (record.phone) {
      smsSent = await sendSMSNotification({
        toPhone: record.phone,
        verificationUrl,
        tokenId,
      });
    }

    if (record.email) {
      emailSent = await sendEmailNotification({
        toEmail: record.email,
        verificationUrl,
        tokenId,
      });
    }

    logger.info("Successfully processed statement record", { patientId, tokenId });

    return { success: true, tokenId, emailSent, smsSent };
  } catch (error: any) {
    logger.error("Failed to process statement record", { patientId, error: error.message });
    return { success: false, emailSent: false, smsSent: false, error: error.message };
  }
}
