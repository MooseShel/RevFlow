/**
 * Standalone test script for the GoRev PDF Parser.
 *
 * Usage:
 *   npx ts-node scripts/testPdfParser.ts "C:\Users\Husse\Downloads\statement_test_1.pdf"
 *
 * Tests:
 * 1. Auto-detection (single vs multi-patient)
 * 2. Full parsing of all patient records
 * 3. PDF splitting into individual files
 */

import path from "path";
import {
  detectPdfType,
  parseBatchPdf,
  splitToIndividualPdfs,
  ParsedPatientStatement,
} from "../src/services/pdfParser";

// ─── ANSI Colors ───
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function printHeader(text: string) {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(70)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${text}${RESET}`);
  console.log(`${CYAN}${"═".repeat(70)}${RESET}\n`);
}

function printSuccess(text: string) {
  console.log(`  ${GREEN}✓${RESET} ${text}`);
}

function printError(text: string) {
  console.log(`  ${RED}✗${RESET} ${text}`);
}

function printInfo(text: string) {
  console.log(`  ${DIM}${text}${RESET}`);
}

function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printPatientSummary(stmt: ParsedPatientStatement, index: number) {
  console.log(`\n  ${BOLD}${YELLOW}Patient #${index + 1}${RESET}`);
  console.log(`  ├─ Name:            ${BOLD}${stmt.patientName}${RESET}`);
  console.log(`  ├─ Account:         ${stmt.accountNumber} (base: ${stmt.accountNumberBase})`);
  console.log(`  ├─ Address:         ${stmt.address}`);
  console.log(`  ├─ City/State/Zip:  ${stmt.cityStateZip}`);
  console.log(`  ├─ Visit:           ${stmt.visitId} on ${stmt.visitDate} ${stmt.visitTime}`);
  console.log(`  ├─ Physician:       ${stmt.physician} (NPI: ${stmt.physicianNpi})`);
  console.log(`  ├─ Diagnosis:       ${stmt.primaryDiagnosis}`);
  console.log(`  ├─ ${GREEN}Balance:${RESET}         ${BOLD}${formatCurrency(stmt.balance)}${RESET}`);
  console.log(`  ├─ Payments:        ${formatCurrency(stmt.payments)}`);
  console.log(`  ├─ Adjustments:     ${formatCurrency(stmt.adjustments)}`);
  console.log(`  ├─ Charges (${stmt.charges.length}):`);
  for (const charge of stmt.charges) {
    console.log(`  │   ├─ CPT ${charge.cptCode}: ${charge.description.substring(0, 50)}... ${formatCurrency(charge.amount)} x${charge.quantity}`);
  }
  console.log(`  ├─ Payer Payments (${stmt.payerPayments.length}):`);
  for (const pp of stmt.payerPayments) {
    console.log(`  │   ├─ ${pp.payerName}: paid ${formatCurrency(pp.payment)}, adjusted ${formatCurrency(pp.adjustment)}`);
  }
  console.log(`  └─ Source Pages:    ${stmt.sourcePages.map((p) => p + 1).join(", ")}`);
}

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error(`${RED}Usage: npx ts-node scripts/testPdfParser.ts <path-to-pdf>${RESET}`);
    process.exit(1);
  }

  printHeader("GoRev PDF Parser Test");
  console.log(`  Input: ${filePath}\n`);

  // ─── Step 1: Type Detection ───
  printHeader("Step 1: PDF Type Detection");
  const detection = await detectPdfType(filePath);
  printSuccess(`Detected type: ${BOLD}${detection.type.toUpperCase()}${RESET}`);
  printSuccess(`Patient count: ${BOLD}${detection.patientCount}${RESET}`);

  // ─── Step 2: Parse All Patients ───
  printHeader("Step 2: Parse Patient Statements");
  const statements = await parseBatchPdf(filePath);
  printSuccess(`Parsed ${BOLD}${statements.length}${RESET} patient statement(s)`);

  for (let i = 0; i < statements.length; i++) {
    printPatientSummary(statements[i], i);
  }

  // ─── Step 3: Summary Table ───
  printHeader("Step 3: Summary Table");
  console.log(
    `  ${"#".padEnd(4)} ${"Patient Name".padEnd(32)} ${"Account".padEnd(16)} ${"Balance".padEnd(12)} ${"Charges".padEnd(10)} Pages`
  );
  console.log(`  ${"─".repeat(90)}`);
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    console.log(
      `  ${String(i + 1).padEnd(4)} ${s.patientName.padEnd(32)} ${s.accountNumber.padEnd(16)} ${formatCurrency(s.balance).padEnd(12)} ${String(s.charges.length).padEnd(10)} ${s.sourcePages.map((p) => p + 1).join(",")}`
    );
  }

  // ─── Step 4: Split PDFs ───
  if (detection.type === "multi") {
    printHeader("Step 4: Split into Individual PDFs");
    const outputDir = path.join(path.dirname(filePath), "split_statements");
    const splits = await splitToIndividualPdfs(filePath, outputDir);

    for (const split of splits) {
      printSuccess(`${split.patientName} → ${split.outputPath} (${split.pageCount} pages)`);
    }

    console.log(`\n  ${GREEN}${BOLD}Output directory: ${outputDir}${RESET}`);
  } else {
    printInfo("Single patient PDF — no splitting needed.");
  }

  // ─── Final Report ───
  printHeader("Test Complete");
  const totalBalance = statements.reduce((sum, s) => sum + s.balance, 0);
  const totalCharges = statements.reduce((sum, s) => sum + s.charges.reduce((cs, c) => cs + c.amount, 0), 0);
  printSuccess(`Total patients:   ${statements.length}`);
  printSuccess(`Total balance:    ${formatCurrency(totalBalance)}`);
  printSuccess(`Total charges:    ${formatCurrency(totalCharges)}`);

  console.log();
}

main().catch((err) => {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
