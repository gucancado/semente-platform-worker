import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planMonitorIngest, buildMonitorCopy, monitorForInstance, monitorLabel,
  loadMonitors, invalidateMonitors, MONITOR_AGENT,
} from '../../src/whatsapp/group-monitors.js';

test('planMonitorIngest: não-monitor nunca muda nada', () => {
  assert.equal(planMonitorIngest({ isMonitor: false, isGroup: false, hasMonitorRow: false, hasText: true }), 'none');
  assert.equal(planMonitorIngest({ isMonitor: false, isGroup: true, hasMonitorRow: true, hasText: true }), 'none');
});
test('planMonitorIngest: DM de monitor é descartada, com ou sem texto', () => {
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: false, hasMonitorRow: false, hasText: true }), 'drop_dm');
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: false, hasMonitorRow: false, hasText: false }), 'drop_dm');
});
test('planMonitorIngest: grupo copia só com linha do monitor E texto', () => {
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: true, hasMonitorRow: true, hasText: true }), 'copy');
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: true, hasMonitorRow: false, hasText: true }), 'none');
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: true, hasMonitorRow: true, hasText: false }), 'none');
});
test('buildMonitorCopy: autor ausente vira telefone do monitor', () => {
  const r = buildMonitorCopy({ channel: 'whatsapp', identifier: '+120363', author: null, text: 'oi', eventId: 'E1', monitorPhone: '+553196039118' });
  assert.deepEqual(r, { agent: MONITOR_AGENT, channel: 'whatsapp', identifier: '+120363', author: '+553196039118', text: 'oi', evolution_event_id: 'E1' });
  assert.equal(buildMonitorCopy({ channel: 'whatsapp', identifier: '+1', author: '+5511', text: 'x', eventId: 'E', monitorPhone: '+55' }).author, '+5511');
});
test('monitorForInstance / monitorLabel', () => {
  const ms = [{ slot: 'A' as const, instance: 'saturno', phone: '+1' }, { slot: 'B' as const, instance: 'ws-x', phone: '+2' }];
  assert.equal(monitorForInstance(ms, 'ws-x')?.slot, 'B');
  assert.equal(monitorForInstance(ms, 'ws-y'), null);
  assert.equal(monitorLabel('B'), 'Monitor de grupos B');
});
test('loadMonitors: cacheia 30s e sobrevive a erro de query', async () => {
  invalidateMonitors();
  let calls = 0; let fail = false; const t = 0;
  const pool = { query: async () => { calls++; if (fail) throw new Error('boom'); return { rows: [{ slot: 'A', instance: 'saturno', phone: '+1' }] }; } } as any;
  assert.equal((await loadMonitors(pool, () => t)).length, 1);
  assert.equal((await loadMonitors(pool, () => t + 29_000)).length, 1);
  assert.equal(calls, 1);
  fail = true;
  assert.equal((await loadMonitors(pool, () => t + 31_000)).length, 1); // último valor bom
  assert.equal(calls, 2);
  invalidateMonitors(); fail = true;
  assert.deepEqual(await loadMonitors(pool, () => t), []); // sem valor bom → []
});

test('planMonitorIngest: monitor com keepDms (mig 073) deixa DM no fluxo normal e segue copiando grupo', () => {
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: false, hasMonitorRow: false, hasText: true, keepDms: true }), 'none');
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: false, hasMonitorRow: false, hasText: true, keepDms: false }), 'drop_dm');
  assert.equal(planMonitorIngest({ isMonitor: true, isGroup: true, hasMonitorRow: true, hasText: true, keepDms: true }), 'copy');
});

test('orderMonitorInstances: conectado primeiro, depois por slot', async () => {
  const { orderMonitorInstances } = await import('../../src/whatsapp/group-monitors.js');
  const ms = [{ slot: 'A' as const, instance: 'ia', phone: '1' }, { slot: 'B' as const, instance: 'ib', phone: '2' }];
  assert.deepEqual(orderMonitorInstances(ms, new Set(['ia', 'ib'])), ['ia', 'ib']);
  assert.deepEqual(orderMonitorInstances(ms, new Set(['ib'])), ['ib', 'ia']);
  assert.deepEqual(orderMonitorInstances(ms, new Set()), ['ia', 'ib']);
});
