import { queryAdmin, closePool } from "../services/db";
import { logger } from "../services/logger";

async function run() {
  logger.info("Applying database role grants...");
  try {
    await queryAdmin("GRANT revflow_api TO postgres;");
    logger.info("Successfully granted revflow_api to postgres role");
    
    const res = await queryAdmin("SELECT current_user;");
    const currentUser = res.rows[0].current_user;
    logger.info(`Current database user is: ${currentUser}`);
    
    await queryAdmin(`GRANT revflow_api TO "${currentUser}";`);
    logger.info(`Successfully granted revflow_api to ${currentUser}`);
  } catch (error: any) {
    logger.error("Failed to apply role grants", { error: error.message });
  } finally {
    await closePool();
  }
}

run();
