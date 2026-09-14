import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCloudPayload } from '../../src/webhook-cloud/parser.js';

test('status de falha: código e título do erro, telefone truncado', () => {
  const s = summarizeCloudPayload({
    object: 'whatsapp_business_account',
    entry: [{
      id: '1495675302037643',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '1151653484698272' },
          statuses: [{
            id: 'wamid.X',
            status: 'failed',
            recipient_id: '553199594121',
            errors: [{ code: 131047, title: 'Re-engagement message' }],
          }],
        },
      }],
    }],
  });
  assert.deepEqual(s, {
    object: 'whatsapp_business_account',
    changes: [{
      field: 'messages',
      phoneNumberId: '1151653484698272',
      statuses: [{ id: 'wamid.X', status: 'failed', recipientTail: '4121', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
      messages: [],
      contactKeys: [],
    }],
  });
});

test('mensagem: só tipo e nomes de campo, nunca o texto nem o telefone', () => {
  const s = summarizeCloudPayload({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '1151653484698272' },
          contacts: [{ wa_id: '553199594121', profile: { name: 'Gustavo' } }],
          messages: [{ from: '553199594121', id: 'wamid.Y', type: 'text', text: { body: 'oi segredo' } }],
        },
      }],
    }],
  });
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /oi segredo|553199594121|Gustavo/);
  assert.deepEqual(s.changes[0].messages, [{ type: 'text', hasFrom: true, keys: ['from', 'id', 'text', 'type'] }]);
  assert.deepEqual(s.changes[0].contactKeys, ['profile', 'wa_id']);
});

test('mensagem sem `from` fica visível no resumo (mudança de formato da Meta)', () => {
  const s = summarizeCloudPayload({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.Z', type: 'text', from_user_id: 'BR.123' }] } }] }],
  });
  assert.equal(s.changes[0].messages[0].hasFrom, false);
  assert.deepEqual(s.changes[0].messages[0].keys, ['from_user_id', 'id', 'type']);
});

test('payload inválido não lança', () => {
  assert.deepEqual(summarizeCloudPayload(null), { object: null, changes: [] });
  assert.deepEqual(summarizeCloudPayload({ entry: 'x' }), { object: null, changes: [] });
  assert.deepEqual(summarizeCloudPayload({ entry: [{ changes: [null] }] }).changes[0].statuses, []);
});
