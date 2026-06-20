import type { Pool } from 'pg';

export type AgentConfig = {
  reaction_mode?: 'reactive'|'sweep'; fallback_workspace_id?: string;
  operates_numbers?: number[]; observes_numbers?: number[];
  channels?: string[]; thresholds?: Record<string, unknown>; silence_window?: unknown;
};
export type WorkspaceAgent = { workspaceId: string; agent: string; enabled: boolean; config: AgentConfig; version: number };

function map(r: any): WorkspaceAgent {
  return { workspaceId: r.workspace_id, agent: r.agent, enabled: r.enabled, config: r.config ?? {}, version: Number(r.version) };
}

export async function upsertWorkspaceAgent(pool: Pool, p: { workspaceId: string; agent: string; enabled?: boolean; config: AgentConfig }) {
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent, enabled, config)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, agent) DO UPDATE
       SET config = EXCLUDED.config, enabled = EXCLUDED.enabled,
           version = workspace_agents.version + 1, updated_at = NOW()`,
    [p.workspaceId, p.agent, p.enabled ?? true, JSON.stringify(p.config)]);
}

export async function getAgentsForNumber(pool: Pool, p: { workspaceId: string; numberId: number; reactionMode?: 'reactive'|'sweep' }) {
  const { rows } = await pool.query(
    `SELECT workspace_id, agent, enabled, config, version FROM workspace_agents
      WHERE workspace_id = $1 AND enabled
        AND (config->'operates_numbers') @> to_jsonb($2::int)
        AND ($3::text IS NULL OR config->>'reaction_mode' = $3)`,
    [p.workspaceId, p.numberId, p.reactionMode ?? null]);
  return rows.map(map);
}

export async function getObservers(pool: Pool, workspaceId: string) {
  const { rows } = await pool.query(
    `SELECT workspace_id, agent, enabled, config, version FROM workspace_agents
      WHERE workspace_id = $1 AND enabled`, [workspaceId]);
  return rows.map(map);
}
