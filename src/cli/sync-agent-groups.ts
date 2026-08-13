import { pool } from '../db.js';
import { config } from '../config.js';
import { syncAgentGroupParticipants, syncNumberGroupParticipants } from '../whatsapp/agent-group-sync.js';
import { getNumber } from '../whatsapp/numbers.js';

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
  // Escopo 'number' (desde 2026-08-13): mesmo sync por-grupo, na instância do
  // número — o payload do fetchAllGroups não traz nome/LID (ver
  // agent-group-sync.ts).
  const { rows: numRows } = await pool.query(
    `SELECT DISTINCT whatsapp_number_id AS id
       FROM whatsapp_groups
      WHERE linked_workspace_id IS NOT NULL AND whatsapp_number_id IS NOT NULL`,
  );
  for (const r of numRows) {
    const numberId = Number(r.id);
    try {
      const num = await getNumber(pool, numberId);
      results[`number:${numberId}`] = num
        ? await syncNumberGroupParticipants(pool, evolution, num.evolutionInstance, numberId)
        : { error: 'numero nao encontrado' };
    } catch (err) {
      results[`number:${numberId}`] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  console.log(JSON.stringify({ agents: rows.length, numbers: numRows.length, results }, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
