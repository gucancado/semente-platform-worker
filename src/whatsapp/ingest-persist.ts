import type { Pool } from 'pg';
import { getAgentsForNumber } from './workspace-agents.js';

// Regra §3.3: operador único → esse agente; monitored ou ambíguo → null (preserva console agentes-beeads)
export async function resolveInboundAgent(pool: Pool, p: { workspaceId: string; numberId: number; mode: 'monitored'|'agent_operated' }): Promise<string | null> {
  if (p.mode === 'monitored') return null;
  const operators = await getAgentsForNumber(pool, { workspaceId: p.workspaceId, numberId: p.numberId });
  return operators.length === 1 ? (operators[0]?.agent ?? null) : null;
}
