/**
 * tests/whatsapp/group-around.test.ts — janela ancorada, DB-free.
 * O que importa: comparação por TUPLA (created_at, id) — não por timestamp só
 * (>25 empates de created_at deixariam a âncora fora); id trafega como STRING
 * até o SQL (BIGSERIAL, sem Number() no caminho do WHERE); metades sem
 * overlap → merge é concat, sem dedup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnchor, listMessagesAround } from '../../src/whatsapp/group-search.js';

const AGENT_SCOPE = { kind: 'agent', agent: 'saturno' } as any;

function fakePool(handler: (sql: string, params: any[]) => any[]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: handler(sql, params) }; },
  } as any;
  return { pool, calls };
}

test('resolveAnchor: WHERE de escopo + m.id = $::bigint; não achou → null', async () => {
  const { pool, calls } = fakePool(() => []);
  const r = await resolveAnchor(pool, { scope: AGENT_SCOPE, identifier: '+1', id: '42' });
  assert.equal(r, null);
  assert.match(calls[0].sql, /m\.agent\s*=\s*\$1/);
  assert.match(calls[0].sql, /m\.id\s*=\s*\$3::bigint/);
  assert.equal(calls[0].params[2], '42');
});

test('listMessagesAround: tupla nas duas metades, ordens opostas, id como string', async () => {
  const { pool, calls } = fakePool(() => []);
  await listMessagesAround(pool, {
    scope: AGENT_SCOPE, identifier: '+1',
    anchor: { id: '42', createdAt: new Date('2026-08-01T12:00:00Z') },
  });
  const older = calls.find((c) => c.sql.includes('<='))!;
  const newer = calls.find((c) => /\(m\.created_at, m\.id\)\s*>\s*\(/.test(c.sql))!;
  assert.match(older.sql, /\(m\.created_at, m\.id\)\s*<=\s*\(\$3::timestamptz, \$4::bigint\)/);
  assert.match(older.sql, /ORDER BY m\.created_at DESC, m\.id DESC/);
  assert.match(newer.sql, /ORDER BY m\.created_at ASC, m\.id ASC/);
  assert.equal(older.params[3], '42');
  assert.equal(older.params[4], 25);  // half default
});

test('listMessagesAround: merge = novas (revertidas) + antigas, DESC geral; âncora presente', async () => {
  const row = (id: number, iso: string) => ({
    id, direction: 'inbound', text: `m${id}`, agent: 'saturno', created_at: new Date(iso),
    author: '+55', kind: 'text', transcription_status: null, media_duration_s: null,
    media_key: null, author_name: null,
  });
  const { pool } = fakePool((sql) => {
    if (sql.includes('<=')) return [row(42, '2026-08-01T12:00:00Z'), row(41, '2026-08-01T11:00:00Z')]; // DESC, inclui âncora
    return [row(43, '2026-08-01T13:00:00Z'), row(44, '2026-08-01T14:00:00Z')];                          // ASC
  });
  const r = await listMessagesAround(pool, {
    scope: AGENT_SCOPE, identifier: '+1',
    anchor: { id: '42', createdAt: new Date('2026-08-01T12:00:00Z') },
  });
  assert.deepEqual(r.messages.map((m) => m.id), [44, 43, 42, 41]);
  assert.equal(r.nextCursor, null); // metade antiga não lotou o half
});

test('nextCursor: aparece quando a metade antiga lota o half', async () => {
  const row = (id: number) => ({
    id, direction: 'inbound', text: 'x', agent: 'saturno', created_at: new Date('2026-08-01T10:00:00Z'),
    author: '+55', kind: 'text', transcription_status: null, media_duration_s: null,
    media_key: null, author_name: null,
  });
  const { pool } = fakePool((sql) => (sql.includes('<=') ? [row(2), row(1)] : []));
  const r = await listMessagesAround(pool, {
    scope: AGENT_SCOPE, identifier: '+1', half: 2,
    anchor: { id: '2', createdAt: new Date('2026-08-01T10:00:00Z') },
  });
  assert.equal(r.nextCursor, Buffer.from('2026-08-01T10:00:00.000Z').toString('base64'));
});
