// tests/whatsapp/disqualify-reasons.test.ts
//
// RED: antes de criar src/whatsapp/disqualify-reasons.ts, o import falha →
//   ERR_MODULE_NOT_FOUND / tsc error → suite falha em todos os testes.
// GREEN: com o módulo implementado + typecheck EXIT 0 + Postgres disponível
//   no servidor, todos os asserts passam.
//
// GATE: suite é server-gated (requer Postgres real via DATABASE_URL).
//   Verificação local: pnpm typecheck EXIT 0.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  listDisqualifyReasons,
  upsertDisqualifyReason,
  deactivateDisqualifyReason,
  seedDefaultReasons,
} from '../../src/whatsapp/disqualify-reasons.js';

const WS = 'test-ws-disqualify-reasons';

beforeEach(async () => {
  // Limpa só as linhas do workspace de teste — não trunca defaults globais
  // (whatsapp_disqualify_reason_defaults já foi semeada pela migration 037).
  await pool.query(
    `DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id = $1`,
    [WS]
  );
});

after(() => pool.end());

// ── listDisqualifyReasons ────────────────────────────────────────────────

test('listDisqualifyReasons: retorna só ativos por default', async () => {
  await pool.query(
    `INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
     VALUES ($1,'ativo_a','Ativo A',TRUE),($1,'inativo_b','Inativo B',FALSE)`,
    [WS]
  );
  const result = await listDisqualifyReasons(pool, { workspaceId: WS });
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'ativo_a');
  assert.equal(result[0].active, true);
});

test('listDisqualifyReasons: includeInactive=true retorna todos', async () => {
  await pool.query(
    `INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
     VALUES ($1,'ativo_a','Ativo A',TRUE),($1,'inativo_b','Inativo B',FALSE)`,
    [WS]
  );
  const result = await listDisqualifyReasons(pool, { workspaceId: WS, includeInactive: true });
  assert.equal(result.length, 2);
});

test('listDisqualifyReasons: ordenado por sort_order (defaults primeiro, custom last)', async () => {
  // Seed defaults globais pro workspace (11 rows com sort_order 1-11)
  await seedDefaultReasons(pool, WS);
  // Adiciona código customizado (sem default → sort_order 999)
  await pool.query(
    `INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
     VALUES ($1,'zzz_custom','Custom Z',TRUE)`,
    [WS]
  );
  const result = await listDisqualifyReasons(pool, { workspaceId: WS });
  // Primeiro deve ser o default sort_order=1 (interno_equipe)
  assert.equal(result[0].code, 'interno_equipe');
  assert.equal(result[0].sortOrder, 1);
  // Último deve ser o código customizado (sort_order=999)
  const last = result[result.length - 1];
  assert.equal(last.code, 'zzz_custom');
  assert.equal(last.sortOrder, 999);
});

// ── upsertDisqualifyReason ───────────────────────────────────────────────

test('upsertDisqualifyReason: novo código → reactivated=false', async () => {
  const r = await upsertDisqualifyReason(pool, {
    workspaceId: WS, code: 'novo', label: 'Novo', createdBy: null,
  });
  assert.equal(r.reactivated, false);
  const { rows } = await pool.query(
    `SELECT active FROM whatsapp_disqualify_reasons WHERE workspace_id=$1 AND code=$2`,
    [WS, 'novo']
  );
  assert.equal(rows[0].active, true);
});

test('upsertDisqualifyReason: deactivate + upsert mesmo code → reactivated=true', async () => {
  await upsertDisqualifyReason(pool, {
    workspaceId: WS, code: 'existente', label: 'Existente',
  });
  await deactivateDisqualifyReason(pool, { workspaceId: WS, code: 'existente' });
  // Confirma que ficou inativo
  const { rows: before } = await pool.query(
    `SELECT active FROM whatsapp_disqualify_reasons WHERE workspace_id=$1 AND code=$2`,
    [WS, 'existente']
  );
  assert.equal(before[0].active, false);
  // Reupsert → deve reactivated=true
  const r = await upsertDisqualifyReason(pool, {
    workspaceId: WS, code: 'existente', label: 'Existente v2',
  });
  assert.equal(r.reactivated, true);
  const { rows: after } = await pool.query(
    `SELECT active, label FROM whatsapp_disqualify_reasons WHERE workspace_id=$1 AND code=$2`,
    [WS, 'existente']
  );
  assert.equal(after[0].active, true);
  assert.equal(after[0].label, 'Existente v2');
});

test('upsertDisqualifyReason: relabel de código já ativo → reactivated=false, label atualizado', async () => {
  await upsertDisqualifyReason(pool, {
    workspaceId: WS, code: 'ja_ativo', label: 'Label original',
  });
  const r = await upsertDisqualifyReason(pool, {
    workspaceId: WS, code: 'ja_ativo', label: 'Label novo',
  });
  assert.equal(r.reactivated, false);
  const { rows } = await pool.query(
    `SELECT label FROM whatsapp_disqualify_reasons WHERE workspace_id=$1 AND code=$2`,
    [WS, 'ja_ativo']
  );
  assert.equal(rows[0].label, 'Label novo');
});

// ── deactivateDisqualifyReason ───────────────────────────────────────────

test('deactivateDisqualifyReason: idempotente (já inativo ou ausente não falha)', async () => {
  // Ausente — não deve lançar
  await assert.doesNotReject(
    deactivateDisqualifyReason(pool, { workspaceId: WS, code: 'inexistente' })
  );
  // Já inativo
  await pool.query(
    `INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
     VALUES ($1,'jainativo','Já inativo',FALSE)`,
    [WS]
  );
  await assert.doesNotReject(
    deactivateDisqualifyReason(pool, { workspaceId: WS, code: 'jainativo' })
  );
});

// ── seedDefaultReasons ───────────────────────────────────────────────────

test('seedDefaultReasons: idempotente — 2ª chamada não duplica (count=11)', async () => {
  await seedDefaultReasons(pool, WS);
  await seedDefaultReasons(pool, WS); // segunda chamada
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM whatsapp_disqualify_reasons WHERE workspace_id = $1`,
    [WS]
  );
  assert.equal(rows[0].cnt, 11);
});

test('seedDefaultReasons: todos os defaults ficam ativos', async () => {
  await seedDefaultReasons(pool, WS);
  const { rows } = await pool.query(
    `SELECT code FROM whatsapp_disqualify_reasons WHERE workspace_id=$1 AND active=FALSE`,
    [WS]
  );
  assert.equal(rows.length, 0, 'nenhum default deve vir inativo após seed');
});
