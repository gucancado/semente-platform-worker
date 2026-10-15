import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMonitorStatus, listMonitorStatus } from '../../src/whatsapp/group-monitors-status.js';

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

test('número com status null = desconectado', () => {
  assert.deepEqual(deriveMonitorStatus({ openOutageStartedAt: null, numberStatus: null, numberDisconnectedSince: null, isNumber: true }),
    { status: 'disconnected', since: null });
});

test('falha na leitura de um slot = unknown; os outros seguem', async () => {
  const pool: any = {
    query: async (sql: string, args?: any[]) => {
      if (sql.includes('FROM group_monitors')) return { rows: [{ slot: 'A', instance: 'ia', phone: '1' }, { slot: 'B', instance: 'ib', phone: '2' }] };
      if (args?.[0] === 'ia') throw new Error('boom');
      return { rows: [{ open_started: null, number_id: null, last_msg: null }] };
    },
  };
  const out = await listMonitorStatus(pool);
  assert.equal(out[0].status, 'unknown');
  assert.equal(out[0].label, 'Monitor de grupos A');
  assert.equal(out[1].status, 'connected');
});

test('falha na query de slots propaga', async () => {
  await assert.rejects(listMonitorStatus({ query: async () => { throw new Error('x'); } } as any));
});
