import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

after(() => pool.end());

test('connection_probes existe com as colunas da spec', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'connection_probes'`,
  );
  const cols = rows.map((r) => r.column_name).sort();
  for (const c of [
    'id', 'instance', 'kind', 'number_id', 'phone', 'label', 'code', 'parent_id', 'trigger',
    'wamid', 'mirror_wamid', 'sent_at', 'send_error', 'cloud_status', 'cloud_status_at', 'cloud_error',
    'received_at', 'msg_key', 'store_seen', 'verdict', 'verdict_at', 'created_at',
  ]) assert.ok(cols.includes(c), `falta ${c}`);
});

test('uma sonda aberta por instância', async () => {
  await pool.query('TRUNCATE connection_probes RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO connection_probes (instance, kind, phone, code, trigger) VALUES ('i1','system','+551','AAAA','quiet')`,
  );
  await assert.rejects(
    pool.query(`INSERT INTO connection_probes (instance, kind, phone, code, trigger) VALUES ('i1','system','+551','BBBB','quiet')`),
    /uq_connection_probes_open/,
  );
  await pool.query(`UPDATE connection_probes SET verdict = 'alive', verdict_at = NOW()`);
  await pool.query(
    `INSERT INTO connection_probes (instance, kind, phone, code, trigger) VALUES ('i1','system','+551','CCCC','quiet')`,
  );
});

test('instance_outages aceita started_at_source probe e system_instance_health tem down_source', async () => {
  await pool.query('TRUNCATE instance_outages');
  await pool.query(
    `INSERT INTO instance_outages (instance, kind, started_at, started_at_source, detected_by)
     VALUES ('i-x', 'system', NOW(), 'probe', 'probe')`,
  );
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'system_instance_health' AND column_name = 'down_source'`,
  );
  assert.equal(rows.length, 1);
});
