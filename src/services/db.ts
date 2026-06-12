import { Pool, PoolClient } from "pg";
import { logger } from "./logger";
import dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  logger.error("DATABASE_URL environment variable is missing.");
  throw new Error("DATABASE_URL environment variable is missing.");
}

// Initialize connection pool
// For railway/external databases, SSL is usually required.
export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  logger.error("Unexpected error on idle database client", { error: err.message });
});

/**
 * Execute an admin-level query (runs as the database connection user, e.g. postgres, bypassing RLS)
 * Crucial for cron jobs, database seedings, or background ingestions.
 */
export async function queryAdmin(text: string, params?: any[]) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug("Executed admin database query", { duration, rows: res.rowCount });
    return res;
  } catch (error: any) {
    logger.error("Admin database query failed", { text, error: error.message });
    throw error;
  }
}

interface RLSContext {
  tokenId?: string;
  verifiedTokenId?: string;
}

/**
 * Run operations within a transaction bounded by Row-Level Security.
 * Sets role to 'revflow_api' and defines transaction-local settings app.current_token_id and app.current_verified_token_id.
 */
export async function runInRLSTransaction<T>(
  context: RLSContext,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const start = Date.now();
  try {
    await client.query("BEGIN");

    // Enforce role switch to the restricted API role
    await client.query("SET ROLE revflow_api");

    // Bind local variables for the scope of this transaction
    if (context.tokenId) {
      await client.query("SELECT set_config('app.current_token_id', $1, true)", [context.tokenId]);
    }
    if (context.verifiedTokenId) {
      await client.query("SELECT set_config('app.current_verified_token_id', $1, true)", [context.verifiedTokenId]);
    }

    // Run custom database actions
    const result = await callback(client);

    await client.query("COMMIT");
    const duration = Date.now() - start;
    logger.debug("Successfully executed RLS transaction", { duration });
    return result;
  } catch (error: any) {
    await client.query("ROLLBACK");
    logger.error("RLS transaction aborted, rolled back", { error: error.message });
    throw error;
  } finally {
    // Reset role back to the default connection user before returning to pool
    try {
      await client.query("RESET ROLE");
    } catch (resetErr: any) {
      logger.error("Failed to reset role on database client release", { error: resetErr.message });
    }
    client.release();
  }
}

/**
 * Utility to close the connection pool when process finishes.
 * Crucial for Railway short-lived cron jobs to prevent connection leaks.
 */
export async function closePool() {
  logger.info("Closing database connection pool...");
  await pool.end();
  logger.info("Database connection pool closed successfully.");
}
