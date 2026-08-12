import { pool } from '../db.js';
import { config } from '../config.js';
import { syncAgentGroupParticipants } from '../whatsapp/agent-group-sync.js';

/**
 * Roda `syncAgentGroupParticipants` pra todos os agents que têm PELO MENOS UM
 * grupo vinculado escopo 'agent' (linhas legadas de `whatsapp_groups`,
 * `whatsapp_number_id IS NULL` — hoje só `agent='saturno'`). É o que roda
 * manualmente logo após o deploy, pra popular o roster (LID+telefone+nome)
 * dos grupos vinculados que hoje não têm participante nenhum — o cron diário
 * (`group-sync-cron.ts`) cobre o resto a partir daí.
 *
 * MESMO padrão de `migrate-legacy-whatsapp.ts`: sem flags, imprime o
 * resultado em JSON e fecha o pool.
 */
async function main() {
  const evolution = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
  const { rows } = await pool.query(
    `SELECT DISTINCT agent
       FROM whatsapp_groups
      WHERE linked_workspace_id IS NOT NULL AND whatsapp_number_id IS NULL AND agent IS NOT NULL`,
  );
  const results: Record<string, unknown> = {};
  for (const r of rows) {
    const agent = r.agent as string;
    try {
      results[agent] = await syncAgentGroupParticipants(pool, evolution, agent);
    } catch (err) {
      results[agent] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  console.log(JSON.stringify({ agents: rows.length, results }, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
