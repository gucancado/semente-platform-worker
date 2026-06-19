import type { Pool } from 'pg';
import { getNumber } from './numbers.js';
import { getAgentsForNumber } from './workspace-agents.js';
import { acquireChannelLock, releaseChannelLock } from './channel-lock.js';
import { sendText, type EvolutionDeps } from '../evolution/client.js';

export async function whatsappSend(deps: { pool: Pool; evolution: EvolutionDeps }, p: { agent: string; workspaceId: string; numberId: number; identifier: string; text: string }) {
  const n = await getNumber(deps.pool, p.numberId);
  if (!n || n.workspaceId !== p.workspaceId) throw new Error('number not found in workspace');
  if (n.mode !== 'agent_operated') throw new Error('number is monitored, outbound disabled');
  const operators = await getAgentsForNumber(deps.pool, { workspaceId: p.workspaceId, numberId: p.numberId });
  if (!operators.some(a => a.agent === p.agent)) throw new Error('agent is not an operator of this number');
  // TODO de produto: portão de aprovação §4 + rate-limit entram aqui (gate antes do envio).
  const got = await acquireChannelLock(deps.pool, { numberId: p.numberId, identifier: p.identifier, agent: p.agent, ttlSeconds: 120 });
  if (!got) throw new Error('channel busy (another agent holds the lock)');
  try {
    const { sendId } = await sendText(deps.evolution, n.evolutionInstance, p.identifier.replace('+', ''), p.text);
    await deps.pool.query(
      `INSERT INTO messages (whatsapp_number_id, workspace_id, agent, channel, identifier, direction, text, evolution_send_id)
       VALUES ($1,$2,$3,'whatsapp',$4,'outbound',$5,$6)`,
      [p.numberId, p.workspaceId, p.agent, p.identifier, p.text, sendId]);
    return { sendId };
  } finally {
    await releaseChannelLock(deps.pool, { numberId: p.numberId, identifier: p.identifier, agent: p.agent });
  }
}
