import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureLabel } from '../../src/meetings-read/failure-label.js';
import { mapDigestView } from '../../src/meetings-read/db.js';

const o = { admissionTimeoutMin: 20 };

test('failureLabel: cada motivo conhecido tem rótulo próprio', () => {
  const reasons = ['silent_room', 'vexa_failed', 'vexa_send_failed', 'no_slot', 'not_admitted', 'stopped_empty'];
  const labels = reasons.map((r) => failureLabel(r, o));
  assert.equal(new Set(labels).size, reasons.length);
  assert.equal(failureLabel('vexa_send_failed', o), 'O Vexa recusou o bot (ex.: outro bot já estava na sala)');
});

test('failureLabel: silent_room usa o timeout de config, não um número fixo', () => {
  assert.match(failureLabel('silent_room', o), /primeiros 20 min/);
  assert.match(failureLabel('silent_room', { admissionTimeoutMin: 10 }), /primeiros 10 min/);
});

test('failureLabel: desconhecido e null não ficam sem texto', () => {
  assert.equal(failureLabel('xyz', o), 'Falha na coleta (xyz)');
  assert.equal(failureLabel(null, o), 'Falha sem motivo registrado');
});

const base = {
  id: '5', title: 'T', occurred_at: new Date(), duration_seconds: 60, participants: [],
  summary: 'S', summary_points: ['p'], summary_generated_at: null, audio_r2_key: null, metadata: {},
};

test('mapDigestView: digest antigo → campos estruturados null', () => {
  const v = mapDigestView({ ...base, summary_decisions: null, summary_actions: null, summary_open_questions: null });
  assert.equal(v.summary_decisions, null);
  assert.equal(v.summary_actions, null);
  assert.equal(v.summary_open_questions, null);
});

test('mapDigestView: vazio fica [] (≠ null) e ações saem com what/owner/due', () => {
  const v = mapDigestView({
    ...base, summary_decisions: [], summary_open_questions: ['Q?'],
    summary_actions: [{ what: 'Fazer X', owner: 'Ana', due: null }, { what: 'Fazer Y' }, { owner: 'sem what' }],
  });
  assert.deepEqual(v.summary_decisions, []);
  assert.deepEqual(v.summary_open_questions, ['Q?']);
  assert.deepEqual(v.summary_actions, [
    { what: 'Fazer X', owner: 'Ana', due: null },
    { what: 'Fazer Y', owner: null, due: null },
  ]);
});
