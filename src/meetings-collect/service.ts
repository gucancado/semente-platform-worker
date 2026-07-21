import type { Pool } from 'pg';
import type { VexaClient, VexaMeeting } from '../integrations/vexa/client.js';
import type { CollectedMeetingRow } from './db.js';
import { updateCollectedMeeting, listQueuedMeetings, countActiveCollections } from './db.js';
import { vexaMeetingToEpisodeInput } from '../integrations/vexa/normalize.js';
import type { insertEpisodeWithTurns } from '../episodes/db.js';

export type MeetingsCollectDeps = {
  pool: Pool;
  vexa: Pick<VexaClient, 'sendBot' | 'getTranscript' | 'stopBot'>;
  putAndVerify: (key: string, body: string, contentType: string) => Promise<void>;
  insertEpisode: typeof insertEpisodeWithTurns;
  inactivityStopMin: number;
  admissionTimeoutMin: number;
  botName: string;
  maxConcurrent: number;
  queueMaxWaitMin: number;
  now: () => Date;
  log?: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
};

/**
 * Expira e promove a fila de coletas. Chamado pelo POST (resposta imediata
 * quando há slot) e por TODO tick do poller. Nunca lança — falha de sendBot
 * marca a row e segue; a promoção é sequencial (fila curta, sem paralelismo).
 */
export async function promoteQueuedMeetings(deps: MeetingsCollectDeps): Promise<{ promoted: number; expired: number }> {
  let promoted = 0; let expired = 0;
  // Contrato "Nunca lança": envolve TODA a rotina de expirar+promover. Qualquer erro de DB
  // (listQueuedMeetings, countActiveCollections, updateCollectedMeeting) é engolido aqui e a
  // função retorna os counts acumulados até o ponto do erro. Racional: é chamada em todo tick
  // do poller (um erro de DB não pode derrubar o tick) e no caminho do POST — que faz sua
  // PRÓPRIA re-leitura da row depois; se o DB estiver realmente fora, essa re-leitura falha e
  // o POST 500a de qualquer forma, então engolir aqui não mascara erro real do POST.
  try {
    const now = deps.now();
    const queued = await listQueuedMeetings(deps.pool);
    for (const row of queued) {
      const limit = row.queue_expires_at ?? new Date(row.created_at.getTime() + deps.queueMaxWaitMin * 60_000);
      if (limit < now) {
        await updateCollectedMeeting(deps.pool, row.id, { status: 'failed', failureReason: 'no_slot' });
        expired++;
      }
    }
    for (const row of await listQueuedMeetings(deps.pool)) {
      if ((await countActiveCollections(deps.pool)) >= deps.maxConcurrent) break;
      // sendBot preserva o comportamento atual: falha marca a row failed/vexa_send_failed e SEGUE
      // pra próxima da fila (não conta como erro fatal da rotina).
      try {
        const meeting = await deps.vexa.sendBot(row.meet_code, deps.botName, 'pt');
        await updateCollectedMeeting(deps.pool, row.id, { status: 'collecting', vexaMeetingId: meeting.id });
        promoted++;
      } catch (err) {
        await updateCollectedMeeting(deps.pool, row.id, { status: 'failed', failureReason: 'vexa_send_failed' });
        deps.log?.warn?.({ id: row.id, err: (err as Error).message }, 'meetings-collect: sendBot falhou na promoção');
      }
    }
  } catch (err) {
    deps.log?.warn?.({ err: (err as Error).message }, 'meetings-collect: promoteQueuedMeetings falhou');
  }
  return { promoted, expired };
}

function lastSegmentDate(meeting: VexaMeeting): Date | null {
  if (!meeting.segments?.length) return null;
  const maxEnd = Math.max(...meeting.segments.map((s) => s.end));
  return new Date(maxEnd * 1000);
}

/** R2 (JSON bruto) ANTES, TX depois. Idempotente: insertEpisode dedup por (external_source, external_id). */
export async function importCollectedMeeting(
  deps: MeetingsCollectDeps, row: CollectedMeetingRow, meeting: VexaMeeting,
): Promise<void> {
  const rawKey = `vexa/${meeting.id}.json`;
  await deps.putAndVerify(rawKey, JSON.stringify(meeting), 'application/json');
  const input = vexaMeetingToEpisodeInput(meeting, rawKey);
  input.workspace_id = row.workspace_id;
  input.attribution_method = 'manual';
  const r = await deps.insertEpisode(input);
  await updateCollectedMeeting(deps.pool, row.id, {
    status: 'imported', episodeId: r.id, vexaMeetingId: meeting.id, failureReason: null,
  });
}

export async function processCollectedMeeting(deps: MeetingsCollectDeps, row: CollectedMeetingRow): Promise<void> {
  let meeting: VexaMeeting;
  try {
    meeting = await deps.vexa.getTranscript(row.meet_code);
  } catch (err) {
    deps.log?.warn({ id: row.id, err: (err as Error).message }, 'getTranscript falhou; tenta no próximo tick');
    return;
  }

  const now = deps.now().getTime();
  const lastSeg = lastSegmentDate(meeting);
  const hasSegments = (meeting.segments?.length ?? 0) > 0;

  if (meeting.status === 'failed') {
    await deps.vexa.stopBot(row.meet_code).catch(() => {});
    await updateCollectedMeeting(deps.pool, row.id, { status: 'failed', failureReason: 'vexa_failed', vexaMeetingId: meeting.id });
    return;
  }

  if (meeting.status === 'completed') {
    await importCollectedMeeting(deps, row, meeting);
    return;
  }

  if (hasSegments) {
    const idleMs = now - (lastSeg ?? new Date(row.created_at)).getTime();
    if (idleMs > deps.inactivityStopMin * 60_000) {
      await deps.vexa.stopBot(row.meet_code).catch(() => {});
      await importCollectedMeeting(deps, row, meeting);
      return;
    }
    // segue coletando; registra progresso
    await updateCollectedMeeting(deps.pool, row.id, { lastSegmentAt: lastSeg, vexaMeetingId: meeting.id });
    return;
  }

  // zero segments: checa timeout de admissão
  const waitedMs = now - new Date(row.created_at).getTime();
  if (waitedMs > deps.admissionTimeoutMin * 60_000) {
    await deps.vexa.stopBot(row.meet_code).catch(() => {});
    await updateCollectedMeeting(deps.pool, row.id, { status: 'failed', failureReason: 'not_admitted', vexaMeetingId: meeting.id });
    return;
  }
  await updateCollectedMeeting(deps.pool, row.id, { vexaMeetingId: meeting.id });
}
