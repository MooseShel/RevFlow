/**
 * GoRev Batch PDF Parser & Splitter
 *
 * Processes GoRev CRM batch statement PDFs that contain multiple patient bills.
 * Auto-detects single vs multi-patient files. Extracts structured billing data
 * per patient and splits multi-patient PDFs into individual files.
 *
 * @module pdfParser
 */

import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { logger } from "./logger";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ItemizedCharge {
  chargeCode: string;
  revCode: string;
  cptCode: string;
  dateOfService: string;
  description: string;
  amount: number;
  quantity: number;
}

export interface PayerPayment {
  payerName: string;
  date: string;
  payment: number;
  adjustment: number;
}

export interface ParsedPatientStatement {
  patientName: string;
  accountNumber: string;        // e.g. "70003905-1" (visit-level)
  accountNumberBase: string;    // e.g. "70003905" (patient-level, for demographics matching)
  address: string;
  cityStateZip: string;
  balance: number;
  payments: number;
  adjustments: number;
  visitId: string;
  visitDate: string;
  visitTime: string;
  physician: string;
  physicianNpi: string;
  primaryDiagnosis: string;
  facilityName: string;
  facilityAddress: string;
  charges: ItemizedCharge[];
  payerPayments: PayerPayment[];
  sourcePages: number[];         // 0-indexed page numbers from the original PDF
}

export interface SplitResult {
  accountNumber: string;
  patientName: string;
  outputPath: string;
  pageCount: number;
}

export type PdfType = "single" | "multi";

// ──────────────────────────────────────────────
// PyMuPDF-based text extraction via subprocess
// ──────────────────────────────────────────────

/**
 * Extract text from each page of a PDF using PyMuPDF (fitz).
 * We shell out to a Python script file because PyMuPDF gives much better
 * text extraction than pure-JS alternatives, especially for GoRev's PDFium output.
 */
async function extractPagesText(filePath: string): Promise<string[]> {
  const { execSync } = await import("child_process");
  const os = await import("os");

  // Write a temp Python script (avoids PowerShell escaping nightmares)
  const tmpScript = path.join(os.tmpdir(), `revflow_pdf_extract_${Date.now()}.py`);
  const pyCode = [
    "import fitz, json, sys",
    "doc = fitz.open(sys.argv[1])",
    'pages = [doc[i].get_text("text") for i in range(doc.page_count)]',
    "doc.close()",
    "print(json.dumps(pages))",
  ].join("\n");

  fs.writeFileSync(tmpScript, pyCode, "utf-8");

  try {
    const result = execSync(
      `python "${tmpScript}" "${filePath}"`,
      { maxBuffer: 50 * 1024 * 1024, encoding: "utf-8" }
    );
    return JSON.parse(result.trim());
  } catch (err: any) {
    logger.error("PyMuPDF text extraction failed, falling back to pdf-parse", { error: err.message });
    return await extractPagesTextFallback(filePath);
  } finally {
    // Clean up temp script
    try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}

/**
 * Fallback text extraction using pdf-parse (pure JS).
 * Uses pagerender callback to capture per-page text.
 */
async function extractPagesTextFallback(filePath: string): Promise<string[]> {
  const pdfParse: any = require("pdf-parse"); // eslint-disable-line @typescript-eslint/no-var-requires
  const buffer = fs.readFileSync(filePath);

  const pages: string[] = [];
  await pdfParse(buffer, {
    pagerender: async (pageData: any) => {
      const textContent = await pageData.getTextContent();
      const text = textContent.items.map((item: any) => item.str).join("\n");
      pages.push(text);
      return text;
    },
  });

  return pages;
}

// ──────────────────────────────────────────────
// PDF Type Detection
// ──────────────────────────────────────────────

/**
 * Detect whether a PDF contains a single patient bill or multiple.
 * Counts unique Account Number patterns across all pages.
 */
export async function detectPdfType(filePath: string): Promise<{ type: PdfType; patientCount: number }> {
  const pages = await extractPagesText(filePath);
  const accountNumbers = new Set<string>();

  for (const pageText of pages) {
    const matches = pageText.match(/Account\s*Number:\s*([\w-]+)/gi);
    if (matches) {
      for (const m of matches) {
        const acct = m.replace(/Account\s*Number:\s*/i, "").trim();
        accountNumbers.add(acct);
      }
    }
  }

  const count = accountNumbers.size;
  return {
    type: count <= 1 ? "single" : "multi",
    patientCount: Math.max(count, 1),
  };
}

// ──────────────────────────────────────────────
// Text Parsing Helpers
// ──────────────────────────────────────────────

function extractField(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function extractDollarAmount(text: string, fieldName: string): number {
  // Match patterns like "Balance: $ 500.00" or "Balance: $500.00"
  const regex = new RegExp(`${fieldName}:\\s*\\$\\s*([\\d,]+\\.\\d{2})`, "i");
  const match = text.match(regex);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ""));
  }
  return 0;
}

function parseCharges(text: string): ItemizedCharge[] {
  const charges: ItemizedCharge[] = [];

  // Split text into lines for sequential parsing
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Find the charge table section (after "Qty" header, before "Total")
  let inChargeSection = false;
  let i = 0;

  while (i < lines.length) {
    // Detect start of charge table (after "Qty" column header)
    if (lines[i] === "Qty") {
      inChargeSection = true;
      i++;
      continue;
    }

    // Detect end of charge section
    if (inChargeSection && lines[i] === "Total") {
      break;
    }

    if (inChargeSection) {
      // Try to parse a charge entry
      // Pattern: chargeCode, revCode, cptCode, date, description lines, amount, quantity
      // The charge code is the first line, followed by revCode (4-digit), cptCode, date
      const chargeCode = lines[i] || "";

      // Look ahead for the REV code (4-digit number starting with 0)
      if (i + 1 < lines.length && /^0\d{3}$/.test(lines[i + 1])) {
        const revCode = lines[i + 1];
        const cptCode = i + 2 < lines.length ? lines[i + 2] : "";
        const dateMatch = i + 3 < lines.length ? lines[i + 3].match(/^\d{1,2}\/\d{1,2}\/\d{4}$/) : null;
        const dateOfService = dateMatch ? lines[i + 3] : "";

        // Collect description lines (everything between date and dollar amount)
        let descLines: string[] = [];
        let j = dateMatch ? i + 4 : i + 4;
        let amount = 0;
        let quantity = 1;

        while (j < lines.length) {
          // Check if this line is a dollar amount
          const amountMatch = lines[j].match(/^\$\s*([\d,]+\.\d{2})$/);
          if (amountMatch) {
            amount = parseFloat(amountMatch[1].replace(/,/g, ""));
            // Next line should be quantity
            if (j + 1 < lines.length && /^\d+$/.test(lines[j + 1])) {
              quantity = parseInt(lines[j + 1], 10);
              j += 2;
            } else {
              j++;
            }
            break;
          }

          // Check if we hit a bare "$" (amount on next line)
          if (lines[j] === "$" && j + 1 < lines.length) {
            const nextAmountMatch = lines[j + 1].match(/^([\d,]+\.\d{2})$/);
            if (nextAmountMatch) {
              amount = parseFloat(nextAmountMatch[1].replace(/,/g, ""));
              if (j + 2 < lines.length && /^\d+$/.test(lines[j + 2])) {
                quantity = parseInt(lines[j + 2], 10);
                j += 3;
              } else {
                j += 2;
              }
              break;
            }
          }

          descLines.push(lines[j]);
          j++;
        }

        charges.push({
          chargeCode,
          revCode,
          cptCode,
          dateOfService,
          description: descLines.join(" "),
          amount,
          quantity,
        });

        i = j;
        continue;
      }
    }

    i++;
  }

  return charges;
}

function parsePayerPayments(text: string): PayerPayment[] {
  const payments: PayerPayment[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Find the Payer/Date/Payment/Adjustment section
  let inPayerSection = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "Adjustment" && i > 0 && lines[i - 1] === "Payment") {
      inPayerSection = true;
      // Don't increment i here — the for-loop's i++ will advance past "Adjustment"
      // and the next iteration will correctly land on the first payer name
      continue;
    }

    if (inPayerSection) {
      // End of payer section
      if (lines[i] === "Total") {
        break;
      }

      // Payer name line (not a date, not a $ amount)
      const payerName = lines[i];
      if (!payerName || /^\$/.test(payerName) || /^\d{1,2}\/\d{1,2}\/\d{4}/.test(payerName)) {
        continue;
      }

      // Next line should be date
      if (i + 1 < lines.length && /^\d{1,2}\/\d{1,2}\/\d{4}/.test(lines[i + 1])) {
        const date = lines[i + 1];

        // Parse payment amount ($ X.XX)
        let payment = 0;
        let adjustment = 0;
        let j = i + 2;

        if (j < lines.length && /^\$\s*[\d,]+\.\d{2}$/.test(lines[j])) {
          payment = parseFloat(lines[j].replace(/^\$\s*/, "").replace(/,/g, ""));
          j++;
        }

        if (j < lines.length && /^\$\s*[\d,]+\.\d{2}$/.test(lines[j])) {
          adjustment = parseFloat(lines[j].replace(/^\$\s*/, "").replace(/,/g, ""));
          j++;
        }

        payments.push({ payerName, date, payment, adjustment });
        i = j - 1; // -1 because for loop increments
      }
    }
  }

  return payments;
}

// ──────────────────────────────────────────────
// Core Parser
// ──────────────────────────────────────────────

/**
 * Groups PDF pages by patient. Each patient's statement begins on a page
 * containing "Visit:" and "Account Number:" and may span multiple pages.
 * The "footer/mailer" pages (containing just facility address + account number)
 * are grouped with the preceding patient.
 */
function groupPagesByPatient(pagesText: string[]): Map<string, { pages: number[]; text: string }> {
  const groups = new Map<string, { pages: number[]; text: string }>();
  let currentAccount: string | null = null;

  for (let i = 0; i < pagesText.length; i++) {
    const pageText = pagesText[i];

    // Check if this page starts a new patient (has Account Number + Visit)
    const accountMatch = pageText.match(/Account\s*Number:\s*([\w-]+)/i);
    const visitMatch = pageText.match(/Visit:\s*([\w-]+)/i);

    if (accountMatch && visitMatch) {
      // New patient statement page
      currentAccount = accountMatch[1];
      if (!groups.has(currentAccount)) {
        groups.set(currentAccount, { pages: [], text: "" });
      }
      const group = groups.get(currentAccount)!;
      group.pages.push(i);
      group.text += pageText + "\n";
    } else if (currentAccount) {
      // Continuation/footer page — belongs to current patient
      const group = groups.get(currentAccount)!;
      group.pages.push(i);
      group.text += pageText + "\n";
    }
  }

  return groups;
}

/**
 * Parse a single patient's concatenated text into structured data.
 */
function parsePatientText(text: string, pages: number[]): ParsedPatientStatement {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Extract visit info
  const visitMatch = text.match(/Visit:\s*([\w-]+)\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const visitId = visitMatch ? visitMatch[1] : "";
  const visitDate = visitMatch ? visitMatch[2] : "";
  const visitTimeMatch = text.match(/Date:\s*\d{1,2}\/\d{1,2}\/\d{4}\s*\n\s*(\d{1,2}:\d{2}:\d{2}\s*[AP]M)/i);
  const visitTime = visitTimeMatch ? visitTimeMatch[1] : "";

  // Account number
  const accountNumber = extractField(text, /Account\s*Number:\s*([\w-]+)/i);
  const accountNumberBase = accountNumber.replace(/-\d+$/, "");

  // Physician
  const physician = extractField(text, /Physician:\s*(.+)/i);
  const physicianNpi = extractField(text, /Physician\s*NPI:\s*(\d+)/i);

  // Patient name — appears on the line after the Physician NPI line
  let patientName = "";
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^Physician\s*NPI:/i) && i + 1 < lines.length) {
      patientName = lines[i + 1];
      break;
    }
  }

  // Address and City/State/Zip — extracted with regex since GoRev PDFs
  // interleave address lines with Balance/Payments/Adjustments fields
  let address = "";
  let cityStateZip = "";

  // Extract city/state/zip using regex (e.g. "BAYTOWN, TX 77521" or "Baytown, TX 77523")
  const cityStateZipMatch = text.match(/([A-Za-z\s]+,\s*TX\s+\d{5})/i);
  if (cityStateZipMatch) {
    cityStateZip = cityStateZipMatch[1].trim();
  }

  // Extract street address: lines between patient name and the first financial/metadata field
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === patientName && patientName) {
      let j = i + 1;
      // Skip "Account Number:" line if it comes next
      if (j < lines.length && lines[j].startsWith("Account Number:")) {
        j++;
      }
      // Collect address lines — stop at Balance, Payments, or city/state/zip
      const addrLines: string[] = [];
      while (j < lines.length) {
        const line = lines[j];
        if (
          line.startsWith("Balance:") ||
          line.startsWith("Payments:") ||
          line.startsWith("Adjustments:") ||
          line === cityStateZip ||
          /^Primary\s*Diagnosis:/i.test(line)
        ) {
          break;
        }
        addrLines.push(line);
        j++;
      }
      address = addrLines.join(", ");
      break;
    }
  }

  // Financial summary
  const balance = extractDollarAmount(text, "Balance");
  const payments = extractDollarAmount(text, "Payments");
  const adjustments = extractDollarAmount(text, "Adjustments");

  // Diagnosis
  const primaryDiagnosis = extractField(text, /Primary\s*Diagnosis:\s*(\S+)/i);

  // Facility info
  const facilityName = "Baytown First ER"; // Consistent across all pages in this batch
  const facilityAddress = "1233 Yale Street, Houston, Texas 77008";

  // Itemized charges & payer payments
  const charges = parseCharges(text);
  const payerPayments = parsePayerPayments(text);

  return {
    patientName,
    accountNumber,
    accountNumberBase,
    address,
    cityStateZip,
    balance,
    payments,
    adjustments,
    visitId,
    visitDate,
    visitTime,
    physician,
    physicianNpi,
    primaryDiagnosis,
    facilityName,
    facilityAddress,
    charges,
    payerPayments,
    sourcePages: pages,
  };
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Parse a GoRev batch PDF into structured patient statement records.
 * Works for both single-patient and multi-patient PDFs.
 */
export async function parseBatchPdf(filePath: string): Promise<ParsedPatientStatement[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath}`);
  }

  logger.info("Starting PDF parsing", { filePath });
  const pagesText = await extractPagesText(filePath);
  logger.info(`Extracted text from ${pagesText.length} pages`);

  const groups = groupPagesByPatient(pagesText);
  logger.info(`Identified ${groups.size} patient statement(s)`);

  const statements: ParsedPatientStatement[] = [];
  for (const [account, { pages, text }] of groups) {
    try {
      const parsed = parsePatientText(text, pages);
      statements.push(parsed);
      logger.info(`Parsed statement for ${parsed.patientName}`, {
        accountNumber: account,
        balance: parsed.balance,
        chargeCount: parsed.charges.length,
        pages: pages.map((p) => p + 1).join(", "),
      });
    } catch (err: any) {
      logger.error(`Failed to parse patient statement for account ${account}`, { error: err.message });
    }
  }

  return statements;
}

/**
 * Split a multi-patient batch PDF into individual per-patient PDF files.
 * Each output PDF contains only the pages belonging to that patient.
 */
export async function splitToIndividualPdfs(
  filePath: string,
  outputDir: string
): Promise<SplitResult[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath}`);
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  logger.info("Splitting batch PDF into individual patient files", { filePath, outputDir });

  // Extract text to identify page groups
  const pagesText = await extractPagesText(filePath);
  const groups = groupPagesByPatient(pagesText);

  // Load the original PDF with pdf-lib
  const pdfBytes = fs.readFileSync(filePath);
  const srcDoc = await PDFDocument.load(pdfBytes);

  const results: SplitResult[] = [];

  for (const [account, { pages, text }] of groups) {
    try {
      // Parse to get patient name
      const parsed = parsePatientText(text, pages);
      const safeName = parsed.patientName.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
      const fileName = `${parsed.accountNumberBase}_${safeName}.pdf`;
      const outputPath = path.join(outputDir, fileName);

      // Create a new PDF with only this patient's pages
      const newDoc = await PDFDocument.create();
      const copiedPages = await newDoc.copyPages(srcDoc, pages);
      for (const page of copiedPages) {
        newDoc.addPage(page);
      }

      const newPdfBytes = await newDoc.save();
      fs.writeFileSync(outputPath, newPdfBytes);

      results.push({
        accountNumber: account,
        patientName: parsed.patientName,
        outputPath,
        pageCount: pages.length,
      });

      logger.info(`Created individual PDF: ${fileName}`, {
        accountNumber: account,
        pages: pages.length,
      });
    } catch (err: any) {
      logger.error(`Failed to split PDF for account ${account}`, { error: err.message });
    }
  }

  logger.info(`Split complete: ${results.length} individual PDFs created`);
  return results;
}
