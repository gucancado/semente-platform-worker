import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

const TABLES = ['episodes', 'episode_turns', 'event_outbox', 'event_outbox_deliveries', 'webhook_receipts', 'workspace_domains'];

after(() => pool.end());

test('migrations 015-018 criam as tabelas do repositório de transcrições', async () => {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
    [TABLES]
  );
  assert.deepEqual(rows.map((r) => r.table_name).sort(), [...TABLES].sort());
});

test('episodes tem unique (external_source, external_id) e revision default 1', async () => {
  const { rows } = await pool.query(
    `SELECT column_name, column_default FROM information_schema.columns WHERE table_name='episodes' AND column_name='revision'`
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].column_default, /1/);
});
