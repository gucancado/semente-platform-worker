import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCloudStatuses } from '../../src/webhook-cloud/parser.js';

// Payload real do teste manual (2026-09-25): status `delivered` da sonda.
const DELIVERED_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '1495675302037643',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: '1151653484698272' },
        statuses: [{
          id: 'wamid.HBgMNTUzMTcxMDcwODk2FQIAERgSQzFCMzFEOEM5RDRGQ0U3MDkwAA==',
          status: 'delivered',
          timestamp: '1758784800',
          recipient_id: '553171070896',
        }],
      },
    }],
  }],
};

test('collectCloudStatuses: extrai id completo, status e errors do payload real', () => {
  const out = collectCloudStatuses(DELIVERED_PAYLOAD);
  assert.deepEqual(out, [
    { id: 'wamid.HBgMNTUzMTcxMDcwODk2FQIAERgSQzFCMzFEOEM5RDRGQ0U3MDkwAA==', status: 'delivered', errors: [] },
  ]);
});

test('collectCloudStatuses: propaga errors crus (sem normalizar)', () => {
  const out = collectCloudStatuses({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          statuses: [{
            id: 'wamid.F1',
            status: 'failed',
            errors: [{ code: 131047, title: 'Re-engagement message', extra: { detail: 'x' } }],
          }],
        },
      }],
    }],
  });
  assert.deepEqual(out, [
    { id: 'wamid.F1', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message', extra: { detail: 'x' } }] },
  ]);
});

test('collectCloudStatuses: várias entries/changes/statuses no mesmo payload', () => {
  const out = collectCloudStatuses({
    object: 'whatsapp_business_account',
    entry: [
      { changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.A', status: 'sent' }] } }] },
      {
        changes: [
          { field: 'messages', value: { statuses: [{ id: 'wamid.B', status: 'read' }, { id: 'wamid.C', status: 'delivered' }] } },
        ],
      },
    ],
  });
  assert.deepEqual(out, [
    { id: 'wamid.A', status: 'sent', errors: [] },
    { id: 'wamid.B', status: 'read', errors: [] },
    { id: 'wamid.C', status: 'delivered', errors: [] },
  ]);
});

test('collectCloudStatuses: payload sem statuses (mensagem normal) devolve vazio', () => {
  const out = collectCloudStatuses({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '5531', id: 'wamid.M', type: 'text' }] } }] }],
  });
  assert.deepEqual(out, []);
});

test('collectCloudStatuses: payload inválido não lança', () => {
  assert.deepEqual(collectCloudStatuses(null), []);
  assert.deepEqual(collectCloudStatuses({ entry: 'x' }), []);
  assert.deepEqual(collectCloudStatuses({ entry: [{ changes: [null] }] }), []);
  assert.deepEqual(collectCloudStatuses({ entry: [{ changes: [{ value: { statuses: [{ status: 'sent' }] } }] }] }), []);
});
