/**
 * Full End-to-End Test — Single Patient
 *
 * Parses the batch PDF, picks one patient, ingests into Supabase,
 * and dispatches REAL SMS + Email notifications.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/testE2E.ts "C:\path\to\batch.pdf"
 */
import crypto from "crypto";
import { GoRevPdfConnector } from "../src/services/gorev";
import { queryAdmin, closePool } from "../src/services/db";
import { sendSMSNotification, sendEmailNotification } from "../src/services/notifications";
import { logger } from "../src/services/logger";
import dotenv from "dotenv";

dotenv.config();

// ─── Test Configuration ───
const TEST_PHONE = "+17135848484";
const TEST_EMAIL = "Hussein.Shel@outlook.com";
const APP_URL = process.env.PROD_APP_URL || process.env.APP_URL || "http://localhost:3000";

async function runE2E() {
  const pdfPath = process.argv[2] || "C:\\Users\\Husse\\Downloads\\statement_test_1.pdf";

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║        RevFlow — Full End-to-End Pipeline Test              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // ─── Step 1: Parse the batch PDF ───
  console.log("━━━ Step 1: Parse Batch PDF ━━━");
  console.log(`  File: ${pdfPath}\n`);

  const connector = new GoRevPdfConnector(pdfPath);
  const allStatements = await connector.fetchRecentBillingStatements();
  console.log(`  ✅ Extracted ${allStatements.length} patient(s) from PDF\n`);

  // Pick the FIRST patient for testing
  const stmt = allStatements[0];
  console.log(`  📋 Selected patient: ${stmt.patientName}`);
  console.log(`     Account:  ${stmt.metadata.accountNumber}`);
  console.log(`     Balance:  $${stmt.totalDue.toFixed(2)}`);
  console.log(`     Facility: ${stmt.metadata.facilityName}`);
  console.log(`     ZIP:      ${stmt.zipCode}`);
  console.log();

  // Override contact info with YOUR details
  stmt.email = TEST_EMAIL;
  stmt.phone = TEST_PHONE;
  console.log(`  📱 Overriding contact info for test:`);
  console.log(`     Phone: ${TEST_PHONE}`);
  console.log(`     Email: ${TEST_EMAIL}\n`);

  // ─── Step 2: Ingest into Supabase ───
  console.log("━━━ Step 2: Ingest into Supabase ━━━");

  const statementRes = await queryAdmin(
    `INSERT INTO billing_statements (patient_id, total_due, statement_pdf_url, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING statement_id`,
    [stmt.patientId, stmt.totalDue, stmt.statementPdfUrl, JSON.stringify(stmt.metadata)]
  );
  const statementId = statementRes.rows[0].statement_id;
  console.log(`  ✅ Billing statement inserted: ${statementId}`);

  // Hash verification keys
  const hashedZip = crypto.createHash("sha256").update(stmt.zipCode).digest("hex");

  const tokenRes = await queryAdmin(
    `INSERT INTO verification_tokens (statement_id, hashed_zip)
     VALUES ($1, $2)
     RETURNING token_id`,
    [statementId, hashedZip]
  );
  const tokenId = tokenRes.rows[0].token_id;
  console.log(`  ✅ Verification token created: ${tokenId}`);

  // Audit log
  await queryAdmin(
    `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
     VALUES ($1, 'GENERATED', '127.0.0.1', 'E2E Test Script')`,
    [tokenId]
  );
  console.log(`  ✅ Audit log recorded\n`);

  // ─── Step 3: Build Verification URL ───
  const verificationUrl = `${APP_URL}/?token=${tokenId}`;
  console.log("━━━ Step 3: Verification URL ━━━");
  console.log(`  🔗 ${verificationUrl}\n`);

  // ─── Step 4: Send Notifications ───
  console.log("━━━ Step 4: Send Notifications ━━━");

  console.log(`  📱 Sending SMS to ${TEST_PHONE}...`);
  const smsOk = await sendSMSNotification({
    toPhone: TEST_PHONE,
    verificationUrl,
    tokenId,
  });
  console.log(`  ${smsOk ? "✅" : "❌"} SMS ${smsOk ? "sent successfully" : "FAILED"}\n`);

  console.log(`  📧 Sending Email to ${TEST_EMAIL}...`);
  const emailOk = await sendEmailNotification({
    toEmail: TEST_EMAIL,
    verificationUrl,
    tokenId,
  });
  console.log(`  ${emailOk ? "✅" : "❌"} Email ${emailOk ? "sent successfully" : "FAILED"}\n`);

  // ─── Step 5: Print instructions ───
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                    TEST INSTRUCTIONS                        ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║                                                              ║");
  console.log("║  1. Check your phone for the SMS notification               ║");
  console.log("║  2. Check your email for the billing notification           ║");
  console.log("║  3. Click the link in the SMS/email — OR paste this URL:    ║");
  console.log("║                                                              ║");
  console.log(`║  ${verificationUrl}`);
  console.log("║                                                              ║");
  console.log(`║  4. Enter ZIP code: ${stmt.zipCode}                              ║`);
  console.log("║  5. Click 'Verify & View Statement'                         ║");
  console.log("║  6. You should see:                                         ║");
  console.log(`║     • Balance: $${stmt.totalDue.toFixed(2)}                              ║`);
  console.log(`║     • Facility: ${stmt.metadata.facilityName}                      ║`);
  console.log(`║     • Date: ${stmt.metadata.statementDate}                           ║`);
  console.log("║                                                              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  await closePool();
  process.exit(0);
}

runE2E().catch(async (e) => {
  console.error("❌ Fatal error:", e.message);
  console.error(e.stack);
  await closePool();
  process.exit(1);
});
