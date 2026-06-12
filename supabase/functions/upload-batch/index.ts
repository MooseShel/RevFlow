// Deno Edge Function: /upload-batch
// Admin portal backend — handles authentication, PDF upload + Gemini extraction, and batch confirmation.
// Supports three actions: auth, upload, confirm.

import { createClient } from "npm:@supabase/supabase-js";
import { extractPatientData, ExtractedRecord } from "../shared/extract.ts";
import { processStatementRecord, StatementRecord } from "../shared/ingest.ts";
import { logger } from "../shared/logger.ts";

const ADMIN_API_KEY = Deno.env.get("ADMIN_API_KEY") || "";
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Validates admin authentication from the Authorization header.
 */
function validateAuth(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  return authHeader.split(" ")[1] === ADMIN_API_KEY;
}

/**
 * Determines the action from the URL pathname.
 * /upload-batch          → auth or upload (based on content-type)
 * /upload-batch/auth     → auth
 * /upload-batch/upload   → upload
 * /upload-batch/confirm  → confirm
 */
function getAction(req: Request): string {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];

  if (lastSegment === "auth") return "auth";
  if (lastSegment === "upload") return "upload";
  if (lastSegment === "confirm") return "confirm";

  // Default: check content type
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) return "upload";
  return "auth";
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const action = getAction(req);

  // ─── AUTH ACTION ───────────────────────────────────────────────
  if (action === "auth") {
    const isValid = validateAuth(req);
    if (isValid) {
      logger.info("Admin portal authentication successful");
      return new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      logger.warn("Admin portal authentication failed");
      return new Response(JSON.stringify({ error: "Invalid admin credentials" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // All other actions require auth
  if (!validateAuth(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ─── UPLOAD ACTION ─────────────────────────────────────────────
  if (action === "upload") {
    try {
      const formData = await req.formData();
      const files: File[] = [];

      for (const [_key, value] of formData.entries()) {
        if (value instanceof File && value.type === "application/pdf") {
          files.push(value);
        }
      }

      if (files.length === 0) {
        return new Response(JSON.stringify({ error: "No PDF files found in upload" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (files.length > 50) {
        return new Response(JSON.stringify({ error: "Maximum 50 files per batch" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      logger.info(`Processing upload batch of ${files.length} PDF files`);

      const results: Array<{ filename: string; extracted?: ExtractedRecord; error?: string }> = [];

      for (const file of files) {
        try {
          // Generate a unique filename to prevent collisions
          const timestamp = Date.now();
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const uniqueFilename = `${timestamp}_${safeName}`;

          // Read file bytes
          const arrayBuffer = await file.arrayBuffer();
          const pdfBytes = new Uint8Array(arrayBuffer);

          // Validate file size (max 10MB)
          if (pdfBytes.length > 10 * 1024 * 1024) {
            results.push({ filename: file.name, error: `File exceeds 10MB limit (${(pdfBytes.length / 1024 / 1024).toFixed(1)}MB)` });
            continue;
          }

          // Upload to Supabase Storage
          const { error: uploadError } = await supabase.storage
            .from("billing-uploads")
            .upload(uniqueFilename, pdfBytes, {
              contentType: "application/pdf",
              upsert: false,
            });

          if (uploadError) {
            logger.error("Failed to upload PDF to storage", { filename: file.name, error: uploadError.message });
            results.push({ filename: file.name, error: `Storage upload failed: ${uploadError.message}` });
            continue;
          }

          // Extract patient data via Gemini AI
          const extracted = await extractPatientData(pdfBytes, uniqueFilename);
          results.push({ filename: file.name, extracted });

        } catch (fileErr: any) {
          logger.error("Failed to process uploaded PDF file", { filename: file.name, error: fileErr.message });
          results.push({ filename: file.name, error: fileErr.message });
        }
      }

      const successCount = results.filter((r) => r.extracted).length;
      const failCount = results.filter((r) => r.error).length;

      logger.info("Upload batch extraction completed", { total: files.length, succeeded: successCount, failed: failCount });

      return new Response(
        JSON.stringify({
          success: true,
          totalFiles: files.length,
          extracted: successCount,
          failed: failCount,
          records: results,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } catch (error: any) {
      logger.error("Fatal error in upload action", { error: error.message });
      return new Response(JSON.stringify({ error: "Upload processing failed: " + error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // ─── CONFIRM ACTION ────────────────────────────────────────────
  if (action === "confirm") {
    try {
      const body = await req.json();
      const records: StatementRecord[] = body.records;

      if (!records || !Array.isArray(records) || records.length === 0) {
        return new Response(JSON.stringify({ error: "No records provided for confirmation" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      logger.info(`Processing confirmation batch of ${records.length} records`);

      // Create batch_uploads record for reporting
      const { queryAdmin: qa } = await import("../shared/db.ts");
      const batchRes = await qa(
        `INSERT INTO batch_uploads (file_count, extracted_count, status)
         VALUES ($1, $2, 'processing')
         RETURNING batch_id`,
        [records.length, records.length]
      );
      const batchId = batchRes.rows[0].batch_id;
      logger.info("Created batch record", { batchId });

      const results: Array<{ patientName: string; success: boolean; tokenId?: string; emailSent: boolean; smsSent: boolean; error?: string }> = [];

      for (const record of records) {
        // Attach batchId to each record
        record.batchId = batchId;
        const result = await processStatementRecord(record, supabase);
        results.push({
          patientName: record.patientName,
          success: result.success,
          tokenId: result.tokenId,
          emailSent: result.emailSent,
          smsSent: result.smsSent,
          error: result.error,
        });
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;
      const emailsSent = results.filter((r) => r.emailSent).length;
      const smsSent = results.filter((r) => r.smsSent).length;

      // Update batch record with final stats
      await qa(
        `UPDATE batch_uploads 
         SET confirmed_count = $1, emails_sent = $2, sms_sent = $3, status = 'completed'
         WHERE batch_id = $4`,
        [successCount, emailsSent, smsSent, batchId]
      );

      logger.info("Confirmation batch completed", { batchId, total: records.length, succeeded: successCount, failed: failCount });

      return new Response(
        JSON.stringify({
          success: true,
          batchId,
          totalProcessed: records.length,
          succeeded: successCount,
          failed: failCount,
          results,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } catch (error: any) {
      logger.error("Fatal error in confirm action", { error: error.message });
      return new Response(JSON.stringify({ error: "Confirmation processing failed: " + error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Unknown action fallback
  return new Response(JSON.stringify({ error: "Unknown action" }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
