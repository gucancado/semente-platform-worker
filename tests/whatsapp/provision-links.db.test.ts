// tests/whatsapp/provision-links.db.test.ts (server-gated: requer DATABASE_URL + Postgres real)
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createProvisionLink, createReconnectLink, settleReconnectLinks, getProvisionLink, incrementLinkClick, markLinkConsumed, generateLinkToken } from '../../src/whatsapp/provision-links.js';

beforeEach(async () => { await pool.query('TRUNCATE whatsapp_provision_links'); });
after(() => pool.end());

test('create + get; expires_at ~ now + 7d', async () => {
  const token = generateLinkToken();
  const link = await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: 'u1', maxClicks: 10, ttlDays: 7 });
  assert.equal(link.workspaceId, 'ws-1');
  assert.equal(link.clicksUsed, 0);
  const got = await getProvisionLink(pool, token);
  assert.equal(got?.status, 'active');
  const days = (new Date(got!.expiresAt).getTime() - new Date(got!.createdAt).getTime()) / 86400000;
  assert.ok(Math.abs(days - 7) < 0.01);
});

test('incrementLinkClick incrementa e marca exhausted no 10º; recusa o 11º', async () => {
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  for (let i = 0; i < 10; i++) {
    const r = await incrementLinkClick(pool, token);
    assert.equal(r.ok, true);
  }
  assert.equal((await getProvisionLink(pool, token))?.status, 'exhausted');
  const r11 = await incrementLinkClick(pool, token);
  assert.deepEqual(r11, { ok: false, state: 'exhausted' });
});

test('markLinkConsumed marca consumed + connected_number_id; idempotente', async () => {
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  await markLinkConsumed(pool, token, 42);
  const got = await getProvisionLink(pool, token);
  assert.equal(got?.status, 'consumed');
  assert.equal(got?.connectedNumberId, 42);
  await markLinkConsumed(pool, token, 99); // no-op
  assert.equal((await getProvisionLink(pool, token))?.connectedNumberId, 42);
});

test('incrementLinkClick recusa quando já consumed', async () => {
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  await markLinkConsumed(pool, token, 1);
  assert.deepEqual(await incrementLinkClick(pool, token), { ok: false, state: 'consumed' });
});

// ── links de RECONEXÃO (alvo + trava de telefone) ────────────────────────────

async function mkReconnect(instance = 'saturno', phone = '+553195950748') {
  const token = generateLinkToken();
  await createReconnectLink(pool, {
    token, targetInstance: instance, targetLabel: 'Saturno', expectedPhone: phone,
    workspaceId: null, createdBy: null, maxClicks: 10, ttlDays: 7,
  });
  return token;
}

test('createReconnectLink grava alvo/telefone e aceita workspace nulo', async () => {
  const token = await mkReconnect();
  const row = await getProvisionLink(pool, token);
  assert.equal(row?.targetInstance, 'saturno');
  assert.equal(row?.expectedPhone, '+553195950748');
  assert.equal(row?.workspaceId, null);
  assert.equal(row?.status, 'active');
});

test('emitir novo link expira o ativo anterior do MESMO alvo', async () => {
  const t1 = await mkReconnect('saturno');
  const outra = await mkReconnect('ws-x-123', '+5531999');
  const t2 = await mkReconnect('saturno');
  assert.equal((await getProvisionLink(pool, t1))?.status, 'expired');
  assert.equal((await getProvisionLink(pool, t2))?.status, 'active');
  assert.equal((await getProvisionLink(pool, outra))?.status, 'active'); // alvo diferente não é tocado
});

test('CHECKs: sem workspace E sem alvo; reconexão sem telefone', async () => {
  await assert.rejects(
    pool.query(`INSERT INTO whatsapp_provision_links (token, max_clicks, expires_at) VALUES ($1, 10, NOW() + interval '7 days')`, [generateLinkToken()]),
    /wpl_target_chk/,
  );
  await assert.rejects(
    pool.query(`INSERT INTO whatsapp_provision_links (token, target_instance, max_clicks, expires_at) VALUES ($1, 'saturno', 10, NOW() + interval '7 days')`, [generateLinkToken()]),
    /wpl_expected_phone_chk/,
  );
});

test('markLinkConsumed aceita numberId nulo', async () => {
  const token = await mkReconnect();
  await markLinkConsumed(pool, token, null);
  const after = await getProvisionLink(pool, token);
  assert.equal(after?.status, 'consumed');
  assert.equal(after?.connectedNumberId, null);
});

test('markLinkConsumed NÃO ressuscita um link blocked', async () => {
  const token = await mkReconnect();
  await pool.query(`UPDATE whatsapp_provision_links SET status='blocked' WHERE token=$1`, [token]);
  await markLinkConsumed(pool, token, null);
  assert.equal((await getProvisionLink(pool, token))?.status, 'blocked');
});

test('settle: telefone bate → consome todos os ativos do alvo', async () => {
  const token = await mkReconnect();
  const r = await settleReconnectLinks(pool, 'saturno', '553195950748@s.whatsapp.net'); // formato jid: normaliza
  assert.deepEqual(r, { kind: 'consumed', count: 1 });
  assert.equal((await getProvisionLink(pool, token))?.status, 'consumed');
});

test('settle: telefone diverge → bloqueia e informa o esperado', async () => {
  const token = await mkReconnect();
  const r = await settleReconnectLinks(pool, 'saturno', '+559999999999');
  assert.equal(r.kind, 'mismatch');
  assert.equal((r as any).expectedPhone, '+553195950748');
  assert.equal((await getProvisionLink(pool, token))?.status, 'blocked');
});

test('settle: sem telefone observável → não consome nem bloqueia', async () => {
  const token = await mkReconnect();
  assert.deepEqual(await settleReconnectLinks(pool, 'saturno', undefined), { kind: 'skipped_no_phone' });
  assert.equal((await getProvisionLink(pool, token))?.status, 'active');
});

test('settle: sem link ativo → none', async () => {
  assert.deepEqual(await settleReconnectLinks(pool, 'inexistente', '+5531000'), { kind: 'none' });
});
