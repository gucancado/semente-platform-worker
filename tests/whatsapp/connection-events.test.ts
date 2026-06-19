import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { handleConnectionEvent } from '../../src/whatsapp/connection-events.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('connection.update open marca connected + phone; é no-op se instância desconhecida', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, status) VALUES ('ws-1','inst-1','connecting')`);
  const handled = await handleConnectionEvent(pool, { event: 'connection.update', instance: 'inst-1', data: { state: 'open', wuid: '5531999@s.whatsapp.net' } });
  assert.equal(handled, true);
  const { rows } = await pool.query(`SELECT status, phone FROM whatsapp_numbers WHERE evolution_instance='inst-1'`);
  assert.equal(rows[0].status, 'connected');
  assert.equal(rows[0].phone, '+5531999');
  // instância desconhecida: tratado (true) mas sem erro
  assert.equal(await handleConnectionEvent(pool, { event: 'connection.update', instance: 'ghost', data: { state: 'open' } }), true);
});

test('messages.upsert não é evento de instância → retorna false', async () => {
  assert.equal(await handleConnectionEvent(pool, { event: 'messages.upsert', instance: 'inst-1', data: {} }), false);
});
