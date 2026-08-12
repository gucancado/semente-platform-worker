/**
 * tests/whatsapp/group-search.test.ts — busca group-scoped, DB-free.
 * O que importa: escape do ILIKE (com ESCAPE '\'), filtro de escopo idêntico
 * ao dos leitores por kind, ordenação total (created_at, id) e truncated via
 * limit+1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeIlike, buildSnippet, searchGroupMessages } from '../../src/whatsapp/group-search.js';

function fakePool(rows: any[]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows }; },
  } as any;
  return { pool, calls };
}

const AGENT_SCOPE = { kind: 'agent', agent: 'saturno' } as any;
const NUMBER_SCOPE = { kind: 'number', numberId: 3, numberWorkspaceId: 'ws-saturno' } as any;

test('escapeIlike escapa \\, % e _', () => {
  assert.equal(escapeIlike('100%_a\\b'), '100\\%\\_a\\\\b');
});

test('buildSnippet: match no meio ganha janela com reticências dos dois lados', () => {
  const text = 'x'.repeat(500) + 'ALVO' + 'y'.repeat(500);
  const s = buildSnippet(text, 'alvo');
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.ok(s.includes('ALVO'));
  assert.ok(s.length < 400);
});

test('buildSnippet: texto curto sem match volta inteiro; longo sem match trunca', () => {
  assert.equal(buildSnippet('oi', 'zzz'), 'oi');
  const long = 'a'.repeat(400);
  const s = buildSnippet(long, 'zzz');
  assert.ok(s.length <= 301 && s.endsWith('…'));
});

test('escopo agent: agent + identifier + whatsapp_number_id IS NULL + ILIKE com ESCAPE', async () => {
  const { pool, calls } = fakePool([]);
  await searchGroupMessages(pool, { scope: AGENT_SCOPE, identifier: '+120363099', q: '50%', limit: 30 });
  const { sql, params } = calls[0];
  assert.match(sql, /m\.agent\s*=\s*\$1/);
  assert.match(sql, /m\.whatsapp_number_id IS NULL/);
  assert.match(sql, /m\.identifier\s*=\s*\$2/);
  assert.match(sql, /ILIKE/);
  assert.match(sql, /ESCAPE/);
  assert.match(sql, /ORDER BY m\.created_at DESC, m\.id DESC/);
  assert.equal(params[2], '50\\%');       // q escapado como parâmetro
  assert.equal(params[3], 31);            // limit+1
});

test('escopo number: filtro triplo', async () => {
  const { pool, calls } = fakePool([]);
  await searchGroupMessages(pool, { scope: NUMBER_SCOPE, identifier: '+120363001', q: 'oi', limit: 30 });
  const { sql, params } = calls[0];
  assert.match(sql, /m\.whatsapp_number_id\s*=\s*\$1/);
  assert.match(sql, /m\.workspace_id\s*=\s*\$2/);
  assert.match(sql, /m\.identifier\s*=\s*\$3/);
  assert.deepEqual(params.slice(0, 3), [3, 'ws-saturno', '+120363001']);
});

test('truncated via limit+1: 31 rows com limit 30 → truncated e 30 hits', async () => {
  const row = (id: number) => ({
    id, direction: 'inbound', text: 'tem oi aqui', created_at: new Date('2026-08-01T12:00:00Z'),
    author: '+5531999998888', author_name: 'Fulano',
  });
  const { pool } = fakePool(Array.from({ length: 31 }, (_, i) => row(i + 1)));
  const r = await searchGroupMessages(pool, { scope: AGENT_SCOPE, identifier: '+1', q: 'oi', limit: 30 });
  assert.equal(r.truncated, true);
  assert.equal(r.hits.length, 30);
  assert.deepEqual(r.hits[0], {
    id: 1, createdAt: '2026-08-01T12:00:00.000Z', direction: 'inbound',
    author: '+5531999998888', authorName: 'Fulano', snippet: 'tem oi aqui',
  });
});
