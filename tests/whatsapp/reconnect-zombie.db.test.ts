// tests/whatsapp/reconnect-zombie.db.test.ts (server-gated: requer DATABASE_URL + Postgres real)
//
// Zumbi: Evolution diz `open`, mas a sonda de conexão (Task 7) provou que a
// sessão está morta — há um episódio ABERTO em `instance_outages` com
// `started_at_source='probe'` para a instância. Ver spec §7 "Link de reconexão
// para zumbi": o POST derruba a sessão morta (logoutInstance, ação iniciada
// pelo humano ao abrir o link) e segue o fluxo normal de QR; o GET serve o QR
// em vez de consumir o link como "connected". Sem episódio `probe`,
// comportamento atual (inalterado, coberto também em reconnect-links-routes.test.ts).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { pool } from '../../src/db.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';
import type { EvolutionDeps } from '../../src/evolution/client.js';
import { createReconnectLink, getProvisionLink, generateLinkToken } from '../../src/whatsapp/provision-links.js';
import { updateNumberStatus } from '../../src/whatsapp/numbers.js';

function buildApp(opts: { state?: 'open' | 'close'; logoutFails?: boolean; logoutStatus?: number; webhookFails?: boolean } = {}) {
  const state = opts.state ?? 'open';
  const calls: string[] = [];
  const evolution: EvolutionDeps = {
    baseUrl: 'http://mock', apiKey: 'k',
    fetch: (async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (/\/instance\/connectionState\//.test(url)) {
        return { ok: true, status: 200, json: async () => ({ instance: { state } }) } as any;
      }
      if (/\/instance\/logout\//.test(url)) {
        if (opts.logoutFails) return { ok: false, status: opts.logoutStatus ?? 500, json: async () => ({}) } as any;
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }
      if (/\/webhook\/set\//.test(url) && opts.webhookFails) return { ok: false, status: 500, json: async () => ({}) } as any;
      if (/\/instance\/connect\//.test(url)) return { ok: true, status: 200, json: async () => ({ base64: 'data:image/png;base64,QR', pairingCode: 'ABCD1234' }) } as any;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any,
  };
  const app = Fastify();
  registerProvisionRoutes(app, { pool, evolution, panelToken: 'test-panel', webhook: { url: 'https://wk/webhook', secret: 'sek' } });
  return { app, calls };
}

// Variante com estado da Evolution MUTÁVEL após o app já montado — para o caso
// "2ª chamada, sessão já caiu de verdade (close), sem novo logout".
function buildAppMutableState() {
  let state: 'open' | 'close' = 'open';
  const calls: string[] = [];
  const evolution: EvolutionDeps = {
    baseUrl: 'http://mock', apiKey: 'k',
    fetch: (async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (/\/instance\/connectionState\//.test(url)) {
        return { ok: true, status: 200, json: async () => ({ instance: { state } }) } as any;
      }
      if (/\/instance\/logout\//.test(url)) return { ok: true, status: 200, json: async () => ({}) } as any;
      if (/\/instance\/connect\//.test(url)) return { ok: true, status: 200, json: async () => ({ base64: 'data:image/png;base64,QR', pairingCode: 'ABCD1234' }) } as any;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any,
  };
  const app = Fastify();
  registerProvisionRoutes(app, { pool, evolution, panelToken: 'test-panel', webhook: { url: 'https://wk/webhook', secret: 'sek' } });
  return { app, calls, setState: (s: 'open' | 'close') => { state = s; } };
}

// Pool que erra numa query específica (a de `openProbeEpisodeOf`) e delega o
// resto ao pool real — para provar que uma falha de BANCO no GET não sai
// rotulada 'evolution_unavailable'.
function poolFailingOnProbeQuery(): Pool {
  return {
    query: (text: any, params?: any) => {
      const sql = typeof text === 'string' ? text : text?.text ?? '';
      if (/FROM instance_outages/.test(sql) && /started_at_source = 'probe'/.test(sql)) {
        return Promise.reject(new Error('boom-db'));
      }
      return pool.query(text, params);
    },
  } as unknown as Pool;
}

const H = { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' };

async function mkReconnect(instance = 'saturno', maxClicks = 10) {
  const token = generateLinkToken();
  await createReconnectLink(pool, {
    token, targetInstance: instance, targetLabel: 'Saturno', expectedPhone: '+553195950748',
    workspaceId: null, createdBy: null, maxClicks, ttlDays: 7,
  });
  return token;
}

// Episódio `probe` aberto = a marca de zumbi. `kind='system'` (número null) é
// suficiente — `openProbeEpisodeOf` casa só por `instance` + `ended_at IS NULL`
// + `started_at_source='probe'`, sem olhar `kind`.
async function mkZombieEpisode(instance: string) {
  await pool.query(
    `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
     VALUES ($1, 'system', NULL, NOW() - interval '5 minutes', 'probe', 'quiet', 'probe')`,
    [instance],
  );
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
  await pool.query('TRUNCATE whatsapp_provision_links');
  await pool.query('TRUNCATE instance_outages RESTART IDENTITY CASCADE');
});
after(() => pool.end());

// ── POST /link/:token/reconnect — zumbi ──────────────────────────────────────

test('POST com open + episódio probe aberto: derruba a sessão (logout), NÃO consome, conta o clique', async () => {
  const { app, calls } = buildApp({ state: 'open' });
  const token = await mkReconnect();
  await mkZombieEpisode('saturno');

  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().instance, 'saturno');
  assert.ok(calls.some((c) => c.includes('DELETE') && c.includes('/instance/logout/saturno')), calls.join(' | '));
  assert.ok(calls.some((c) => c.includes('/webhook/set/saturno')), calls.join(' | ')); // seguiu o fluxo normal de QR

  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'active'); // NÃO consumido
  assert.equal(link?.clicksUsed, 1); // conta o clique como o fluxo normal
});

test('POST com open + probe: falha no logout → 502 evolution_unavailable, sem consumir nem gastar clique', async () => {
  const { app, calls } = buildApp({ state: 'open', logoutFails: true });
  const token = await mkReconnect();
  await mkZombieEpisode('saturno');

  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });

  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'evolution_unavailable');
  assert.ok(!calls.some((c) => c.includes('/webhook/set/')), calls.join(' | ')); // não seguiu adiante

  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'active');
  assert.equal(link?.clicksUsed, 0);
});

test('POST zumbi marca whatsapp_numbers.disconnected; a reconexão real que chegar depois fecha o episódio probe', async () => {
  // Simula o caso descrito na review: status ficou 'connected' (o webhook de
  // 'close' do logout se perdeu). Sem a marcação síncrona, a reconexão real
  // chegaria com old_status='connected' de novo e updateNumberStatus não
  // fecharia o episódio probe (só fecha quando old_status ≠ 'connected').
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, phone, evolution_instance, label, status)
     VALUES ('ws-1', '+553195950748', 'saturno', 'Saturno', 'connected')`,
  );
  const { app } = buildApp({ state: 'open' });
  const token = await mkReconnect();
  await mkZombieEpisode('saturno');

  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.equal(res.statusCode, 200);

  const { rows: afterLogout } = await pool.query(`SELECT status FROM whatsapp_numbers WHERE evolution_instance='saturno'`);
  assert.equal(afterLogout[0].status, 'disconnected');

  // Reconexão real, mais tarde (o que o webhook `connection.update` faria).
  await updateNumberStatus(pool, 'saturno', { status: 'connected', phone: '+553195950748' });

  const { rows: outage } = await pool.query(
    `SELECT ended_at FROM instance_outages WHERE instance='saturno' AND started_at_source='probe'`,
  );
  assert.equal(outage.length, 1);
  assert.ok(outage[0].ended_at != null, 'episódio probe deveria estar fechado após a reconexão real');
});

test('POST zumbi + logout 404 (instância sumiu na Evolution) → instance_not_found, mesmo mapeamento do state check', async () => {
  const { app, calls } = buildApp({ state: 'open', logoutFails: true, logoutStatus: 404 });
  const token = await mkReconnect();
  await mkZombieEpisode('saturno');

  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'instance_not_found');
  assert.ok(!calls.some((c) => c.includes('/webhook/set/')), calls.join(' | '));
  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'active');
  assert.equal(link?.clicksUsed, 0);
});

test('POST open + episódio de OUTRA fonte (webhook, não probe) NÃO é zumbi: comportamento atual', async () => {
  const { app, calls } = buildApp({ state: 'open' });
  const token = await mkReconnect();
  await pool.query(
    `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
     VALUES ('saturno', 'system', NULL, NOW() - interval '5 minutes', 'webhook', 'connection_update', 'webhook')`,
  );

  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });

  assert.equal(res.json().state, 'connected');
  assert.ok(!calls.some((c) => c.includes('/instance/logout/')), calls.join(' | '));
  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'consumed');
});

test('POST: 2ª chamada já com a sessão realmente close (sem novo logout) — fluxo normal de QR', async () => {
  const { app, calls, setState } = buildAppMutableState();
  const token = await mkReconnect();
  await mkZombieEpisode('saturno');

  setState('open');
  const first = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.equal(first.statusCode, 200);

  calls.length = 0;
  setState('close'); // agora a Evolution já reflete o logout do humano
  const second = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });

  assert.equal(second.statusCode, 200);
  assert.equal(second.json().instance, 'saturno');
  assert.ok(!calls.some((c) => c.includes('/instance/logout/')), calls.join(' | ')); // não repete o logout
  const link = await getProvisionLink(pool, token);
  assert.equal(link?.clicksUsed, 2); // 1ª (zumbi) + 2ª (normal) contam igual
});

test('POST com open SEM episódio probe: comportamento atual — consome o link, sem gastar clique', async () => {
  const { app } = buildApp({ state: 'open' });
  const token = await mkReconnect();
  // nenhum episódio criado

  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });

  assert.equal(res.json().state, 'connected');
  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'consumed');
  assert.equal(link?.clicksUsed, 0);
});

// ── GET /link/:token/reconnect/:instance — zumbi ─────────────────────────────

test('GET com open + episódio probe aberto: serve QR (NÃO consome como connected)', async () => {
  const { app, calls } = buildApp({ state: 'open' });
  const token = await mkReconnect();
  await mkZombieEpisode('saturno');

  const res = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H });

  assert.equal(res.json().state, 'awaiting_scan');
  assert.ok(res.json().qr);
  assert.ok(calls.some((c) => c.includes('/instance/connect/saturno')), calls.join(' | '));

  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'active'); // NÃO consumido
});

test('GET com open SEM episódio probe: comportamento atual — marca consumed/connected', async () => {
  const { app } = buildApp({ state: 'open' });
  const token = await mkReconnect();

  const res = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H });

  assert.equal(res.json().state, 'connected');
  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'consumed');
});

test('GET com falha de BANCO ao consultar episódio de sonda → 500 internal_error (NUNCA evolution_unavailable)', async () => {
  const evolution: EvolutionDeps = {
    baseUrl: 'http://mock', apiKey: 'k',
    fetch: (async () => ({ ok: true, status: 200, json: async () => ({ instance: { state: 'open' } }) })) as any,
  };
  const app = Fastify();
  registerProvisionRoutes(app, { pool: poolFailingOnProbeQuery(), evolution, panelToken: 'test-panel', webhook: { url: 'https://wk/webhook', secret: 'sek' } });
  const token = await mkReconnect();

  const res = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H });

  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'internal_error');
});
