import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listThreads } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups, whatsapp_thread_tags RESTART IDENTITY CASCADE');
});
after(() => pool.end());

// Insere uma thread com UM msg num timestamp µs-exato (string com 6 casas).
async function seedAtMicros(numberId: number, ws: string, identifier: string, tsMicros: string) {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [numberId, ws, `inst-${numberId}`],
  );
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,$2,'whatsapp',$3,'inbound','msg',$4::timestamptz)`,
    [numberId, ws, identifier, tsMicros],
  );
}

test('cursor µs/ms: 4 threads no mesmo ms (µs distintos) paginam sem perder nem duplicar', async () => {
  const ws = 'ws-cursor-ms';
  // Mesmo milissegundo 10:00:00.123, µs distintos. Ordenação esperada (last_at DESC):
  // .123400 > .123300 > .123200 > .123100
  await seedAtMicros(1, ws, '+d', '2026-01-10T10:00:00.123400Z');
  await seedAtMicros(1, ws, '+c', '2026-01-10T10:00:00.123300Z');
  await seedAtMicros(1, ws, '+b', '2026-01-10T10:00:00.123200Z');
  await seedAtMicros(1, ws, '+a', '2026-01-10T10:00:00.123100Z');

  const page1 = await listThreads(pool, { workspaceId: ws, numberId: 1, limit: 2 });
  assert.equal(page1.threads.length, 2, 'page1 com 2 threads');
  assert.ok(page1.nextCursor, 'page1 tem cursor');

  const page2 = await listThreads(pool, { workspaceId: ws, numberId: 1, limit: 2, cursor: page1.nextCursor! });

  const allIds = [...page1.threads, ...page2.threads].map(t => t.identifier).sort();
  assert.deepEqual(allIds, ['+a', '+b', '+c', '+d'], 'união das páginas = todas as 4 threads, sem perda/duplicata');

  // Garantia extra: sem duplicatas
  const unique = new Set(allIds);
  assert.equal(unique.size, 4, 'nenhuma thread duplicada entre páginas');
});
