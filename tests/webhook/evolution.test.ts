import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvolutionPayload } from '../../src/webhook/evolution.js';

const baseEv = {
  event: 'messages.upsert',
  instance: 'mercurio-metido-a-gente',
  data: {
    key: { remoteJid: '5531999998888@s.whatsapp.net', fromMe: false, id: 'EV1' },
    message: { conversation: 'oi' },
    pushName: 'Fulano',
  },
};

test('parser extrai project do sufixo da instance', () => {
  const parsed = parseEvolutionPayload(baseEv);
  assert.ok(parsed);
  assert.equal(parsed!.agent, 'mercurio');
  assert.equal(parsed!.project, 'metido-a-gente');
  assert.equal(parsed!.instance, 'mercurio-metido-a-gente');
});

test('parser lida com project contendo múltiplos hífens', () => {
  const parsed = parseEvolutionPayload({ ...baseEv, instance: 'mercurio-cliente-acme-2026' });
  assert.ok(parsed);
  assert.equal(parsed!.agent, 'mercurio');
  assert.equal(parsed!.project, 'cliente-acme-2026');
});

test('parser retorna project=null quando instance não tem hífen', () => {
  const parsed = parseEvolutionPayload({ ...baseEv, instance: 'agentelegado' });
  assert.ok(parsed);
  assert.equal(parsed!.agent, 'agentelegado');
  assert.equal(parsed!.project, null);
});
