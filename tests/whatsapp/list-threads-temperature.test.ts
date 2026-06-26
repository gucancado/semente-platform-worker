import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listThreads } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups, whatsapp_thread_tags RESTART IDENTITY CASCADE');
});
after(() => pool.end());

async function seedThread(numberId: number, ws: string, identifier: string, ts: string, temp?: string) {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [numberId, ws, `inst-${numberId}`],
  );
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,$2,'whatsapp',$3,'inbound','msg',$4)`,
    [numberId, ws, identifier, ts],
  );
  if (temp) {
    await pool.query(
      `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_temperature)
       VALUES ($1,$2,$3) ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET lead_temperature = EXCLUDED.lead_temperature`,
      [numberId, identifier, temp],
    );
  }
}

test('leadTemperature filtra só a temperatura pedida; thread sem meta é excluída', async () => {
  const ws = 'ws-temp-filter';
  await seedThread(1, ws, '+quente', '2026-01-10T00:00:00Z', 'quente');
  await seedThread(1, ws, '+morno',  '2026-01-11T00:00:00Z', 'morno');
  await seedThread(1, ws, '+frio',   '2026-01-12T00:00:00Z', 'frio');
  await seedThread(1, ws, '+sem-meta','2026-01-13T00:00:00Z'); // sem temperatura

  const quentes = await listThreads(pool, { workspaceId: ws, numberId: 1, limit: 50, leadTemperature: 'quente' });
  assert.deepEqual(quentes.threads.map(t => t.identifier), ['+quente']);

  const sem = await listThreads(pool, { workspaceId: ws, numberId: 1, limit: 50 });
  assert.equal(sem.threads.length, 4, 'sem filtro: todas as 4 threads');
});
