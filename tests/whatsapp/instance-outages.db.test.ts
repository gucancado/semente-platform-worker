// tests/whatsapp/instance-outages.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listOutagesByInstance } from '../../src/whatsapp/instance-outages.js';

// ⚠️ `whatsapp_numbers` entra no TRUNCATE porque os dois testes de CHECK abaixo
// semeiam números REAIS (a FK exige). Sem isso a linha `i-sys` sobra — nada a
// apaga — e a SEGUNDA execução da suíte contra o mesmo banco falha no UNIQUE de
// `evolution_instance`, num INSERT de fixture que roda solto, fora do
// `assert.rejects`. O erro se parece com regressão de lógica e não é. Medido:
// depois de uma execução, `count(*) WHERE evolution_instance IN ('i-sys','i-del')`
// = 1. CASCADE porque muitas tabelas referenciam `whatsapp_numbers`.
beforeEach(async () => {
  await pool.query('TRUNCATE instance_outages, whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

const open = (instance: string, startedAt: string) => pool.query(
  `INSERT INTO instance_outages (instance, kind, started_at, started_at_source, detected_by)
   VALUES ($1, 'system', $2, 'detected_now', 'watch')
   ON CONFLICT (instance) WHERE ended_at IS NULL DO NOTHING`,
  [instance, startedAt],
);

test('só UM episódio aberto por instância', async () => {
  await open('saturno', '2026-09-09T18:10:00Z');
  await open('saturno', '2026-09-09T18:15:00Z');
  const { rows } = await pool.query(`SELECT count(*)::int c FROM instance_outages WHERE ended_at IS NULL`);
  assert.equal(rows[0].c, 1, 'a segunda abertura colide e é descartada');
});

test('fechado libera espaço para o episódio seguinte', async () => {
  await open('saturno', '2026-09-09T18:10:00Z');
  await pool.query(`UPDATE instance_outages SET ended_at = '2026-09-13T11:18:00Z' WHERE instance='saturno' AND ended_at IS NULL`);
  await open('saturno', '2026-09-14T08:00:00Z');
  assert.equal((await listOutagesByInstance(pool, 'saturno')).length, 2);
});

test('janela invertida é recusada pelo CHECK', async () => {
  await assert.rejects(() => pool.query(
    `INSERT INTO instance_outages (instance, kind, started_at, started_at_source, detected_by, ended_at)
     VALUES ('x', 'system', '2026-09-10T00:00:00Z', 'detected_now', 'watch', '2026-09-09T00:00:00Z')`,
  ), /instance_outages_window_chk/);
});

test('episódio de SISTEMA não pode carregar number_id', async () => {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, phone, status)
     VALUES ('ws-1','i-sys','+5531900000000','connected') RETURNING id`,
  );
  await assert.rejects(() => pool.query(
    `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, detected_by)
     VALUES ('x', 'system', $1, NOW(), 'detected_now', 'watch')`,
    [rows[0].id],
  ), /instance_outages_kind_chk/);
});

test('apagar o número PRESERVA o histórico com number_id nulo', async () => {
  // Regressão: com o CHECK estrito (`kind='number' AND number_id IS NOT NULL`),
  // o UPDATE disparado por ON DELETE SET NULL violava o próprio CHECK e ABORTAVA
  // a deleção — o oposto de preservar histórico, e pior que CASCADE. Medido antes
  // do fix: "violates check constraint instance_outages_kind_chk" no
  // "UPDATE ONLY ... SET number_id = NULL".
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, phone, status)
     VALUES ('ws-1','i-del','+5531911111111','connected') RETURNING id`,
  );
  await pool.query(
    `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, detected_by)
     VALUES ('i-del', 'number', $1, NOW(), 'webhook', 'webhook')`,
    [rows[0].id],
  );
  await pool.query(`DELETE FROM whatsapp_numbers WHERE id = $1`, [rows[0].id]);
  const { rows: after } = await pool.query(
    `SELECT number_id, kind FROM instance_outages WHERE instance = 'i-del'`,
  );
  assert.equal(after.length, 1, 'o episódio sobrevive à remoção do número');
  assert.equal(after[0].number_id, null);
  assert.equal(after[0].kind, 'number');
});

test('listOutagesByInstance devolve do mais recente pro mais antigo', async () => {
  await open('saturno', '2026-08-01T00:00:00Z');
  await pool.query(`UPDATE instance_outages SET ended_at = '2026-08-02T00:00:00Z' WHERE ended_at IS NULL`);
  await open('saturno', '2026-09-01T00:00:00Z');
  const rows = await listOutagesByInstance(pool, 'saturno');
  assert.equal(rows[0].startedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(rows[1].endedAt, '2026-08-02T00:00:00.000Z');
});
