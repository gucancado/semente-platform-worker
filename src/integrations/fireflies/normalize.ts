import type { EpisodeInput, EpisodeTurnInput } from '../../episodes/db.js';

export type FirefliesSentence = {
  index: number; speaker_name: string | null; text: string;
  raw_text?: string | null; start_time: number; end_time: number; // segundos
};

export type FirefliesAttendee = {
  displayName?: string | null;
  email?: string | null;
  name?: string | null;
  phoneNumber?: string | null;
  location?: string | null;
};

export type FirefliesTranscript = {
  id: string; title: string | null; date: number; // epoch ms
  duration: number | null; // MINUTOS (doc Fireflies)
  host_email?: string | null; organizer_email?: string | null;
  participants?: string[] | null; // emails
  meeting_attendees?: FirefliesAttendee[] | null;
  sentences: FirefliesSentence[] | null;
  audio_url?: string | null;
};

/** Sentenças consecutivas do mesmo speaker → 1 turno (spec §3/§6.2). */
export function sentencesToTurns(sentences: FirefliesSentence[]): EpisodeTurnInput[] {
  const turns: EpisodeTurnInput[] = [];
  for (const s of sentences) {
    const last = turns[turns.length - 1];
    if (last && last.speaker_name === (s.speaker_name ?? null)) {
      last.text += ' ' + s.text;
      last.ended_at_ms = Math.round(s.end_time * 1000);
    } else {
      turns.push({
        turn_index: turns.length,
        speaker_name: s.speaker_name ?? null,
        speaker_label: s.speaker_name ?? null, // Fireflies já entrega nomeado; label = proveniência
        started_at_ms: Math.round(s.start_time * 1000),
        ended_at_ms: Math.round(s.end_time * 1000),
        text: s.text,
      });
    }
  }
  return turns;
}

/** Resolve a lista de participantes mesclando `participants` (emails) com `meeting_attendees` (nomes). */
function buildParticipants(
  participants: string[] | null | undefined,
  attendees: FirefliesAttendee[] | null | undefined,
): Array<{ name?: string; email?: string | null }> {
  // mapa keyed por email lowercased; emails de participants entram primeiro (sem nome)
  const byEmail = new Map<string, { name?: string; email?: string | null }>();
  for (const email of participants ?? []) {
    byEmail.set(email.toLowerCase(), { email });
  }
  // attendees com email: overlay o nome se ainda não tiver
  const noEmailAttendees: Array<{ name?: string; email?: string | null }> = [];
  for (const a of attendees ?? []) {
    const resolvedName = a.displayName ?? a.name ?? undefined;
    if (a.email) {
      const key = a.email.toLowerCase();
      const existing = byEmail.get(key);
      if (existing) {
        // enriquece com nome; mantém email original do participants
        existing.name = resolvedName;
      } else {
        byEmail.set(key, { name: resolvedName, email: a.email });
      }
    } else {
      // attendee sem email: incluir como entrada extra (name-only)
      noEmailAttendees.push({ name: resolvedName, email: null });
    }
  }
  return [...byEmail.values(), ...noEmailAttendees];
}

export function transcriptToEpisodeInput(t: FirefliesTranscript, rawR2Key: string | null): EpisodeInput {
  return {
    fonte: 'reuniao',
    external_source: 'fireflies',
    external_id: t.id,
    title: t.title ?? null,
    occurred_at: new Date(t.date),
    duration_seconds: t.duration != null ? Math.round(t.duration * 60) : null,
    participants: buildParticipants(t.participants, t.meeting_attendees),
    metadata: {
      host_email: t.host_email ?? null,
      organizer_email: t.organizer_email ?? null,
      attendees: t.meeting_attendees ?? [],
    },
    raw_r2_key: rawR2Key,
    audio_r2_key: null, // setado pelo importador se o áudio for baixado
    turns: sentencesToTurns(t.sentences ?? []),
  };
}
