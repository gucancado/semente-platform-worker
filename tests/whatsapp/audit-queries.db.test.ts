/**
 * tests/whatsapp/audit-queries.db.test.ts
 * SERVER-GATED: requer Postgres (TRUNCATE). Harness efêmero.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listAccessLog, RELEVANT_ACTIONS } from '../../src/whatsapp/audit-queries.js';

beforeEach(async () => { await pool.query('TRUNCATE whatsapp_access_log RESTART IDENTITY CASCADE'); });
after(() => pool.end());

async function log(opts: { actor: string; action: string; ws: string; numberId?: number; identifier?: string; createdAt?: string; meta?: object }) {
  await pool.query(
    `INSERT INTO whatsapp_access_log (actor, action, workspace_id, number_id, identifier, created_at, meta)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, NOW()), $7)`,
    [opts.actor, opts.action, opts.ws, opts.numberId ?? null, opts.identifier ?? null, opts.createdAt ?? null, opts.meta ? JSON.stringify(opts.meta) : null],
  );
}

test('scope relevant filtra só o conjunto relevante; all devolve tudo', async () => {
  const ws = 'ws-audit';
  await log({ actor: 'a@x', action: 'set_lead', ws, identifier: '+1', meta: { status: 'lead' } });
  await log({ actor: 'a@x', action: 'export', ws, identifier: '+1', meta: { messageCount: 12 } });
  await log({ actor: 'b@x', action: 'stats', ws });               // ruído (read)
  await log({ actor: 'b@x', action: 'list_threads', ws });        // ruído (read)

  const relevant = await listAccessLog(pool, { workspaceId: ws, actions: [...RELEVANT_ACTIONS], limit: 50 });
  assert.deepEqual(relevant.entries.map(e => e.action).sort(), ['export', 'set_lead']);

  const all = await listAccessLog(pool, { workspaceId: ws, limit: 50 }); // actions undefined → sem filtro
  assert.equal(all.entries.length, 4);
});

test('filtros por actor, number e período', async () => {
  const ws = 'ws-f';
  await log({ actor: 'a@x', action: 'set_lead', ws, numberId: 1, createdAt: '2026-01-10T00:00:00Z' });
  await log({ actor: 'b@x', action: 'set_lead', ws, numberId: 2, createdAt: '2026-02-10T00:00:00Z' });

  assert.equal((await listAccessLog(pool, { workspaceId: ws, actor: 'a@x', limit: 50 })).entries.length, 1);
  assert.equal((await listAccessLog(pool, { workspaceId: ws, numberId: 2, limit: 50 })).entries.length, 1);
  assert.equal((await listAccessLog(pool, { workspaceId: ws, since: '2026-02-01T00:00:00Z', limit: 50 })).entries.length, 1);
});

test('paginação keyset por id: união sem perda/duplicata, ordem id DESC', async () => {
  const ws = 'ws-pag';
  for (let i = 0; i < 5; i++) await log({ actor: 'a@x', action: 'set_lead', ws, identifier: `+${i}` });

  const p1 = await listAccessLog(pool, { workspaceId: ws, limit: 2 });
  assert.equal(p1.entries.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = await listAccessLog(pool, { workspaceId: ws, limit: 2, cursor: p1.nextCursor! });
  const p3 = await listAccessLog(pool, { workspaceId: ws, limit: 2, cursor: p2.nextCursor! });

  const ids = [...p1.entries, ...p2.entries, ...p3.entries].map(e => e.id);
  assert.equal(new Set(ids).size, 5, 'sem duplicata');
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'ordem id DESC estável');
  assert.equal(p3.nextCursor, null);
});

test('escopo de workspace isolado', async () => {
  await log({ actor: 'a@x', action: 'set_lead', ws: 'ws-1' });
  await log({ actor: 'a@x', action: 'set_lead', ws: 'ws-2' });
  const r = await listAccessLog(pool, { workspaceId: 'ws-1', limit: 50 });
  assert.equal(r.entries.length, 1);
});

test('actions=[] (array vazio) NÃO filtra-zero silenciosamente', async () => {
  const ws = 'ws-empty';
  await log({ actor: 'a@x', action: 'set_lead', ws });
  // [] deve ser tratado como "sem filtro" (não ANY('{}') que zera tudo)
  const r = await listAccessLog(pool, { workspaceId: ws, actions: [], limit: 50 });
  assert.equal(r.entries.length, 1);
});
