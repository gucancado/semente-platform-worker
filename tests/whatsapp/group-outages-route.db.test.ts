// tests/whatsapp/group-outages-route.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { instanceForScope } from '../../src/whatsapp/group-read-routes.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('escopo agent: a instância É o nome do agente', async () => {
  assert.equal(await instanceForScope(pool, { kind: 'agent', agent: 'saturno' }), 'saturno');
});

test('escopo number: a instância vem de whatsapp_numbers', async () => {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, phone, status)
     VALUES ('ws-1', 'ws-abc-123', '+5531999', 'connected') RETURNING id`,
  );
  assert.equal(
    await instanceForScope(pool, { kind: 'number', numberId: rows[0].id, numberWorkspaceId: 'ws-1', numberPhone: '+5531999' }),
    'ws-abc-123',
  );
});

test('número inexistente → null (a rota devolve lista vazia, não 500)', async () => {
  assert.equal(
    await instanceForScope(pool, { kind: 'number', numberId: 99999, numberWorkspaceId: 'ws-1', numberPhone: null }),
    null,
  );
});
