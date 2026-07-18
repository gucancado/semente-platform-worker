// src/whatsapp/export.ts
import type { Pool } from 'pg';
import { listThreadMessages } from './read-queries.js';
import { isGroupThread } from './thread-meta.js';
import { resolveByWhatsapp } from '../commands/identity.js';
import { formatTranscript, type TranscriptMsg } from './transcript.js';

const HARD_CAP = 2000;

export async function exportConversation(pool: Pool, p: { workspaceId: string; numberId: number; identifier: string; since?: string; until?: string; maxMessages?: number; order?: 'head' | 'tail' }) {
  const cap = Math.min(p.maxMessages ?? 500, HARD_CAP);
  const order = p.order ?? 'tail';
  // tail (default/compat): pagina do MAIS NOVO (DESC) e mantém as ÚLTIMAS N (o desfecho).
  // head: pagina do MAIS ANTIGO (ASC) e mantém as PRIMEIRAS N (o começo da conversa).
  const fetchOrder: 'asc' | 'desc' = order === 'head' ? 'asc' : 'desc';
  const isGroup = await isGroupThread(pool, p.numberId, p.identifier);

  // Auto-pagina: acumula até o cap na direção escolhida.
  const collected: TranscriptMsg[] = [];
  let cursor: string | undefined = undefined;
  let truncated = false;
  while (collected.length < cap) {
    const page = await listThreadMessages(pool, { workspaceId: p.workspaceId, numberId: p.numberId, identifier: p.identifier, limit: Math.min(100, cap - collected.length), cursor, since: p.since, until: p.until, order: fetchOrder });
    collected.push(...page.messages.map(m => ({ direction: m.direction, text: m.text, author: m.author, authorName: m.authorName, createdAt: m.createdAt })));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    if (collected.length >= cap) { truncated = true; break; }
  }
  // head já vem cronológico (ASC); tail vem do mais novo → inverter p/ cronológico.
  const asc = order === 'head' ? collected.slice() : collected.slice().reverse();

  // Identidade do contato (DM) p/ rótulo; membro de equipe = tem role em algum workspace.
  let contactName: string | null = null;
  const teamCache = new Map<string, boolean>();
  const isTeam = (idOrAuthor: string | null): boolean => {
    if (!idOrAuthor) return false;
    return teamCache.get(idOrAuthor) ?? false;
  };
  // Pré-resolve identidades (DM: o identifier; grupo: autores distintos).
  const toResolve = isGroup ? [...new Set(asc.map(m => m.author).filter(Boolean) as string[])] : [p.identifier];
  const resolved = await Promise.all(toResolve.map(id => resolveByWhatsapp(id).then(u => ({ id, u }))));
  for (const { id, u } of resolved) {
    teamCache.set(id, !!u && (u.workspaces?.some(w => ['admin', 'owner', 'editor', 'member'].includes((w.role || '').toLowerCase())) ?? false));
    if (!isGroup && u) contactName = u.name;
  }

  const transcript = formatTranscript(asc, { kind: isGroup ? 'group' : 'dm', isTeam, contactName });
  return { identifier: p.identifier, kind: (isGroup ? 'group' : 'dm') as 'dm' | 'group', transcript, messageCount: asc.length, truncated };
}
