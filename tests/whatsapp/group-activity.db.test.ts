import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { lastMessageByAuthor } from '../../src/whatsapp/group-activity.js';

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_groups, whatsapp_group_participants, whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

const JID = '+120363000000000001';

async function seedAgentMessage(author: string, createdAt: string) {
  await pool.query(
    `INSERT INTO messages (agent, channel, identifier, direction, text, author, created_at)
     VALUES ('saturno', 'whatsapp', $1, 'inbound', 'oi', $2, $3)`,
    [JID, author, createdAt],
  );
}

test('agrega o MAX por autor no escopo agent', async () => {
  await seedAgentMessage('+553196039118', '2026-09-01T10:00:00Z');
  await seedAgentMessage('+553196039118', '2026-09-10T10:00:00Z');
  await seedAgentMessage('+553171070896', '2026-09-05T10:00:00Z');
  const m = await lastMessageByAuthor(pool, { scope: { kind: 'agent', agent: 'saturno' }, identifier: JID });
  assert.equal(m.get('553196039118'), '2026-09-10T10:00:00.000Z');
  assert.equal(m.get('553171070896'), '2026-09-05T10:00:00.000Z');
});

test('não vaza mensagem de OUTRO grupo nem de escopo number', async () => {
  await seedAgentMessage('+553196039118', '2026-09-10T10:00:00Z');
  // ⚠️ `messages.whatsapp_number_id` TEM FK para `whatsapp_numbers(id)`
  // (migration 026). Um id inventado violaria a FK e o teste falharia por um
  // motivo que não é o que ele afirma — semeie o número de verdade.
  const { rows: num } = await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, phone, status)
     VALUES ('ws-1', 'i-outro', '+5531988887777', 'connected') RETURNING id`,
  );
  await pool.query(
    `INSERT INTO messages (agent, channel, identifier, direction, text, author, created_at, whatsapp_number_id)
     VALUES ('saturno', 'whatsapp', $1, 'inbound', 'oi', '+553199999999', '2026-09-11T10:00:00Z', $2)`,
    [JID, num[0].id],
  );
  const m = await lastMessageByAuthor(pool, { scope: { kind: 'agent', agent: 'saturno' }, identifier: JID });
  assert.equal(m.has('553199999999'), false, 'linha number-scoped não entra no escopo agent');
  assert.equal(m.size, 1);
});
