import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { logWebhook, listUnreadInbox, markInboxRead } from '../src/db.js';

const AGENT = 'saturno';
const GROUP_A = '+120363308683104573'; // grupo do projeto sob auditoria
const GROUP_B = '+120363040049787958'; // outro grupo (ruído)

function msg(identifier: string, eventId: string, text: string) {
  return {
    agent: AGENT,
    channel: 'whatsapp',
    identifier,
    evolution_event_id: eventId,
    payload_summary: text,
    bloquim_task_id: null,
    fallback_used: false,
    instance: 'saturno',
    push_name: 'Fulano',
    message_text: text,
    workspace_id: null,
    author: '+5531999594121',
  };
}

beforeEach(async () => {
  await pool.query('TRUNCATE webhook_logs RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('sem filtro: FIFO global (mais antigas primeiro), mistura grupos', async () => {
  await logWebhook(msg(GROUP_B, 'b1', 'ruido 1'));
  await logWebhook(msg(GROUP_A, 'a1', 'do projeto'));
  await logWebhook(msg(GROUP_B, 'b2', 'ruido 2'));

  const all = await listUnreadInbox(AGENT, 100);
  assert.equal(all.length, 3);
  assert.equal(all[0]!.identifier, GROUP_B); // FIFO: b1 inserido primeiro
});

test('filtro identifier: devolve só as do grupo pedido', async () => {
  await logWebhook(msg(GROUP_B, 'b1', 'ruido 1'));
  await logWebhook(msg(GROUP_A, 'a1', 'do projeto'));
  await logWebhook(msg(GROUP_B, 'b2', 'ruido 2'));

  const onlyA = await listUnreadInbox(AGENT, 100, undefined, GROUP_A);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0]!.identifier, GROUP_A);
  assert.equal(onlyA[0]!.message_text, 'do projeto');
});

test('parede FIFO: ruído além do limite não esconde mensagem do grupo', async () => {
  // 50 mensagens de ruído (grupo B) ANTES da única do grupo A.
  for (let i = 0; i < 50; i++) {
    await logWebhook(msg(GROUP_B, `b${i}`, `ruido ${i}`));
  }
  await logWebhook(msg(GROUP_A, 'a1', 'promessa do projeto'));

  // Sem filtro + limit 10: só ruído (a do grupo A fica fora do teto FIFO).
  const capped = await listUnreadInbox(AGENT, 10);
  assert.equal(capped.length, 10);
  assert.ok(capped.every((m) => m.identifier === GROUP_B));

  // Com filtro: a mensagem do grupo A aparece mesmo com 50 de ruído na frente.
  const onlyA = await listUnreadInbox(AGENT, 10, undefined, GROUP_A);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0]!.message_text, 'promessa do projeto');
});

test('filtro identifier respeita processed_at (não devolve marcadas lidas)', async () => {
  const { id } = await logWebhook(msg(GROUP_A, 'a1', 'já processada'));
  await logWebhook(msg(GROUP_A, 'a2', 'pendente'));
  await markInboxRead(AGENT, id, 'tick-test');

  const onlyA = await listUnreadInbox(AGENT, 100, undefined, GROUP_A);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0]!.message_text, 'pendente');
});

test('instance + identifier combinam', async () => {
  await logWebhook({ ...msg(GROUP_A, 'a1', 'instancia certa'), instance: 'saturno' });
  await logWebhook({ ...msg(GROUP_A, 'a2', 'instancia outra'), instance: 'outra' });

  const r = await listUnreadInbox(AGENT, 100, 'saturno', GROUP_A);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.message_text, 'instancia certa');
});
