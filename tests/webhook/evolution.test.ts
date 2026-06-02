import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvolutionPayload, shouldIngest } from '../../src/webhook/evolution.js';

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

// ── Grupos (auditor/saturno) ──────────────────────────────────────────────

const groupEv = {
  event: 'messages.upsert',
  instance: 'saturno-bluma',
  data: {
    key: {
      remoteJid: '120363000000000000@g.us',
      participant: '5531988887777@s.whatsapp.net',
      fromMe: false,
      id: 'EVG1',
    },
    message: { conversation: 'cadê o relatório?' },
    pushName: 'Cliente Bluma',
  },
};

test('DM: isGroup=false e author=null', () => {
  const parsed = parseEvolutionPayload(baseEv);
  assert.ok(parsed);
  assert.equal(parsed!.isGroup, false);
  assert.equal(parsed!.author, null);
  assert.equal(parsed!.identifier, '+5531999998888');
});

test('grupo: isGroup=true, identifier=JID do grupo, author=participant', () => {
  const parsed = parseEvolutionPayload(groupEv);
  assert.ok(parsed);
  assert.equal(parsed!.isGroup, true);
  assert.equal(parsed!.identifier, '+120363000000000000');
  assert.equal(parsed!.author, '+5531988887777');
  assert.equal(parsed!.agent, 'saturno');
  assert.equal(parsed!.project, 'bluma');
});

test('grupo sem participant: author=null', () => {
  const ev = { ...groupEv, data: { ...groupEv.data, key: { ...groupEv.data.key, participant: undefined } } };
  const parsed = parseEvolutionPayload(ev);
  assert.ok(parsed);
  assert.equal(parsed!.isGroup, true);
  assert.equal(parsed!.author, null);
});

test('shouldIngest: DM sempre ingere (reactive e sweep)', () => {
  const dm = parseEvolutionPayload(baseEv)!;
  assert.equal(shouldIngest(dm, 'reactive'), true);
  assert.equal(shouldIngest(dm, 'sweep'), true);
});

test('shouldIngest: grupo só ingere em sweep', () => {
  const grp = parseEvolutionPayload(groupEv)!;
  assert.equal(shouldIngest(grp, 'reactive'), false);
  assert.equal(shouldIngest(grp, 'sweep'), true);
});
