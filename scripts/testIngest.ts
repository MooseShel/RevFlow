/**
 * Test ingestion script — loads the batch PDF into Supabase
 * and prints verification tokens + ZIP codes for testing.
 */
import crypto from "crypto";
import { GoRevPdfConnector } from "../src/services/gorev";
import { queryAdmin, closePool } from "../src/services/db";

async function ingest() {
  const pdfPath = process.argv[2] || "C:\\Users\\Husse\\Downloads\\statement_test_1.pdf";

  console.log("\n🔄 Processing batch PDF:", pdfPath, "\n");

  const connector = new GoRevPdfConnector(pdfPath);
  const stmts = await connector.fetchRecentBillingStatements();

  console.log(`✅ Extracted ${stmts.length} patient statements\n`);
  console.log("─".repeat(110));
  console.log(
    "Patient".padEnd(30),
    "Token (for URL)".padEnd(40),
    "ZIP".padEnd(8),
    "Balance".padEnd(12)
  );
  console.log("─".repeat(110));

  for (const stmt of stmts) {
    // Insert billing statement
    const sr = await queryAdmin(
      `INSERT INTO billing_statements (patient_id, total_due, statement_pdf_url, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING statement_id`,
      [stmt.patientId, stmt.totalDue, stmt.statementPdfUrl, JSON.stringify(stmt.metadata)]
    );
    const statementId = sr.rows[0].statement_id;

    // Hash verification keys
    const hashedZip = crypto.createHash("sha256").update(stmt.zipCode || "PENDING").digest("hex");
    const hashedSsn = crypto.createHash("sha256").update(stmt.ssnLast4 || "PENDING").digest("hex");

    // Insert verification token
    const tr = await queryAdmin(
      `INSERT INTO verification_tokens (statement_id, hashed_zip, hashed_ssn_last4)
       VALUES ($1, $2, $3)
       RETURNING token_id`,
      [statementId, hashedZip, hashedSsn]
    );
    const tokenId = tr.rows[0].token_id;

    // Audit log
    await queryAdmin(
      `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
       VALUES ($1, 'GENERATED', '127.0.0.1', 'Test Ingestion Script')`,
      [tokenId]
    );

    console.log(
      stmt.patientName.padEnd(30),
      tokenId.padEnd(40),
      (stmt.zipCode || "N/A").padEnd(8),
      `$${stmt.totalDue.toFixed(2)}`.padEnd(12)
    );
  }

  console.log("─".repeat(110));
  console.log(`\n🔗 Test URLs (paste in browser):\n`);

  // Re-query to print all tokens for copy-paste
  const allTokens = await queryAdmin(
    `SELECT vt.token_id, bs.patient_id, bs.total_due, bs.metadata
     FROM verification_tokens vt
     JOIN billing_statements bs ON bs.statement_id = vt.statement_id
     ORDER BY vt.created_at DESC
     LIMIT 8`
  );

  for (const row of allTokens.rows) {
    const name = row.metadata?.physician || row.patient_id;
    console.log(`  http://localhost:3000/?token=${row.token_id}`);
  }

  console.log("\n✅ Ingestion complete! Use the ZIP code from the PDF as the verification key.\n");

  await closePool();
  process.exit(0);
}

ingest().catch(async (e) => {
  console.error("❌ Error:", e.message);
  await closePool();
  process.exit(1);
});
