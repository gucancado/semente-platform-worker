// tests/whatsapp/probe-start.test.ts
//
// Teste PURO de `buildProbeConfig` (down-notify-start.ts) — a decisão de LIGAR
// a sonda de conexão a partir do config, sem env/zod/rede. Spec
// 2026-09-25-sonda-conexao-whatsapp-design.md §11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeConfig } from '../../src/whatsapp/down-notify-start.js';

test('mode off não inicia, independente do resto', () => {
  const r = buildProbeConfig({ mode: 'off', ownPhones: [], mirror: 'on', opsTo: '553196039118' });
  assert.deepEqual(r, { mode: 'off' });
});

test('mode on sem WHATSAPP_CLOUD_OWN_PHONES é erro declarado', () => {
  const r = buildProbeConfig({ mode: 'on', ownPhones: [] });
  assert.deepEqual(r, { error: 'WHATSAPP_CLOUD_OWN_PHONES ausente' });
});

test('mode on com telefone próprio e espelho ligado: mirrorTo = OPS_NOTIFY_TO', () => {
  const r = buildProbeConfig({
    mode: 'on',
    ownPhones: ['553190858510'],
    mirror: 'on',
    opsTo: '553196039118',
  });
  assert.deepEqual(r, { mode: 'on', mirrorTo: '553196039118' });
});

test('mirror off: mirrorTo é null mesmo com OPS_NOTIFY_TO presente', () => {
  const r = buildProbeConfig({
    mode: 'on',
    ownPhones: ['553190858510'],
    mirror: 'off',
    opsTo: '553196039118',
  });
  assert.deepEqual(r, { mode: 'on', mirrorTo: null });
});

test('mirror ausente é o default (on) — mirrorTo segue OPS_NOTIFY_TO', () => {
  const r = buildProbeConfig({ mode: 'on', ownPhones: ['553190858510'], opsTo: '553196039118' });
  assert.deepEqual(r, { mode: 'on', mirrorTo: '553196039118' });
});

test('espelho ligado sem OPS_NOTIFY_TO: mirrorTo null (nada pra copiar)', () => {
  const r = buildProbeConfig({ mode: 'on', ownPhones: ['553190858510'], mirror: 'on' });
  assert.deepEqual(r, { mode: 'on', mirrorTo: null });
});
