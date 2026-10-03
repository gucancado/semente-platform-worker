/**
 * src/meetings-collect/reuse.ts
 *
 * Decisão PURA do reaproveitamento de pedido duplicado no POST /meetings-collect.
 *
 * Por quê: o Vexa recusa um 2º bot no mesmo meet_code. Caso real (02/10): coleta
 * manual às 13:52 → a agendada das 14:00 e o retry das 14:11 morreram em
 * vexa_send_failed e o bot certo só entrou às 14:22. Pedido novo para uma sala que
 * já tem coleta ativa é a MESMA reunião (re)confirmada: reaproveita a row.
 */
import type { CollectedMeetingRow } from './db.js';

export type ReuseIncoming = { workspaceId: string | null; title: string | null; queueExpiresAt: Date | null };
export type ReusePatch = { queueExpiresAt?: Date; startedAt?: Date; title?: string; workspaceId?: string };

export function planCollectReuse(
  existing: Pick<CollectedMeetingRow, 'status' | 'queue_expires_at' | 'created_at' | 'started_at' | 'title' | 'workspace_id'>,
  incoming: ReuseIncoming,
  now: Date,
  queueMaxWaitMin: number,
): ReusePatch {
  const patch: ReusePatch = {};
  // Estende a validade da fila se a nova for maior. Sem queue_expires_at, o
  // limite efetivo é created_at + MEETINGS_QUEUE_MAX_WAIT_MIN (promoteQueuedMeetings).
  if (incoming.queueExpiresAt) {
    const current = existing.queue_expires_at
      ?? new Date(new Date(existing.created_at).getTime() + queueMaxWaitMin * 60_000);
    if (incoming.queueExpiresAt.getTime() > new Date(current).getTime()) patch.queueExpiresAt = incoming.queueExpiresAt;
  }
  // Bot já no ar: a reunião acabou de ser confirmada para esta sala, então o
  // timeout de admissão (zero fala → silent_room) recomeça a contar agora — senão
  // o bot da coleta manual antecipada morreria antes de a reunião começar.
  // GREATEST: nunca recua a âncora.
  if (existing.status === 'collecting') {
    const anchor = existing.started_at ? new Date(existing.started_at).getTime() : -Infinity;
    if (now.getTime() > anchor) patch.startedAt = now;
  }
  // Só preenche o que está vazio: a row pode ser de outro workspace (o Vexa é por
  // sala), e sobrescrever moveria a reunião de quem pediu primeiro.
  if (existing.title == null && incoming.title) patch.title = incoming.title;
  if (existing.workspace_id == null && incoming.workspaceId) patch.workspaceId = incoming.workspaceId;
  return patch;
}
