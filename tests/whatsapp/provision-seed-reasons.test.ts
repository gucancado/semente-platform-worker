/**
 * Seed de disqualify-reasons default ao CONECTAR um número.
 *
 * No onboarding QR-first o seed migrou do POST (grava-antes-de-conectar, aposentado)
 * para o commit do staging: quando o webhook `connection.update=open` materializa o
 * número a partir de `whatsapp_provisioning`, ele chama seedDefaultReasons.
 *
 * Requer Postgres real — suíte é server-gated (pnpm typecheck local).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createProvisioning } from '../../src/whatsapp/provisioning.js';
import { handleConnectionEvent } from '../../src/whatsapp/connection-events.js';

/** Workspace isolado para este módulo de testes — sem colisão com outros. */
const WS_SEED_A = 'ws-seed-test-a';
const WS_SEED_B = 'ws-seed-test-b';

/** Simula o onboarding: cria o staging e dispara o webhook open que commita o número. */
async function connectViaStaging(workspaceId: string, instance: string, phone: string) {
  await createProvisioning(pool, { evolutionInstance: instance, workspaceId, createdBy: null, ttlSeconds: 90 });
  await handleConnectionEvent(pool, {
    event: 'connection.update',
    instance,
    data: { state: 'open', wuid: `${phone}@s.whatsapp.net` },
  });
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
  // limpar reasons dos workspaces de teste (não trunca globalmente pra não quebrar outros)
  await pool.query(
    `DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id = ANY($1)`,
    [[WS_SEED_A, WS_SEED_B]]
  );
});

after(() => pool.end());

test('conectar 1º número (commit do staging) → workspace recebe 11 reasons default', async () => {
  await connectViaStaging(WS_SEED_A, 'inst-seed-a', '5531111');

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM whatsapp_disqualify_reasons WHERE workspace_id = $1`,
    [WS_SEED_A]
  );
  assert.equal(rows[0].cnt, 11, `esperava 11 reasons, tinha ${rows[0].cnt}`);
});

test('conectar 2º número no mesmo workspace → ainda 11 (idempotente)', async () => {
  await connectViaStaging(WS_SEED_B, 'inst-seed-b1', '5531111');
  await connectViaStaging(WS_SEED_B, 'inst-seed-b2', '5532222');

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM whatsapp_disqualify_reasons WHERE workspace_id = $1`,
    [WS_SEED_B]
  );
  assert.equal(rows[0].cnt, 11, `idempotência falhou: esperava 11, tinha ${rows[0].cnt}`);
});
