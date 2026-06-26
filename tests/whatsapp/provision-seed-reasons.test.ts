/**
 * Task 5: seed de disqualify-reasons default ao provisionar número
 *
 * Requer Postgres real — suíte é server-gated (pnpm typecheck local).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';
import type { EvolutionDeps } from '../../src/evolution/client.js';

/** Workspace isolado para este módulo de testes — sem colisão com outros. */
const WS_SEED_A = 'ws-seed-test-a';
const WS_SEED_B = 'ws-seed-test-b';

function buildApp() {
  const app = Fastify();
  const evolution: EvolutionDeps = {
    baseUrl: 'http://mock', apiKey: 'k',
    fetch: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as any,
  };
  registerProvisionRoutes(app, {
    pool,
    evolution,
    panelToken: 'test-panel',
    webhook: { url: 'https://wk/webhook', secret: 'sek' },
  });
  return app;
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  // limpar reasons dos workspaces de teste (não trunca globalmente pra não quebrar outros)
  await pool.query(
    `DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id = ANY($1)`,
    [[WS_SEED_A, WS_SEED_B]]
  );
});

after(() => pool.end());

test('provisionar 1º número → workspace recebe 11 reasons default', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/whatsapp/numbers',
    headers: { 'x-panel-token': 'test-panel' },
    payload: { workspace_id: WS_SEED_A, label: 'Teste seed' },
  });
  assert.equal(res.statusCode, 201, `esperava 201, recebeu ${res.statusCode}: ${res.body}`);

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM whatsapp_disqualify_reasons WHERE workspace_id = $1`,
    [WS_SEED_A]
  );
  assert.equal(rows[0].cnt, 11, `esperava 11 reasons, tinha ${rows[0].cnt}`);
});

test('provisionar 2º número no mesmo workspace → ainda 11 (idempotente)', async () => {
  const app = buildApp();

  // 1º número
  const r1 = await app.inject({
    method: 'POST',
    url: '/admin/whatsapp/numbers',
    headers: { 'x-panel-token': 'test-panel' },
    payload: { workspace_id: WS_SEED_B, label: 'Número 1' },
  });
  assert.equal(r1.statusCode, 201);

  // 2º número
  const r2 = await app.inject({
    method: 'POST',
    url: '/admin/whatsapp/numbers',
    headers: { 'x-panel-token': 'test-panel' },
    payload: { workspace_id: WS_SEED_B, label: 'Número 2' },
  });
  assert.equal(r2.statusCode, 201);

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM whatsapp_disqualify_reasons WHERE workspace_id = $1`,
    [WS_SEED_B]
  );
  assert.equal(rows[0].cnt, 11, `idempotência falhou: esperava 11, tinha ${rows[0].cnt}`);
});
