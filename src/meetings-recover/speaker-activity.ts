/** Validação PURA do corpo enviado pelo bot. Teto por pedido: o preload envia
 *  a cada ~20 s, então 500 intervalos é muito acima do normal. */
export const MAX_EVENTS = 500;
const MAX_SPAN_MS = 6 * 60 * 60_000;

export type SpeakerActivityBody =
  | { ok: true; meetingId: number | null; nativeMeetingId: string | null; events: Array<{ speaker: string; startMs: number; endMs: number }> }
  | { ok: false; error: string };

export function parseSpeakerActivityBody(b: unknown): SpeakerActivityBody {
  if (!b || typeof b !== 'object') return { ok: false, error: 'invalid_body' };
  const o = b as Record<string, unknown>;
  const idNum = Number(o.meeting_id);
  const meetingId = Number.isInteger(idNum) && idNum > 0 ? idNum : null;
  const nativeMeetingId = typeof o.native_meeting_id === 'string' && o.native_meeting_id ? o.native_meeting_id : null;
  if (meetingId == null && !nativeMeetingId) return { ok: false, error: 'meeting_required' };
  if (!Array.isArray(o.events)) return { ok: false, error: 'events_required' };
  if (o.events.length > MAX_EVENTS) return { ok: false, error: 'too_many_events' };
  const events: Array<{ speaker: string; startMs: number; endMs: number }> = [];
  for (const e of o.events) {
    if (!e || typeof e !== 'object') continue;
    const x = e as Record<string, unknown>;
    const speaker = typeof x.speaker === 'string' ? x.speaker.trim().slice(0, 200) : '';
    const startMs = Number(x.start_ms);
    const endMs = Number(x.end_ms);
    if (!speaker || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs < startMs || endMs - startMs > MAX_SPAN_MS) continue;
    events.push({ speaker, startMs, endMs });
  }
  return { ok: true, meetingId, nativeMeetingId, events };
}
