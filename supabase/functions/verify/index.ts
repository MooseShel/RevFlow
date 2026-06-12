// Deno Edge Function: /verify
// brokers unauthenticated patient identity verification and fetches billing statements inside RLS context.

import { createClient } from "npm:@supabase/supabase-js";
import { runInRLSTransaction, queryAdmin } from "../shared/db.ts";
import { logger } from "../shared/logger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Initialize Supabase Client for storage operations
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

Deno.serve(async (req: Request) => {
  // Handle CORS preflight options
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { token, verificationKey } = await req.json();
    const ipAddress = req.headers.get("x-forwarded-for") || "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";

    // Validate required fields
    if (!token || typeof token !== "string" || !verificationKey || typeof verificationKey !== "string") {
      logger.warn("Verification request rejected: missing inputs", { ip: ipAddress });
      return new Response(JSON.stringify({ error: "Token and verification key are required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Basic UUID validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(token)) {
      logger.warn("Verification request rejected: invalid UUID token format", { token, ip: ipAddress });
      return new Response(JSON.stringify({ error: "Invalid statement link token." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Hash the input key using Deno's native SubtleCrypto SHA-256
    const encoder = new TextEncoder();
    const rawData = encoder.encode(verificationKey.trim());
    const hashBuffer = await crypto.subtle.digest("SHA-256", rawData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashedInput = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    const result = await runInRLSTransaction({ tokenId: token }, async (sqlTx) => {
      // 1. Fetch active verification token matching ID (bounded by RLS)
      const tokenRes = await sqlTx`
        SELECT token_id, statement_id, hashed_ssn_last4, hashed_phone, expires_at, consumed_at 
        FROM verification_tokens 
        WHERE token_id = ${token}
      `;
      const tokenRecord = tokenRes[0];

      // 2. Handle missing token (requires admin bypass logger to log ATTEMPT_FAIL for non-existent token)
      if (!tokenRecord) {
        logger.warn("Verification failed: token ID not found", { token, ip: ipAddress });
        await queryAdmin(
          `INSERT INTO access_audit_logs (event_type, ip_address, user_agent, metadata)
           VALUES ('ATTEMPT_FAIL', $1, $2, $3)`,
          [ipAddress, userAgent, JSON.stringify({ attempted_token: token, reason: "Token not found" })]
        );
        return { verified: false, status: 401, error: "Invalid or expired statement link." };
      }

      // 3. Handle expired tokens
      const isExpired = new Date(tokenRecord.expires_at).getTime() < Date.now();
      if (isExpired) {
        logger.warn("Verification failed: token expired", { token, ip: ipAddress });
        await queryAdmin(
          `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent, metadata)
           VALUES ($1, 'ATTEMPT_FAIL', $2, $3, $4)`,
          [tokenRecord.token_id, ipAddress, userAgent, JSON.stringify({ reason: "Token expired" })]
        );
        return { verified: false, status: 401, error: "This statement link has expired." };
      }

      // 4. Verify match against SSN last 4 or phone last 4
      const ssnMatch = tokenRecord.hashed_ssn_last4 && hashedInput === tokenRecord.hashed_ssn_last4;
      const phoneMatch = tokenRecord.hashed_phone && hashedInput === tokenRecord.hashed_phone;

      if (!ssnMatch && !phoneMatch) {
        logger.warn("Verification failed: incorrect details", { token, ip: ipAddress });
        await sqlTx`
          INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent, metadata)
          VALUES (${tokenRecord.token_id}, 'ATTEMPT_FAIL', ${ipAddress}, ${userAgent}, ${JSON.stringify({ reason: "Incorrect SSN last 4 or phone last 4" })})
        `;
        return { verified: false, status: 401, error: "Identity verification failed. Please try again." };
      }

      // 5. Successful Verification!
      // Update consumed_at timestamp
      await sqlTx`
        UPDATE verification_tokens 
        SET consumed_at = now() 
        WHERE token_id = ${tokenRecord.token_id}
      `;

      // Register success events in audit log
      await sqlTx`
        INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
        VALUES (${tokenRecord.token_id}, 'VERIFIED', ${ipAddress}, ${userAgent})
      `;

      await sqlTx`
        INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
        VALUES (${tokenRecord.token_id}, 'VIEWED', ${ipAddress}, ${userAgent})
      `;

      // Set transaction-local verified parameter so RLS selects statement details
      await sqlTx`SELECT set_config('app.current_verified_token_id', ${token}, true)`;

      const statementRes = await sqlTx`
        SELECT statement_id, total_due, statement_pdf_url, metadata 
        FROM billing_statements 
        WHERE statement_id = ${tokenRecord.statement_id}
      `;
      const statement = statementRes[0];

      if (!statement) {
        logger.error("Verified statement not found in database", { statementId: tokenRecord.statement_id });
        return { verified: false, status: 404, error: "Statement record could not be found." };
      }

      // 6. Generate secure signed URL for the archived statement PDF file (valid for 1 hour)
      const { data: signedData, error: signedError } = await supabase.storage
        .from("billing-uploads")
        .createSignedUrl(`archive/${statement.statement_pdf_url}`, 3600);

      if (signedError || !signedData?.signedUrl) {
        logger.error("Failed to generate secure signed URL for statement PDF", { 
          pdfPath: `archive/${statement.statement_pdf_url}`, 
          error: signedError?.message 
        });
        return { verified: false, status: 500, error: "Failed to generate secure access link for statement PDF." };
      }

      // Overwrite raw filename with secure temporary signed URL
      statement.statement_pdf_url = signedData.signedUrl;

      logger.info("Patient identity verified, returning statement details", { token });
      return { verified: true, statement };
    });

    if (result.verified) {
      return new Response(JSON.stringify({ success: true, statement: result.statement }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      return new Response(JSON.stringify({ error: result.error }), {
        status: result.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

  } catch (error: any) {
    logger.error("Internal handler error in verify function", { error: error.message });
    return new Response(JSON.stringify({ error: "An unexpected error occurred. Please try again later." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
