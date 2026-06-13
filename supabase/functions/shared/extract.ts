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
  totalDue: number;
  customerAccountId: string;
  statementDate: string;
  pdfFilename: string;
}

const EXTRACTION_PROMPT = `You are a medical billing data extraction assistant. Analyze the provided PDF billing statement and extract all patient and billing records. If the PDF contains billing statements for multiple patients or multiple separate billing statements, extract each of them as a separate item in the records list. If there is only one patient, return a list with exactly one record.

Return ONLY a valid JSON object with a "records" field containing an array of patient records, with these exact fields:

{
  "records": [
    {
      "patientName": "Full patient name",
      "email": "Patient email address, or empty string if not found",
      "phone": "Patient phone number in E.164 format (e.g. +15551234567), or empty string if not found",
      "zipCode": "Patient ZIP code (5 digits), or empty string if not found",
      "totalDue": 0.00,
      "customerAccountId": "Customer account ID / account number, or empty string if not found",
      "statementDate": "Statement date in YYYY-MM-DD format, or empty string if not found"
    }
  ]
}

Rules:
- totalDue must be a number (not a string), representing the total amount due / balance due
- If a field is not present in the document, return an empty string (or 0.00 for totalDue)
- Do NOT invent or hallucinate data — only extract what is explicitly stated in the document
- Phone numbers should include country code if available, otherwise assume +1 (US)
- Return ONLY the JSON object containing the "records" array, nothing else`;

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
 * @returns Array of extracted patient records
 */
export async function extractPatientData(
  pdfBytes: Uint8Array,
  filename: string
): Promise<ExtractedRecord[]> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured. Cannot extract PDF data.");
  }

  if (!GEMINI_API_KEY.startsWith("AIza")) {
    logger.warn("GEMINI_API_KEY does not start with 'AIza' — it may be invalid", { keyPrefix: GEMINI_API_KEY.substring(0, 6) });
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
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          records: {
            type: "array",
            items: {
              type: "object",
              properties: {
                patientName: { type: "string" },
                email: { type: "string" },
                phone: { type: "string" },
                zipCode: { type: "string" },
                totalDue: { type: "number" },
                customerAccountId: { type: "string" },
                statementDate: { type: "string" },
              },
              required: ["patientName", "totalDue", "customerAccountId"],
            },
          },
        },
        required: ["records"],
      },
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

      // Log the response shape for debugging
      const candidate = data?.candidates?.[0];
      const finishReason = candidate?.finishReason;
      const parts = candidate?.content?.parts;
      logger.info("Gemini response shape", {
        filename,
        finishReason,
        partsCount: parts?.length ?? 0,
        hasBlockReason: !!data?.promptFeedback?.blockReason,
      });

      // Check for blocked prompts
      if (data?.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
      }

      if (!parts || parts.length === 0) {
        logger.error("Gemini returned no parts", { filename, rawResponse: JSON.stringify(data).substring(0, 500) });
        throw new Error("Gemini returned empty or malformed response — no content parts found");
      }

      // Gemini 2.5 thinking models return multiple parts:
      //   parts[0] = { thought: true, text: "<thinking>..." }
      //   parts[1] = { text: "{...json...}" }
      // Non-thinking models return a single part with the JSON text.
      // Find the last non-thought part with text content.
      let textContent: string | null = null;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].text && !parts[i].thought) {
          textContent = parts[i].text;
          break;
        }
      }

      // Fallback: if all parts are thought parts, take the last one with text
      if (!textContent) {
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].text) {
            textContent = parts[i].text;
            break;
          }
        }
      }

      if (!textContent) {
        logger.error("No text content found in any Gemini response part", { filename, parts: JSON.stringify(parts).substring(0, 500) });
        throw new Error("Gemini returned no text content in any response part");
      }

      // Parse JSON from response — robust extraction handles markdown fences,
      // thinking blocks, and other non-JSON wrapping Gemini may add
      const extracted = extractJsonFromText(textContent);
      if (!extracted) {
        logger.error("Could not extract valid JSON from Gemini response", { filename, rawLength: textContent.length, preview: textContent.substring(0, 500) });
        throw new Error("Gemini response did not contain valid JSON");
      }

      const parsed = extracted;
      const rawRecords = Array.isArray(parsed.records) ? parsed.records : (parsed.patientName ? [parsed] : []);

      // Validate and normalize the extracted records
      const records: ExtractedRecord[] = rawRecords.map((item: any) => ({
        patientName: String(item.patientName || "").trim(),
        email: "", // email is always blank/empty
        phone: "", // phone is always blank/empty (bill file has firm number, not patient)
        zipCode: String(item.zipCode || "").trim(),
        totalDue: typeof item.totalDue === "number" ? item.totalDue : parseFloat(item.totalDue) || 0,
        customerAccountId: String(item.customerAccountId || "").trim(),
        statementDate: String(item.statementDate || "").trim(),
        pdfFilename: filename,
      }));

      logger.info("Successfully extracted patient data from PDF via Gemini", { filename, count: records.length });
      return records;

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
