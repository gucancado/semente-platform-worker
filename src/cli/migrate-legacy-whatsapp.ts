import { pool } from '../db.js';
import { config } from '../config.js';
import { migrateLegacy } from '../whatsapp/migrate-legacy.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const report = await migrateLegacy(pool, config.AGENT_TOKENS_JSON, { dryRun });
  console.log(JSON.stringify({ dryRun, ...report }, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
