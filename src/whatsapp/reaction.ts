import type { Pool } from 'pg';
import { getAgentsForNumber } from './workspace-agents.js';

export async function agentsToTrigger(pool: Pool, p: { workspaceId: string; numberId: number; mode: 'monitored'|'agent_operated' }): Promise<string[]> {
  if (p.mode === 'monitored') return [];
  const agents = await getAgentsForNumber(pool, { workspaceId: p.workspaceId, numberId: p.numberId, reactionMode: 'reactive' });
  return agents.map(a => a.agent);
}

export async function quarantineUnknownInstance(pool: Pool, payload: any): Promise<void> {
  const eventId = payload?.data?.key?.id ?? `${payload?.instance}:${Date.now()}`;
  await pool.query(
    `INSERT INTO webhook_receipts (provider, external_event_id, payload, status, last_error)
     VALUES ('evolution', $1, $2, 'failed', 'unknown_instance')
     ON CONFLICT (provider, external_event_id) DO NOTHING`,
    [eventId, JSON.stringify(payload)]);
}
