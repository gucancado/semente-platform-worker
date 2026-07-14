import type { Pool } from 'pg';
import type { VexaClient, VexaMeeting } from '../integrations/vexa/client.js';
import type { CollectedMeetingRow } from './db.js';
import { updateCollectedMeeting } from './db.js';
import { vexaMeetingToEpisodeInput } from '../integrations/vexa/normalize.js';
import type { insertEpisodeWithTurns } from '../episodes/db.js';

export type MeetingsCollectDeps = {
  pool: Pool;
  vexa: Pick<VexaClient, 'getTranscript' | 'stopBot'>;
  putAndVerify: (key: string, body: string, contentType: string) => Promise<void>;
  insertEpisode: typeof insertEpisodeWithTurns;
  inactivityStopMin: number;
  admissionTimeoutMin: number;
  now: () => Date;
  log?: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
};

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
