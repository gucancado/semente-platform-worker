import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQrCache, qrFromWebhook } from '../../src/whatsapp/qr-cache.js';

test('qrFromWebhook: aceita as duas formas do payload qrcode.updated', () => {
  assert.deepEqual(qrFromWebhook({ qrcode: { base64: 'data:A', pairingCode: 'X1' } }), { base64: 'data:A', pairingCode: 'X1' });
  assert.deepEqual(qrFromWebhook({ base64: 'data:B' }), { base64: 'data:B', pairingCode: undefined });
  assert.equal(qrFromWebhook({ qrcode: {} }), null);
  assert.equal(qrFromWebhook(null), null);
});

test('get: QR recente do webhook é servido SEM chamar connect', async () => {
  let calls = 0;
  let t = 1_000;
  const c = createQrCache({ connect: async () => { calls++; return { base64: 'data:C' }; }, now: () => t });
  c.remember('i', { base64: 'data:W' });
  t += 30_000;
  assert.equal((await c.get('i')).base64, 'data:W');
  assert.equal(calls, 0);
});

test('get: sem QR recente chama connect UMA vez e guarda o resultado', async () => {
  let calls = 0;
  let t = 1_000;
  const c = createQrCache({ connect: async () => { calls++; return { base64: 'data:C' }; }, now: () => t });
  assert.equal((await c.get('i')).base64, 'data:C');
  assert.equal((await c.get('i')).base64, 'data:C');
  assert.equal(calls, 1);
  t += 61_000; // QR velho → nova chamada
  await c.get('i');
  assert.equal(calls, 2);
});

test('get: polls concorrentes compartilham a MESMA chamada em voo', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const c = createQrCache({ connect: async () => { calls++; await gate; return { base64: 'data:C' }; }, now: () => 0 });
  const a = c.get('i');
  const b = c.get('i');
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
});

test('get: falha do connect não fica presa — a próxima tenta de novo', async () => {
  let calls = 0;
  const c = createQrCache({ connect: async () => { calls++; if (calls === 1) throw new Error('evo'); return { base64: 'data:C' }; }, now: () => 0 });
  await assert.rejects(c.get('i'));
  assert.equal((await c.get('i')).base64, 'data:C');
});

test('forget: limpa a instância (conectou → próximo pareamento começa do zero)', async () => {
  let calls = 0;
  const c = createQrCache({ connect: async () => { calls++; return { base64: 'data:C' }; }, now: () => 0 });
  c.remember('i', { base64: 'data:W' });
  c.forget('i');
  await c.get('i');
  assert.equal(calls, 1);
});
