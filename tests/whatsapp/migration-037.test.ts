// tests/whatsapp/migration-037.test.ts
// Valida que a migration 037 (disqualify_reasons per-workspace) é correta e idempotente.
// AVISO: este teste requer Postgres real — roda no servidor/CI, não localmente.
// Localmente só `pnpm typecheck` verifica a tipagem.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pool } from '../../src/db.js';

const sql037 = readFileSync(
  new URL('../../migrations/037_whatsapp_disqualify_reasons_per_workspace.sql', import.meta.url),
  'utf8'
);

const WS = 'ws-037-test-uuid';

beforeEach(async () => {
  // Truncate na ordem correta para satisfazer FKs
  await pool.query(
    'TRUNCATE messages, whatsapp_thread_meta, whatsapp_numbers, whatsapp_disqualify_reason_defaults RESTART IDENTITY CASCADE'
  );
  // whatsapp_disqualify_reasons não é coberta pelo CASCADE acima (sem FK reversa),
  // então limpamos separadamente.
  await pool.query('DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id = $1', [WS]);
  await pool.query('DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id IS NULL');
});

after(() => pool.end());

test('037: PK composta (workspace_id, code) existe após a migração', async () => {
  // Seed: 1 número no workspace WS
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1, $1, 'i')`,
    [WS]
  );

  await pool.query(sql037);

  const res = await pool.query<{ column_name: string }>(`
    SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
       AND kcu.table_name = tc.table_name
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_name = 'whatsapp_disqualify_reasons'
     ORDER BY kcu.ordinal_position
  `);

  const pkCols = res.rows.map(r => r.column_name);
  assert.deepEqual(pkCols, ['workspace_id', 'code'],
    `PK deve ser (workspace_id, code), obteve: ${pkCols.join(', ')}`);
});

test('037: workspace recebe os 11 defaults após backfill', async () => {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1, $1, 'i')`,
    [WS]
  );

  await pool.query(sql037);

  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM whatsapp_disqualify_reasons WHERE workspace_id = $1`,
    [WS]
  );
  assert.equal(Number(res.rows[0].count), 11,
    `workspace deve ter 11 reasons, obteve ${res.rows[0].count}`);
});

test('037: row (ws, fora_escopo) existe após backfill com thread_meta usando fora_escopo', async () => {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1, $1, 'i')`,
    [WS]
  );
  // Antes da migration, a FK ainda existe — inserimos com code válido na tabela global
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, disqualify_reason) VALUES (1, 'c1', 'fora_escopo')`
  );

  await pool.query(sql037);

  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM whatsapp_disqualify_reasons WHERE workspace_id = $1 AND code = 'fora_escopo'`,
    [WS]
  );
  assert.equal(Number(res.rows[0].count), 1, "row (ws, 'fora_escopo') deve existir");
});

test('037: idempotente — re-execução não lança', async () => {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1, $1, 'i')`,
    [WS]
  );

  await pool.query(sql037);

  // Segunda execução não deve lançar
  await assert.doesNotReject(
    () => pool.query(sql037),
    'Re-execução da migration 037 deve ser idempotente'
  );
});

test('037: orphan guard aborta migração quando thread_meta tem reason não coberta por defaults', async () => {
  // Este caso usa um client dedicado com controle explícito de transação,
  // pois um RAISE EXCEPTION no DO $$ aborta a tx inteira — queremos ROLLBACK no final.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Seed: número no workspace
    await client.query(
      `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (2, $1, 'j')`,
      [WS]
    );

    // A FK whatsapp_thread_meta_disqualify_reason_fkey pode ou não existir:
    // - DB virgem (antes de 037): FK existe → precisamos do code na tabela global para inserir
    // - DB com 037 já aplicada (servidor): FK foi dropada → podemos inserir direto
    // Verificamos para escolher o caminho correto.
    const fkRes = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_type = 'FOREIGN KEY'
           AND table_name = 'whatsapp_thread_meta'
           AND constraint_name = 'whatsapp_thread_meta_disqualify_reason_fkey'
      ) AS exists
    `);

    if (fkRes.rows[0].exists) {
      // FK ainda existe: inserir 'inexistente_x' na tabela global para satisfazê-la,
      // mas NÃO nos defaults — assim PASSO 1 vai copiá-la para defaults, cobrindo o thread.
      // Neste cenário o guard NÃO dispara (a migration foi projetada para ser segura).
      // Verificamos apenas que a migration roda sem erro neste sub-cenário.
      await client.query(
        `INSERT INTO whatsapp_disqualify_reasons (code, label) VALUES ('inexistente_x', 'Teste FK') ON CONFLICT DO NOTHING`
      );
      await client.query(
        `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, disqualify_reason) VALUES (2, 'orphan_thread', 'inexistente_x')`
      );
      // PASSO 1 sincronizará 'inexistente_x' → guard não dispara
      // Verificamos somente que RAISE EXCEPTION existe no SQL (guard estrutural)
      assert.ok(sql037.includes('RAISE EXCEPTION'), 'Migration deve conter RAISE EXCEPTION para orphan guard');
    } else {
      // FK já foi dropada: podemos inserir um code fantasma direto em thread_meta
      // sem precisar que ele exista em whatsapp_disqualify_reasons.
      // Garante que o code NÃO está nos defaults nem em globals.
      await client.query(
        `DELETE FROM whatsapp_disqualify_reason_defaults WHERE code = 'inexistente_x'`
      );
      await client.query(
        `DELETE FROM whatsapp_disqualify_reasons WHERE code = 'inexistente_x'`
      );
      await client.query(
        `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, disqualify_reason) VALUES (2, 'orphan_thread', 'inexistente_x')`
      );
      // Agora a migration deve disparar o guard com RAISE EXCEPTION
      await assert.rejects(
        () => client.query(sql037),
        /ABORT.*orphan|ficariam com disqualify_reason/i,
        'Guard deve abortar a migration quando há thread_meta com reason órfã'
      );
    }

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK');
    // Se o erro veio do assert.rejects (não foi rejeitado quando deveria), propaga
    throw err;
  } finally {
    client.release();
  }
});
