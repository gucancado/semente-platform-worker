import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepExpiredMedia } from '../../src/whatsapp/media-retention.js';

function fakePool(rows: { id: number; media_key: string }[], updateRowCount = 1) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (flat.startsWith('SELECT')) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: updateRowCount };
    },
  };
  return { pool: pool as never, calls };
}

const rows = [
  { id: 1, media_key: 'whatsapp-media/ws/1/1.jpg' },
  { id: 2, media_key: 'whatsapp-audio/ws/1/2.ogg' },
];

test('desligada (0) e dias abaixo do piso não tocam banco nem bucket', async () => {
  for (const days of [0, 1, 29]) {
    const { pool, calls } = fakePool(rows);
    let deletes = 0;
    const r = await sweepExpiredMedia(pool, { deleteObject: async () => { deletes += 1; } }, { days, budget: 500 });
    assert.deepEqual(r, { selected: 0, expired: 0, failed: 0 });
    assert.equal(calls.length, 0, `days=${days} não pode consultar`);
    assert.equal(deletes, 0);
  }
});

test('apaga o objeto ANTES de soltar a referência e casa a key no UPDATE', async () => {
  const { pool, calls } = fakePool(rows);
  const order: string[] = [];
  const io = { deleteObject: async (key: string) => { order.push(`delete ${key}`); } };
  const r = await sweepExpiredMedia(pool, io, { days: 180, budget: 500 });
  assert.deepEqual(r, { selected: 2, expired: 2, failed: 0 });
  assert.deepEqual(calls[0]!.params, [180, 500]);
  const updates = calls.filter((c) => c.sql.startsWith('UPDATE'));
  assert.deepEqual(updates.map((u) => u.params), [[1, rows[0]!.media_key], [2, rows[1]!.media_key]]);
  assert.match(updates[0]!.sql, /media_status = 'expired' WHERE id = \$1 AND media_key = \$2/);
  assert.deepEqual(order, rows.map((x) => `delete ${x.media_key}`));
});

test('falha no delete não solta a referência', async () => {
  const { pool, calls } = fakePool(rows);
  const io = { deleteObject: async (key: string) => { if (key.endsWith('1.jpg')) throw new Error('r2 fora'); } };
  const r = await sweepExpiredMedia(pool, io, { days: 180, budget: 500 });
  assert.deepEqual(r, { selected: 2, expired: 1, failed: 1 });
  const updates = calls.filter((c) => c.sql.startsWith('UPDATE'));
  assert.deepEqual(updates.map((u) => u.params[0]), [2]);
});

test('key regravada no meio-tempo não conta como expirada', async () => {
  const { pool } = fakePool(rows, 0);
  const r = await sweepExpiredMedia(pool, { deleteObject: async () => {} }, { days: 180, budget: 500 });
  assert.equal(r.expired, 0);
});

test('dry-run só conta', async () => {
  const { pool, calls } = fakePool(rows);
  let deletes = 0;
  const r = await sweepExpiredMedia(pool, { deleteObject: async () => { deletes += 1; } }, { days: 180, budget: 500, dryRun: true });
  assert.deepEqual(r, { selected: 2, expired: 0, failed: 0 });
  assert.equal(deletes, 0);
  assert.equal(calls.filter((c) => c.sql.startsWith('UPDATE')).length, 0);
});
