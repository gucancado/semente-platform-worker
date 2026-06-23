// src/whatsapp/transcript.ts
export type TranscriptMsg = { direction: string; text: string | null; author: string | null; authorName: string | null; createdAt: string };
export type TranscriptCtx = { kind: 'dm' | 'group'; isTeam: (idOrAuthor: string | null) => boolean; contactName?: string | null };

function brt(iso: string): string {
  // Formato fixo "YYYY-MM-DD HH:mm BRT" em America/Sao_Paulo.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} BRT`;
}

export function roleLabel(m: TranscriptMsg, ctx: TranscriptCtx): string {
  if (ctx.kind === 'group') {
    const name = m.authorName ?? m.author ?? '—';
    const team = ctx.isTeam(m.author);
    return team ? `Atendente (${name})` : `Cliente (${name})`;
  }
  if (m.direction === 'outbound') return 'Atendente';
  return ctx.contactName ? `Cliente (${ctx.contactName})` : 'Cliente';
}

export function formatTranscript(msgs: TranscriptMsg[], ctx: TranscriptCtx): string {
  return msgs.map(m => `[${brt(m.createdAt)}] ${roleLabel(m, ctx)}: ${m.text ?? '—'}`).join('\n');
}
