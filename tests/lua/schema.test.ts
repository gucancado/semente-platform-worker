import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

const tables = ['lua_runs', 'lua_processing', 'episode_chunks', 'facts',
  'condutas', 'conduta_rules', 'conduta_rule_sources', 'recaps', 'recap_sources',
  'project_status', 'project_status_sources'];

test('020-022: tabelas da Lua existem', async () => {
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE tablename = ANY($1)`, [tables]);
  assert.equal(rows.length, tables.length);
});

test('021: facts tem CHECK de invalidacao acoplada', async () => {
  // Insere um episodio descartavel para satisfazer a FK episode_id NOT NULL.
  // Schema real de episodes (015): NOT NULL = fonte, external_source, external_id, occurred_at.
  const ep = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, occurred_at)
     VALUES ('reuniao', 'test-schema', 'chk-' || gen_random_uuid()::text, NOW())
     RETURNING id`);
  const episodeId = ep.rows[0].id as number;
  // invalid_at setado SEM invalidation_reason => facts_invalidation_chk deve rejeitar.
  await assert.rejects(() => pool.query(
    `INSERT INTO facts (workspace_id, fact_type, statement, confidence, valid_at, invalid_at,
      episode_id, episode_revision, turn_start, turn_end, embedding, embedding_model, extracted_by)
     VALUES ('w', 'decisao', 'x', 0.9, NOW(), NOW(),
      $1, 1, 0, 1,
      array_fill(0, ARRAY[1024])::vector, 'm', 't')`, [episodeId]),
    /facts_invalidation_chk/);
  // limpeza do episodio descartavel (cascade nao deixa fatos pois o INSERT falhou)
  await pool.query(`DELETE FROM episodes WHERE id = $1`, [episodeId]);
});

test('022: indice parcial garante 1 conduta ativa por workspace', async () => {
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_condutas_one_active'`);
  assert.equal(rows.length, 1);
});

test('023: trigger de propagacao existe', async () => {
  const { rows } = await pool.query(
    `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_lua_propagate_workspace'`);
  assert.equal(rows.length, 1);
});

test.after(async () => { await pool.end(); });
