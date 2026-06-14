import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

test('019: extensao vector instalada', async () => {
  const { rows } = await pool.query(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
  );
  assert.equal(rows.length, 1, 'extensao vector ausente — aplicar migrations');
  assert.ok(parseFloat(rows[0].extversion) >= 0.8, 'pgvector < 0.8');
});

test.after(async () => { await pool.end(); });
