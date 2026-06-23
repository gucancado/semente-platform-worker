// tests/whatsapp/transcript.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleLabel, formatTranscript } from '../../src/whatsapp/transcript.js';

const base = { author: null, authorName: null };

test('roleLabel DM: outbound=Atendente, inbound=Cliente', () => {
  const ctx = { kind: 'dm' as const, isTeam: () => false };
  assert.equal(roleLabel({ ...base, direction: 'outbound', text: 'oi', createdAt: '' }, ctx), 'Atendente');
  assert.equal(roleLabel({ ...base, direction: 'inbound', text: 'oi', createdAt: '' }, ctx), 'Cliente');
});

test('roleLabel grupo: autor membro=Atendente, senão Cliente com nome', () => {
  const ctx = { kind: 'group' as const, isTeam: (a: string | null) => a === '+55team' };
  assert.equal(roleLabel({ author: '+55team', authorName: 'Time', direction: 'inbound', text: 'x', createdAt: '' }, ctx), 'Atendente (Time)');
  assert.equal(roleLabel({ author: '+55out', authorName: 'Cli', direction: 'inbound', text: 'x', createdAt: '' }, ctx), 'Cliente (Cli)');
});

test('formatTranscript: linha por mensagem em horário Brasília', () => {
  const ctx = { kind: 'dm' as const, isTeam: () => false };
  const out = formatTranscript([{ ...base, direction: 'inbound', text: 'olá', createdAt: '2026-06-23T13:00:00.000Z' }], ctx);
  assert.equal(out, '[2026-06-23 10:00 BRT] Cliente: olá');
});
