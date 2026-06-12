import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import fs from "fs";
import { runInRLSTransaction, queryAdmin } from "./services/db";
import { runBatchIngestion, hashKey } from "./cron/batchBilling";
import { logger } from "./services/logger";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "revflow-admin-super-secret-key";

// Middlewares
// Customize Helmet config to allow script execution in public gate if needed (e.g. inline scripts)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(cors());
app.use(express.json());

// Resolve public folder path
const publicPath = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.join(__dirname, "../src/public");

app.use(express.static(publicPath));

/**
 * Endpoint: POST /api/admin/trigger-batch
 * Protected administrative route to manually run GoRev batch billing ingestion.
 */
app.post("/api/admin/trigger-batch", async (req: Request, res: Response) => {
  const authHeader = req.headers["authorization"];
  const xAdminKey = req.headers["x-admin-key"];
  
  let isAuthorized = false;
  if (xAdminKey === ADMIN_API_KEY) {
    isAuthorized = true;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token === ADMIN_API_KEY) {
      isAuthorized = true;
    }
  }

  if (!isAuthorized) {
    logger.warn("Unauthorized batch trigger attempt", { ip: req.ip });
    return res.status(401).json({ error: "Unauthorized administrative access" });
  }

  logger.info("Administrative batch trigger request received");
  try {
    const result = await runBatchIngestion(false);
    return res.json({
      success: true,
      message: "Batch statement ingestion completed successfully.",
      details: result,
    });
  } catch (error: any) {
    logger.error("Administrative batch execution failed", { error: error.message });
    return res.status(500).json({ error: "Failed to process batch billing statements" });
  }
});

/**
 * Endpoint: POST /api/verify
 * Patient Identity Verification Gate.
 * Enforces RLS and logs access attempts.
 */
app.post("/api/verify", async (req: Request, res: Response) => {
  const { token, verificationKey } = req.body;
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  // Validate inputs
  if (!token || typeof token !== "string" || !verificationKey || typeof verificationKey !== "string") {
    logger.warn("Invalid input parameters provided for verification", { ip: ipAddress });
    return res.status(400).json({ error: "Token and verification key are required." });
  }

  // Basic UUID validation
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(token)) {
    logger.warn("Invalid token UUID format submitted", { token, ip: ipAddress });
    return res.status(400).json({ error: "Invalid statement link token." });
  }

  const hashedInput = hashKey(verificationKey);

  try {
    const verificationResult = await runInRLSTransaction({ tokenId: token }, async (client) => {
      // 1. Retrieve the token record (bound by RLS policy: select_verification_tokens_policy)
      const tokenRes = await client.query(
        `SELECT token_id, statement_id, hashed_zip, expires_at, consumed_at 
         FROM verification_tokens 
         WHERE token_id = $1`,
        [token]
      );

      const tokenRecord = tokenRes.rows[0];

      // 2. If token doesn't exist or is expired, log failed attempt (requires admin query since RLS forbids select of nonexistent token)
      if (!tokenRecord) {
        logger.warn("Verification attempted with non-existent token", { token, ip: ipAddress });
        await queryAdmin(
          `INSERT INTO access_audit_logs (event_type, ip_address, user_agent, metadata)
           VALUES ('ATTEMPT_FAIL', $1, $2, $3)`,
          [ipAddress, userAgent, JSON.stringify({ attempted_token: token, reason: "Token not found" })]
        );
        return { verified: false, status: 401, error: "Invalid or expired statement link." };
      }

      const isExpired = new Date(tokenRecord.expires_at).getTime() < Date.now();
      if (isExpired) {
        logger.warn("Verification attempted with expired token", { token, ip: ipAddress });
        await queryAdmin(
          `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent, metadata)
           VALUES ($1, 'ATTEMPT_FAIL', $2, $3, $4)`,
          [tokenRecord.token_id, ipAddress, userAgent, JSON.stringify({ reason: "Token expired" })]
        );
        return { verified: false, status: 401, error: "This statement link has expired (72-hour limit)." };
      }

      // 3. Compare hashes
      const zipMatch = hashedInput === tokenRecord.hashed_zip;

      if (!zipMatch) {
        logger.warn("Identity verification failed (incorrect key)", { token, ip: ipAddress });
        
        // Log the failure
        await client.query(
          `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent, metadata)
           VALUES ($1, 'ATTEMPT_FAIL', $2, $3, $4)`,
          [tokenRecord.token_id, ipAddress, userAgent, JSON.stringify({ reason: "Incorrect ZIP" })]
        );
        
        return { verified: false, status: 401, error: "Identity verification failed. Please enter the correct details." };
      }

      // 4. Verification Succeeded!
      // Update consumed_at timestamp
      await client.query(
        `UPDATE verification_tokens 
         SET consumed_at = now() 
         WHERE token_id = $1`,
        [tokenRecord.token_id]
      );

      // Log VERIFIED and VIEWED events
      await client.query(
        `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
         VALUES ($1, 'VERIFIED', $2, $3)`,
        [tokenRecord.token_id, ipAddress, userAgent]
      );

      await client.query(
        `INSERT INTO access_audit_logs (token_id, event_type, ip_address, user_agent)
         VALUES ($1, 'VIEWED', $2, $3)`,
        [tokenRecord.token_id, ipAddress, userAgent]
      );

      // 5. Query billing statement details (enforced by RLS)
      // Must set app.current_verified_token_id config parameter so policy allows SELECT
      await client.query("SELECT set_config('app.current_verified_token_id', $1, true)", [token]);

      const statementRes = await client.query(
        `SELECT statement_id, total_due, statement_pdf_url, metadata 
         FROM billing_statements 
         WHERE statement_id = $1`,
        [tokenRecord.statement_id]
      );

      const statement = statementRes.rows[0];

      if (!statement) {
        logger.error("Verified statement not found in database", { statementId: tokenRecord.statement_id });
        return { verified: false, status: 404, error: "Statement record could not be found." };
      }

      logger.info("Patient successfully verified identity", { token });
      return { verified: true, statement };
    });

    if (verificationResult.verified) {
      return res.json({ success: true, statement: verificationResult.statement });
    } else {
      return res.status(verificationResult.status || 401).json({ error: verificationResult.error });
    }
  } catch (error: any) {
    logger.error("Internal error occurred during verification gate execution", { error: error.message });
    return res.status(500).json({ error: "An unexpected error occurred. Please try again later." });
  }
});

// Start Express Server
app.listen(PORT, () => {
  logger.info(`Server active and listening on port ${PORT}`);
  logger.info(`Static assets served from directory: ${publicPath}`);
});
