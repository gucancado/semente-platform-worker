// tests/whatsapp/search-threads.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { searchThreads } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => { await pool.query('TRUNCATE messages, whatsapp_numbers, whatsapp_groups, whatsapp_thread_meta RESTART IDENTITY CASCADE'); });
after(() => pool.end());

test('searchThreads agrupa por identifier e conta matches', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES
    (1,'ws','whatsapp','c1','inbound','quero orçamento', NOW()),
    (1,'ws','whatsapp','c1','inbound','orçamento urgente', NOW()),
    (1,'ws','whatsapp','c2','inbound','bom dia', NOW())`);
  const { results } = await searchThreads(pool, { workspaceId: 'ws', numberId: 1, query: 'orçamento' });
  assert.equal(results.length, 1);
  assert.equal(results[0].identifier, 'c1');
  assert.equal(results[0].matchCount, 2);
});

/**
 * Janela de CHEGADA (toggle Novas/Todas): a conversa entra se a PRIMEIRA mensagem
 * dela caiu na janela. O caso que importa é a conversa antiga com mensagem recente
 * que casa — ela é hit de busca, mas NÃO é "nova": se `arrivalSince` a deixasse
 * passar, o filtro estaria olhando pra data do match e não pra data da conversa.
 */
test('searchThreads: arrivalSince/Until recortam pela 1ª mensagem da conversa, não pelo match', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES
    (1,'ws','whatsapp','antiga','inbound','oi',            '2026-06-01T12:00:00Z'),
    (1,'ws','whatsapp','antiga','inbound','quero orçamento','2026-08-10T12:00:00Z'),
    (1,'ws','whatsapp','recente','inbound','quero orçamento','2026-08-11T12:00:00Z')`);

  const base = { workspaceId: 'ws', numberId: 1, query: 'orçamento' } as const;

  // Sem janela: as duas.
  const todas = await searchThreads(pool, base);
  assert.deepEqual(todas.results.map(r => r.identifier).sort(), ['antiga', 'recente']);

  // Com janela de agosto: só a que NASCEU em agosto — a antiga tem match em agosto
  // e mesmo assim fica fora.
  const novas = await searchThreads(pool, {
    ...base, arrivalSince: '2026-08-01T00:00:00Z', arrivalUntil: '2026-08-31T23:59:59.999Z',
  });
  assert.deepEqual(novas.results.map(r => r.identifier), ['recente']);

  // Bound aberto pela direita.
  const desdeJulho = await searchThreads(pool, { ...base, arrivalSince: '2026-07-01T00:00:00Z' });
  assert.deepEqual(desdeJulho.results.map(r => r.identifier), ['recente']);
});
