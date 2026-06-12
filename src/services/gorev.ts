import { logger } from "./logger";

export interface GoRevStatement {
  patientId: string;
  patientName: string;
  email: string;
  phone: string;
  zipCode: string;
  ssnLast4: string;
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
        ssnLast4: "1789",
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
        ssnLast4: "1854",
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
        ssnLast4: "1804",
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
