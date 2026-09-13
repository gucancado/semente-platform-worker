import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  createReconnectLink,
  ensureReconnectLink,
  getActiveReconnectLink,
} from '../../src/whatsapp/provision-links.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_provision_links');
});
after(() => pool.end());

const base = {
  instance: 'saturno',
  expectedPhone: '+553195950748',
  label: 'Monitor de grupos',
  workspaceId: null,
  createdBy: 'down-notify',
  maxClicks: 10,
  ttlDays: 7,
};

test('sem link ativo emite um novo, travado no telefone', async () => {
  const r = await ensureReconnectLink(pool, base);
  assert.equal(r.reused, false);
  assert.equal(r.row.targetInstance, 'saturno');
  assert.equal(r.row.expectedPhone, '+553195950748');
  assert.equal(r.row.workspaceId, null);
});

test('re-aviso reusa o link ativo em vez de matar o anterior', async () => {
  const a = await ensureReconnectLink(pool, base);
  const b = await ensureReconnectLink(pool, base);
  assert.equal(b.reused, true);
  assert.equal(b.row.token, a.row.token);
  assert.equal((await getActiveReconnectLink(pool, 'saturno'))!.token, a.row.token);
});

test('link perto de vencer não é reusado', async () => {
  const a = await ensureReconnectLink(pool, base);
  await pool.query(
    `UPDATE whatsapp_provision_links SET expires_at = NOW() + INTERVAL '2 hours' WHERE token = $1`,
    [a.row.token],
  );
  const b = await ensureReconnectLink(pool, { ...base, minRemainingMs: 24 * 3_600_000 });
  assert.equal(b.reused, false);
  assert.notEqual(b.row.token, a.row.token);
});

test('link esgotado não é reusado', async () => {
  const a = await ensureReconnectLink(pool, base);
  await pool.query(`UPDATE whatsapp_provision_links SET clicks_used = max_clicks WHERE token = $1`, [a.row.token]);
  const b = await ensureReconnectLink(pool, base);
  assert.equal(b.reused, false);
});

test('link ativo travado em OUTRO telefone não é reusado', async () => {
  await createReconnectLink(pool, {
    token: 'velho', targetInstance: 'saturno', targetLabel: null, expectedPhone: '+5531000',
    workspaceId: null, createdBy: 'cli', maxClicks: 10, ttlDays: 7,
  });
  const b = await ensureReconnectLink(pool, base);
  assert.equal(b.reused, false);
  assert.equal(b.row.expectedPhone, '+553195950748');
});
