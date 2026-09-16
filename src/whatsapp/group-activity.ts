import type { Pool } from 'pg';
import type { GroupScope } from './group-links.js';

/**
 * Dígitos canônicos de um identificador do WhatsApp.
 *
 * Remove domínio (`@s.whatsapp.net`, `@lid`) e sufixo de device (`:12`) antes de
 * extrair os dígitos. O device NUNCA foi observado em `messages.author` (0 de
 * ~40 mil, medido em 2026-09-15), mas o pipeline não garante a ausência:
 * `canonicalJid` só troca `@lid` pelo alt e `normalizeGroupJid` faz
 * `split('@')[0]` — nenhum dos dois remove `:N`. Se um dia aparecer, concatenar
 * o device aos dígitos faria a pessoa não casar com roster nenhum, em silêncio.
 */
export function canonicalDigits(raw: string | null | undefined): string {
  if (!raw) return '';
  const head = raw.split('@')[0] ?? '';
  return (head.split(':')[0] ?? '').replace(/\D/g, '');
}

function keysOf(p: { phone: string; lid?: string | null }): string[] {
  const out = new Set<string>();
  for (const k of [canonicalDigits(p.phone), canonicalDigits(p.lid)]) if (k) out.add(k);
  return [...out];
}

/**
 * Casa o roster com a agregação por autor.
 *
 * O WhatsApp identifica a MESMA pessoa de dois jeitos conforme a época:
 * `messages.author` guarda telefone real em mensagens novas e `+<lid>` em
 * antigas. Medido em produção (2026-09-15): dos 204 participantes de grupos
 * vinculados, 76 casam só por telefone e 102 por telefone-ou-LID — casar só por
 * telefone perderia 26 pessoas, um terço a mais.
 *
 * Chave reivindicada por mais de um participante do grupo devolve `null` pros
 * dois: atribuir a atividade de uma pessoa a outra pela ordem do roster é erro
 * invisível na tela. (0 colisões medidas hoje.)
 */
export function attachLastMessage<P extends { phone: string; lid?: string | null }>(
  participants: P[],
  lastByAuthorDigits: Map<string, string>,
): Array<P & { lastMessageAt: string | null }> {
  const claims = new Map<string, number>();
  for (const p of participants) {
    for (const k of keysOf(p)) claims.set(k, (claims.get(k) ?? 0) + 1);
  }
  return participants.map((p) => {
    let best: string | null = null;
    let bestTs = -Infinity;
    for (const k of keysOf(p)) {
      if ((claims.get(k) ?? 0) > 1) continue;
      const iso = lastByAuthorDigits.get(k);
      if (!iso) continue;
      const ts = Date.parse(iso);
      if (Number.isFinite(ts) && ts > bestTs) { bestTs = ts; best = iso; }
    }
    return { ...p, lastMessageAt: best };
  });
}

/**
 * Última mensagem por AUTOR no recorte do grupo, chaveada por dígitos canônicos.
 *
 * Uma agregação só, não um LATERAL por participante: o recorte por grupo é
 * coberto por `idx_messages_thread` / `idx_messages_number_thread`, mas **não
 * existe índice em `messages(author)`**. O predicado de escopo é idêntico ao dos
 * outros leitores (`group-search.ts`) — o escopo nunca vem do caller.
 */
export async function lastMessageByAuthor(
  pool: Pool, opts: { scope: GroupScope; identifier: string },
): Promise<Map<string, string>> {
  const { rows } = opts.scope.kind === 'number'
    ? await pool.query(
        `SELECT author, MAX(created_at) AS last_at
           FROM messages
          WHERE whatsapp_number_id = $1 AND workspace_id = $2 AND identifier = $3
            AND author IS NOT NULL
          GROUP BY author`,
        [opts.scope.numberId, opts.scope.numberWorkspaceId, opts.identifier],
      )
    : await pool.query(
        `SELECT author, MAX(created_at) AS last_at
           FROM messages
          WHERE agent = $1 AND whatsapp_number_id IS NULL AND identifier = $2
            AND author IS NOT NULL
          GROUP BY author`,
        [opts.scope.agent, opts.identifier],
      );
  const out = new Map<string, string>();
  for (const r of rows) {
    const k = canonicalDigits(r.author);
    if (!k) continue;
    const iso = r.last_at?.toISOString?.() ?? String(r.last_at);
    const prev = out.get(k);
    // Dois formatos de author podem normalizar pra mesma chave (ex.: com e sem
    // '+'): fica o mais recente.
    if (!prev || Date.parse(iso) > Date.parse(prev)) out.set(k, iso);
  }
  return out;
}
