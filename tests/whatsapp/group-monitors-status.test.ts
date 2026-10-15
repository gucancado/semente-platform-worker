import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMonitorStatus } from '../../src/whatsapp/group-monitors-status.js';

test('episódio aberto manda', () => {
  assert.deepEqual(deriveMonitorStatus({ openOutageStartedAt: '2026-10-13T23:27:38.000Z', numberStatus: null, numberDisconnectedSince: null, isNumber: false }),
    { status: 'disconnected', since: '2026-10-13T23:27:38.000Z' });
});
test('número fora sem episódio (pré-mig 066) usa disconnected_since', () => {
  assert.deepEqual(deriveMonitorStatus({ openOutageStartedAt: null, numberStatus: 'connecting', numberDisconnectedSince: '2026-08-18T18:13:15.000Z', isNumber: true }),
    { status: 'disconnected', since: '2026-08-18T18:13:15.000Z' });
});
test('número connected e sem episódio = conectado', () => {
  assert.deepEqual(deriveMonitorStatus({ openOutageStartedAt: null, numberStatus: 'connected', numberDisconnectedSince: null, isNumber: true }),
    { status: 'connected', since: null });
});
test('instância de sistema sem episódio = conectado', () => {
  assert.deepEqual(deriveMonitorStatus({ openOutageStartedAt: null, numberStatus: null, numberDisconnectedSince: null, isNumber: false }),
    { status: 'connected', since: null });
});
