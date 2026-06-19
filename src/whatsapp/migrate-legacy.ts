import type { Pool } from 'pg';
import { upsertWorkspaceAgent } from './workspace-agents.js';

export type MigrateReport = { numbersCreated: number; agentsUpserted: number; messagesBackfilled: number; webhookLogsBackfilled: number; orphans: string[] };

type AgentTokenCfg = { worker_token: string; fallback_workspace_id?: string; mode?: 'reactive'|'sweep' };

export async function migrateLegacy(pool: Pool, agentTokens: Record<string, AgentTokenCfg>, opts: { dryRun: boolean }): Promise<MigrateReport> {
  const report: MigrateReport = { numbersCreated: 0, agentsUpserted: 0, messagesBackfilled: 0, webhookLogsBackfilled: 0, orphans: [] };
  // instâncias distintas observadas: (agent, project) de messages + instance de webhook_logs
  const { rows: pairs } = await pool.query(
    `SELECT DISTINCT agent, project FROM messages WHERE agent IS NOT NULL AND channel='whatsapp'`);

  for (const { agent, project } of pairs) {
    const instance = project ? `${agent}-${project}` : agent;
    const cfg = agentTokens[agent];
    // resolução de workspace: contact_route (qualquer) → fallback do agente
    const { rows: cr } = await pool.query(
      `SELECT workspace_id FROM contact_routes WHERE agent=$1 LIMIT 1`, [agent]);
    const workspaceId = cr[0]?.workspace_id ?? cfg?.fallback_workspace_id ?? null;
    if (!workspaceId) { report.orphans.push(instance); continue; }

    report.numbersCreated++;
    report.agentsUpserted++;
    if (opts.dryRun) continue;

    const { rows: nrows } = await pool.query(
      `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, mode, status, label)
       VALUES ($1,$2,'agent_operated','connected',$3)
       ON CONFLICT (evolution_instance) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
       RETURNING id`, [workspaceId, instance, agent]);
    const numberId = Number(nrows[0].id);

    await upsertWorkspaceAgent(pool, { workspaceId, agent,
      config: { reaction_mode: cfg?.mode ?? 'reactive', fallback_workspace_id: cfg?.fallback_workspace_id,
        operates_numbers: [numberId], observes_numbers: [numberId] } });

    // backfill messages por reconstrução de instância (P0.2)
    const m = await pool.query(
      `UPDATE messages SET whatsapp_number_id = $1, workspace_id = $2
        WHERE whatsapp_number_id IS NULL AND agent = $3
          AND COALESCE(project,'') = COALESCE($4,'')`,
      [numberId, workspaceId, agent, project]);
    report.messagesBackfilled += m.rowCount ?? 0;
    // backfill webhook_logs por instance direto
    const w = await pool.query(
      `UPDATE webhook_logs SET whatsapp_number_id = $1, workspace_id = COALESCE(workspace_id, $2)
        WHERE whatsapp_number_id IS NULL AND instance = $3`,
      [numberId, workspaceId, instance]);
    report.webhookLogsBackfilled += w.rowCount ?? 0;
    // grupos da instância (agent+project) — sweep
    await pool.query(
      `UPDATE whatsapp_groups SET whatsapp_number_id = $1, workspace_id = COALESCE(workspace_id, $2)
        WHERE whatsapp_number_id IS NULL AND agent = $3
          AND COALESCE(project,'') = COALESCE($4,'')`, [numberId, workspaceId, agent, project]);
  }
  return report;
}
