import type { Pool } from 'pg';
import type { Msg } from './read-queries.js';

/**
 * Mensagens de um grupo no escopo AGENTE — a linha legada de `whatsapp_groups`
 * sem `whatsapp_number_id` (hoje só `agent='saturno'`, o número da
 * ORGANIZAÇÃO: 51 grupos, que nunca migrou pra `whatsapp_numbers` e por isso
 * não tem `workspace_id`). Espelha `listThreadMessages` (`read-queries.ts`)
 * campo a campo — mesmo shape de `Msg`, mesma paginação por cursor, mesmo
 * ORDER DESC por default — porque `group-read-routes.ts` e o painel consomem
 * o resultado sem saber de qual escopo veio.
 *
 * Filtro `agent + identifier + whatsapp_number_id IS NULL`: é o MESMO par que
 * a ingestão legada usa pra gravar essas mensagens (`src/webhook/routes.ts`,
 * branch `resolved.source === 'legacy'` — o `insertMessage` de lá não passa
 * `whatsapp_number_id`, então a coluna fica NULL). Não dá pra escopar por
 * `workspace_id` como `listThreadMessages` faz: essas linhas não têm — nem em
 * `messages`, nem em `webhook_logs`.
 *
 * ⚠️ `w.whatsapp_number_id IS NOT DISTINCT FROM m.whatsapp_number_id` (NÃO
 * `=`): as duas colunas são sempre NULL nessas linhas, e `NULL = NULL` é
 * UNKNOWN em SQL — com `=` a junção NUNCA casaria e `author_name` viria
 * sempre nulo, mesmo com o evento certo do outro lado. `listThreadMessages`
 * usa `=` porque lá `m.whatsapp_number_id` nunca é nulo (rota number-scoped);
 * aqui é sempre nulo, e `IS NOT DISTINCT FROM` é o operador NULL-safe pra
 * essa mesma comparação.
 */
export async function listGroupMessagesByAgent(pool: Pool, p: {
  agent: string;
  identifier: string;
  limit: number;
  cursor?: string;
  since?: string;
  until?: string;
  order?: 'asc' | 'desc';
}): Promise<{ messages: Msg[]; nextCursor: string | null }> {
  const before = p.cursor ? Buffer.from(p.cursor, 'base64').toString() : null;
  // order 'desc' (default) = mais novas primeiro (compat com listThreadMessages).
  const asc = p.order === 'asc';
  const cmp = asc ? '>' : '<';
  const dir = asc ? 'ASC' : 'DESC';
  const { rows } = await pool.query(
    `SELECT m.id, m.direction, m.text, m.agent, m.created_at, m.author,
            m.kind, m.transcription_status, m.media_duration_s, m.media_key,
            w.push_name AS author_name
       FROM messages m
       LEFT JOIN webhook_logs w
         ON w.evolution_event_id = m.evolution_event_id
        AND w.whatsapp_number_id IS NOT DISTINCT FROM m.whatsapp_number_id
        AND m.direction = 'inbound'
      WHERE m.agent = $1 AND m.identifier = $2 AND m.whatsapp_number_id IS NULL
        AND ($3::timestamptz IS NULL OR m.created_at ${cmp} $3)
        AND ($5::timestamptz IS NULL OR m.created_at >= $5)
        AND ($6::timestamptz IS NULL OR m.created_at <= $6)
      ORDER BY m.created_at ${dir} LIMIT $4`,
    [p.agent, p.identifier, before, p.limit, p.since ?? null, p.until ?? null]);
  const messages: Msg[] = rows.map((r: any) => ({
    id: Number(r.id),
    direction: r.direction,
    text: r.text,
    agent: r.agent,
    createdAt: r.created_at.toISOString(),
    author: r.author,
    authorName: r.author_name,
    kind: r.kind,
    transcriptionStatus: r.transcription_status,
    mediaDurationS: r.media_duration_s,
    hasMedia: r.media_key != null,
  }));
  const lastMsg = messages.at(-1);
  const nextCursor = messages.length === p.limit && lastMsg ? Buffer.from(lastMsg.createdAt).toString('base64') : null;
  return { messages, nextCursor };
}
