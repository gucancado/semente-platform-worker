import type { EpisodeInput, EpisodeTurnInput } from '../../episodes/db.js';
import type { VexaMeeting, VexaSegment } from './client.js';

/** Vexa manda start_time sem sufixo de tz (ex.: "2026-07-10T21:58:25.557234"). É UTC — anexa 'Z' se faltar offset. */
export function parseVexaTimestamp(s: string | null): Date | null {
  if (!s) return null;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(hasTz ? s : s + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Mescla segments consecutivos do mesmo speaker+text a <1s de distância (bug do primeiro segment
 * duplicado, spec §4.1). A mesclagem vira [min start, max end] — o zero-length inicial some no par real.
 */
export function dedupSegments(segments: VexaSegment[]): VexaSegment[] {
  const out: VexaSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && last.text === s.text && Math.abs(s.start - last.start) < 1) {
      last.start = Math.min(last.start, s.start);
      last.end = Math.max(last.end, s.end);
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/** Segments consecutivos do mesmo speaker → 1 turno. Tempos relativos ao primeiro start (epoch s → ms). */
export function segmentsToTurns(segments: VexaSegment[], firstStart: number): EpisodeTurnInput[] {
  const turns: EpisodeTurnInput[] = [];
  for (const s of segments) {
    const speaker = s.speaker ?? null;
    const last = turns[turns.length - 1];
    if (last && last.speaker_name === speaker) {
      last.text += ' ' + s.text;
      last.ended_at_ms = Math.round((s.end - firstStart) * 1000);
    } else {
      turns.push({
        turn_index: turns.length,
        speaker_name: speaker,
        speaker_label: speaker, // Vexa entrega nomeado; label = proveniência (genérico "Speaker" mantido)
        started_at_ms: Math.round((s.start - firstStart) * 1000),
        ended_at_ms: Math.round((s.end - firstStart) * 1000),
        text: s.text,
      });
    }
  }
  return turns;
}

export function vexaMeetingToEpisodeInput(m: VexaMeeting, rawR2Key: string | null): EpisodeInput {
  const segments = dedupSegments(m.segments ?? []);
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  const firstStart = firstSegment ? firstSegment.start : 0;
  const lastEnd = lastSegment ? lastSegment.end : firstStart;

  const startDate = parseVexaTimestamp(m.start_time);
  const endDate = parseVexaTimestamp(m.end_time);
  const occurred_at = startDate ?? (segments.length ? new Date(firstStart * 1000) : new Date(0));
  const duration_seconds =
    startDate && endDate
      ? Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 1000))
      : segments.length
        ? Math.max(0, Math.round(lastEnd - firstStart))
        : null;

  // participantes = speakers únicos (não-nulos), na ordem de aparição; "Speaker" genérico mantido.
  const speakerCounts: Record<string, number> = {};
  for (const s of segments) {
    if (s.speaker) speakerCounts[s.speaker] = (speakerCounts[s.speaker] ?? 0) + 1;
  }
  const participants = Object.keys(speakerCounts).map((name) => ({ name, email: null }));

  return {
    fonte: 'reuniao',
    external_source: 'vexa',
    external_id: String(m.id),
    title: null,
    occurred_at,
    duration_seconds,
    participants,
    metadata: {
      meet_code: m.native_meeting_id,
      vexa_meeting_id: m.id,
      speaker_counts: speakerCounts,
    },
    raw_r2_key: rawR2Key,
    audio_r2_key: null,
    turns: segmentsToTurns(segments, firstStart),
  };
}
