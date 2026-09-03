// tests/whatsapp/reconnect-settle-webhook.db.test.ts (server-gated: requer DATABASE_URL + Postgres real)
//
// O webhook é a ÚNICA autoridade sobre o "open" real: o polling das rotas perde
// um open→close rápido. Estes testes fixam as duas metades da regra — consumir o
// link quando o telefone bate, e bloquear sem gravar nada quando diverge.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { handleConnectionEvent } from '../../src/whatsapp/connection-events.js';
import { createReconnectLink, getProvisionLink, generateLinkToken } from '../../src/whatsapp/provision-links.js';

function openPayload(instance: string, wuid: string) {
  return { event: 'connection.update', instance, data: { state: 'open', wuid } };
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
  await pool.query('TRUNCATE whatsapp_provision_links');
});
after(() => pool.end());

async function mkLink(instance: string, phone: string) {
  const token = generateLinkToken();
  await createReconnectLink(pool, {
    token, targetInstance: instance, targetLabel: null, expectedPhone: phone,
    workspaceId: null, createdBy: null, maxClicks: 10, ttlDays: 7,
  });
  return token;
}

test('open com telefone esperado consome o link e segue o fluxo normal', async () => {
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, phone, evolution_instance, label, status)
     VALUES ('ws-1', '+553195950748', 'saturno', 'Saturno', 'disconnected')`,
  );
  const token = await mkLink('saturno', '+553195950748');
  await handleConnectionEvent(pool, openPayload('saturno', '553195950748@s.whatsapp.net'));
  assert.equal((await getProvisionLink(pool, token))?.status, 'consumed');
  const { rows } = await pool.query(`SELECT status, phone FROM whatsapp_numbers WHERE evolution_instance='saturno'`);
  assert.equal(rows[0].status, 'connected');
  assert.equal(rows[0].phone, '+553195950748');
});

// O logout no mismatch é best-effort contra o EVOLUTION_API_URL do .env.test — a
// falha da chamada HTTP não derruba o teste; o que se asserta é o efeito no banco.
test('open com telefone DIVERGENTE bloqueia o link e NÃO sobrescreve phone/status', async () => {
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, phone, evolution_instance, label, status)
     VALUES ('ws-1', '+553195950748', 'saturno', 'Saturno', 'disconnected')`,
  );
  const token = await mkLink('saturno', '+553195950748');
  await handleConnectionEvent(pool, openPayload('saturno', '559999999999@s.whatsapp.net'));
  assert.equal((await getProvisionLink(pool, token))?.status, 'blocked');
  const { rows } = await pool.query(`SELECT status, phone FROM whatsapp_numbers WHERE evolution_instance='saturno'`);
  assert.equal(rows[0].status, 'disconnected'); // early-return: nada gravado
  assert.equal(rows[0].phone, '+553195950748');
});

test('open de instância de SISTEMA (sem row em whatsapp_numbers) também liquida', async () => {
  const token = await mkLink('saturno', '+553195950748');
  await handleConnectionEvent(pool, openPayload('saturno', '553195950748@s.whatsapp.net'));
  assert.equal((await getProvisionLink(pool, token))?.status, 'consumed');
});

test('open sem link ativo não muda nada (fluxo pré-existente intocado)', async () => {
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, phone, evolution_instance, label, status)
     VALUES ('ws-1', '+5531111', 'ws-1-abc', null, 'disconnected')`,
  );
  await handleConnectionEvent(pool, openPayload('ws-1-abc', '5531111@s.whatsapp.net'));
  const { rows } = await pool.query(`SELECT status FROM whatsapp_numbers WHERE evolution_instance='ws-1-abc'`);
  assert.equal(rows[0].status, 'connected');
});

test('payload sem telefone não consome nem bloqueia (parse falho não derruba reconexão legítima)', async () => {
  const token = await mkLink('saturno', '+553195950748');
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'saturno', data: { state: 'open' } });
  assert.equal((await getProvisionLink(pool, token))?.status, 'active');
});
