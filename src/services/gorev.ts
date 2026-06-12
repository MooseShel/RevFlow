import { logger } from "./logger";
import {
  parseBatchPdf,
  splitToIndividualPdfs,
  detectPdfType,
  ParsedPatientStatement,
} from "./pdfParser";
import path from "path";

export interface GoRevStatement {
  patientId: string;
  patientName: string;
  email: string;
  phone: string;
  zipCode: string;
  totalDue: number;
  statementPdfUrl: string;
  metadata: {
    facilityName: string;
    statementDate: string;
    accountNumber: string;
    [key: string]: any;
  };
}

export interface IGoRevConnector {
  fetchRecentBillingStatements(): Promise<GoRevStatement[]>;
}

// ──────────────────────────────────────────────
// GoRev PDF Connector (Production)
// ──────────────────────────────────────────────

/**
 * Processes actual GoRev batch PDF files.
 * Auto-detects single vs multi-patient PDFs and handles both.
 *
 * - Multi-patient: splits into individual PDFs, parses each
 * - Single-patient: parses directly without splitting
 *
 * Demographics (email, phone, zip, ssnLast4) are left as placeholders
 * until a CSV demographics file is ingested and matched by account number.
 */
export class GoRevPdfConnector implements IGoRevConnector {
  private filePath: string;
  private outputDir: string;

  constructor(filePath: string, outputDir?: string) {
    this.filePath = filePath;
    this.outputDir = outputDir || path.join(path.dirname(filePath), "split_statements");
  }

  async fetchRecentBillingStatements(): Promise<GoRevStatement[]> {
    logger.info("GoRevPdfConnector: Analyzing PDF file...", { filePath: this.filePath });

    // 1. Detect PDF type
    const detection = await detectPdfType(this.filePath);
    logger.info(`PDF type detected: ${detection.type}`, { patientCount: detection.patientCount });

    // 2. Parse all patient statements from the PDF
    const parsed = await parseBatchPdf(this.filePath);

    // 3. Split into individual PDFs if multi-patient
    let splitResults: Map<string, string> = new Map();
    if (detection.type === "multi") {
      const splits = await splitToIndividualPdfs(this.filePath, this.outputDir);
      for (const s of splits) {
        splitResults.set(s.accountNumber, s.outputPath);
      }
    } else {
      // Single patient — use the original file path
      if (parsed.length > 0) {
        splitResults.set(parsed[0].accountNumber, this.filePath);
      }
    }

    // 4. Map parsed statements → GoRevStatement format
    const statements: GoRevStatement[] = parsed.map((p) => this.mapToGoRevStatement(p, splitResults));

    logger.info("GoRevPdfConnector: Processing complete", {
      totalStatements: statements.length,
      pdfType: detection.type,
    });

    return statements;
  }

  /**
   * Maps a parsed patient statement to the GoRevStatement interface.
   * Demographics fields are set to placeholders — they'll be populated
   * when the CSV demographics file is imported and matched by account number.
   */
  private mapToGoRevStatement(
    parsed: ParsedPatientStatement,
    splitPaths: Map<string, string>
  ): GoRevStatement {
    const pdfPath = splitPaths.get(parsed.accountNumber) || "";

    return {
      patientId: `PAT-${parsed.accountNumberBase}`,
      patientName: parsed.patientName,
      // Demographics — placeholder until CSV ingestion
      email: "",
      phone: "",
      zipCode: this.extractZipFromAddress(parsed.cityStateZip),
      totalDue: parsed.balance,
      statementPdfUrl: pdfPath, // Local path; will be replaced with Supabase URL after upload
      metadata: {
        facilityName: parsed.facilityName,
        statementDate: parsed.visitDate,
        accountNumber: parsed.accountNumber,
        accountNumberBase: parsed.accountNumberBase,
        visitId: parsed.visitId,
        physician: parsed.physician,
        physicianNpi: parsed.physicianNpi,
        primaryDiagnosis: parsed.primaryDiagnosis,
        address: parsed.address,
        cityStateZip: parsed.cityStateZip,
        totalCharges: parsed.charges.reduce((sum, c) => sum + c.amount, 0),
        totalPayments: parsed.payments,
        totalAdjustments: parsed.adjustments,
        chargeCount: parsed.charges.length,
        charges: parsed.charges,
        payerPayments: parsed.payerPayments,
        sourcePages: parsed.sourcePages.map((p) => p + 1), // 1-indexed for display
        pdfType: "gorev_batch_split",
        demographicsLinked: false, // Will flip to true when CSV is matched
      },
    };
  }

  /**
   * Attempts to extract a ZIP code from the cityStateZip string.
   * e.g. "BAYTOWN, TX 77521" → "77521"
   */
  private extractZipFromAddress(cityStateZip: string): string {
    const match = cityStateZip.match(/(\d{5}(-\d{4})?)$/);
    return match ? match[1] : "";
  }
}

// ──────────────────────────────────────────────
// GoRev Mock Connector (Development/Testing)
// ──────────────────────────────────────────────

export class GoRevMockConnector implements IGoRevConnector {
  /**
   * Emulates pulling patient statements from GoRev's custom integration stream.
   * Returns a structured mock array.
   */
  async fetchRecentBillingStatements(): Promise<GoRevStatement[]> {
    logger.info("Initializing connection to GoRev integration stream...");
    
    // Simulate API network latency (e.g., 300ms)
    await new Promise((resolve) => setTimeout(resolve, 300));

    logger.info("Connection established. Reading incoming billing statements batch...");

    const mockBatch: GoRevStatement[] = [
      {
        patientId: "PAT-2026-9812",
        patientName: "Alexander Hamilton",
        email: "alexander.hamilton@example.com",
        phone: "+15550100021",
        zipCode: "10005",
        totalDue: 145.20,
        statementPdfUrl: "https://example.com/secure/statements/PAT-2026-9812.pdf",
        metadata: {
          facilityName: "Manhattan Medical Center",
          statementDate: "2026-06-01",
          accountNumber: "ACT-88771"
        }
      },
      {
        patientId: "PAT-2026-0442",
        patientName: "Elizabeth Schuyler",
        email: "elizabeth.schuyler@example.com",
        phone: "+15550100032",
        zipCode: "12207",
        totalDue: 450.00,
        statementPdfUrl: "https://example.com/secure/statements/PAT-2026-0442.pdf",
        metadata: {
          facilityName: "Albany Family Practice",
          statementDate: "2026-06-05",
          accountNumber: "ACT-32219"
        }
      },
      {
        patientId: "PAT-2026-7718",
        patientName: "Aaron Burr",
        email: "aaron.burr@example.com",
        phone: "+15550100043",
        zipCode: "07030",
        totalDue: 12.50,
        statementPdfUrl: "https://example.com/secure/statements/PAT-2026-7718.pdf",
        metadata: {
          facilityName: "Weehawken Health Pavilion",
          statementDate: "2026-06-10",
          accountNumber: "ACT-99081"
        }
      }
    ];

    logger.info("Successfully fetched GoRev billing batch", { recordCount: mockBatch.length });
    return mockBatch;
  }
}
