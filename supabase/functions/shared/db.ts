// Deno Database Service for Supabase Edge Functions
// Uses npm:postgres client for connection pooling and RLS transaction handling.

import postgres from "npm:postgres";
import { logger } from "./logger.ts";

const connectionString = Deno.env.get("SUPABASE_DB_URL")
  || Deno.env.get("SUPABASE_DB_EXTERNAL_URL")
  || (() => {
  const dbUser = Deno.env.get("DB_USER");
  const dbPassword = Deno.env.get("DB_PASSWORD");
  const dbHost = Deno.env.get("DB_HOST");
  const dbPort = Deno.env.get("DB_PORT") || "5432";
  const dbName = Deno.env.get("DB_NAME");

  if (!dbUser || !dbPassword || !dbHost || !dbName) {
    logger.error("Database connection variables are missing in Deno environment.");
    throw new Error("Required database configuration variables are missing.");
  }
  return `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
})();

// Initialize postgres client pool
export const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 15,
  connect_timeout: 10,
  // Require SSL for Supabase hosting
  ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
    ? false
    : "require",
});

/**
 * Execute an admin query (bypassing RLS by running as connection user, e.g. postgres)
 */
export async function queryAdmin(queryStr: string, params: any[] = []) {
  const start = Date.now();
  try {
    // unsafe allows passing raw query strings with dynamic parameterized arrays
    const res = await sql.unsafe(queryStr, params);
    const duration = Date.now() - start;
    logger.debug("Executed admin database query", { duration, rows: res.length });
    return { rows: res, rowCount: res.length };
  } catch (error: any) {
    logger.error("Admin database query failed", { queryStr, error: error.message });
    throw error;
  }
}

interface RLSContext {
  tokenId?: string;
  verifiedTokenId?: string;
}

/**
 * Execute query commands inside a transaction with RLS roles enabled.
 */
export async function runInRLSTransaction<T>(
  context: RLSContext,
  callback: (sqlTx: any) => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await sql.begin(async (sqlTx) => {
      // 1. Switch to the restricted API role
      await sqlTx`SET ROLE revflow_api`;

      // 2. Set transaction-local session settings
      if (context.tokenId) {
        await sqlTx`SELECT set_config('app.current_token_id', ${context.tokenId}, true)`;
      }
      if (context.verifiedTokenId) {
        await sqlTx`SELECT set_config('app.current_verified_token_id', ${context.verifiedTokenId}, true)`;
      }

      // 3. Execute queries inside callback
      const callbackResult = await callback(sqlTx);

      // 4. Reset role before transaction commits
      await sqlTx`RESET ROLE`;

      return callbackResult;
    });

    const duration = Date.now() - start;
    logger.debug("Successfully executed RLS transaction", { duration });
    return result;
  } catch (error: any) {
    logger.error("RLS transaction aborted, rolled back", { error: error.message });
    throw error;
  }
}
