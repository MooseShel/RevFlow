// Gemini AI PDF Extraction Helper
// Sends PDF bytes to Gemini 2.0 Flash and returns structured patient billing data.
// No PHI is logged — only extraction status and filename.

import { logger } from "./logger.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GEMENI_API_KEY") || "";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

export interface ExtractedRecord {
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

const EXTRACTION_PROMPT = `You are a medical billing data extraction assistant. Analyze the provided PDF billing statement and extract the following patient and billing information.

Return ONLY a valid JSON object with these exact fields — no markdown, no explanation, no code fences:

{
  "patientName": "Full patient name",
  "email": "Patient email address, or empty string if not found",
  "phone": "Patient phone number in E.164 format (e.g. +15551234567), or empty string if not found",
  "zipCode": "Patient ZIP code (5 digits), or empty string if not found",
  "ssnLast4": "Last 4 digits of patient SSN, or empty string if not found",
  "totalDue": 0.00,
  "facilityName": "Name of the medical facility / provider",
  "statementDate": "Statement date in YYYY-MM-DD format, or empty string if not found"
}

Rules:
- totalDue must be a number (not a string), representing the total amount due / balance due
- If a field is not present in the document, return an empty string (or 0.00 for totalDue)
- Do NOT invent or hallucinate data — only extract what is explicitly stated in the document
- Phone numbers should include country code if available, otherwise assume +1 (US)
- Return ONLY the JSON object, nothing else`;

/**
 * Robustly extracts a JSON object from Gemini response text.
 * Handles: markdown fences, thinking blocks, control characters, and mixed content.
 */
function extractJsonFromText(text: string): Record<string, any> | null {
  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  // 2. Remove control characters that break JSON.parse (tabs, newlines inside strings)
  cleaned = cleaned.replace(/[\x00-\x1f]/g, (ch) => {
    if (ch === "\n" || ch === "\r" || ch === "\t") return " ";
    return "";
  });

  // 3. Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch { /* continue */ }

  // 4. Try to find a JSON object anywhere in the text using brace matching
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) return null;

  // Find the matching closing brace by counting depth
  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) { lastBrace = i; break; }
    }
  }

  if (lastBrace === -1) return null;

  const jsonCandidate = cleaned.substring(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(jsonCandidate);
  } catch { /* continue */ }

  // 5. Last resort: fix common issues (trailing commas, single quotes)
  const fixed = jsonCandidate
    .replace(/,\s*}/g, "}")   // trailing commas
    .replace(/,\s*]/g, "]")   // trailing commas in arrays
    .replace(/'/g, '"');       // single quotes to double quotes

  try {
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

/**
 * Extracts structured patient billing data from a PDF using Gemini AI.
 * @param pdfBytes - Raw PDF file bytes
 * @param filename - Original filename (for logging/tracking only)
 * @returns Extracted patient record
 */
export async function extractPatientData(
  pdfBytes: Uint8Array,
  filename: string
): Promise<ExtractedRecord> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured. Cannot extract PDF data.");
  }

  logger.info("Starting Gemini AI extraction for PDF", { filename });

  // Convert PDF bytes to base64
  const base64Pdf = btoa(
    Array.from(pdfBytes)
      .map((b) => String.fromCharCode(b))
      .join("")
  );

  const requestBody = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  };

  // Retry logic for rate limits (429)
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (response.status === 429) {
        const waitMs = attempt * 2000; // 2s, 4s, 6s
        logger.warn(`Gemini rate limit hit (attempt ${attempt}/${maxRetries}), retrying in ${waitMs}ms`, { filename });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();

      // Extract text content from Gemini response
      const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textContent) {
        throw new Error("Gemini returned empty or malformed response — no text content found");
      }

      // Parse JSON from response — robust extraction handles markdown fences,
      // thinking blocks, and other non-JSON wrapping Gemini may add
      const extracted = extractJsonFromText(textContent);
      if (!extracted) {
        logger.error("Could not extract valid JSON from Gemini response", { filename, rawLength: textContent.length, preview: textContent.substring(0, 300) });
        throw new Error("Gemini response did not contain valid JSON");
      }

      const parsed = extracted;

      // Validate and normalize the extracted record
      const record: ExtractedRecord = {
        patientName: String(parsed.patientName || "").trim(),
        email: String(parsed.email || "").trim(),
        phone: String(parsed.phone || "").trim(),
        zipCode: String(parsed.zipCode || "").trim(),
        ssnLast4: String(parsed.ssnLast4 || "").trim(),
        totalDue: typeof parsed.totalDue === "number" ? parsed.totalDue : parseFloat(parsed.totalDue) || 0,
        facilityName: String(parsed.facilityName || "").trim(),
        statementDate: String(parsed.statementDate || "").trim(),
        pdfFilename: filename,
      };

      logger.info("Successfully extracted patient data from PDF via Gemini", { filename });
      return record;

    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries && error.message?.includes("429")) {
        const waitMs = attempt * 2000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }

  logger.error("Failed to extract patient data from PDF", { filename, error: lastError?.message });
  throw lastError || new Error("Unknown extraction failure");
}
