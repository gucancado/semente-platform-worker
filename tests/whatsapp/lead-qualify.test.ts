// tests/whatsapp/lead-qualify.test.ts  — DB-FREE (runs locally with node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidStage, validateLeadQualifyFields, VALID_STAGES } from '../../src/whatsapp/lead-qualify.js';

// ── isValidStage ──────────────────────────────────────────────────────────────
test('isValidStage: aceita todos os valores válidos', () => {
  for (const s of VALID_STAGES) {
    assert.ok(isValidStage(s), `esperava ${s} como válido`);
  }
});

test('isValidStage: rejeita valor desconhecido', () => {
  assert.equal(isValidStage('interessado'), false);
  assert.equal(isValidStage(''), false);
  assert.equal(isValidStage('QUALIFICADO'), false); // case-sensitive
});

// ── validateLeadQualifyFields ─────────────────────────────────────────────────
test('validateLeadQualifyFields: retorna null quando campos ausentes', () => {
  assert.equal(validateLeadQualifyFields({ status: 'lead' }), null);
  assert.equal(validateLeadQualifyFields({ status: 'not_lead' }), null);
  assert.equal(validateLeadQualifyFields({}), null);
});

test('validateLeadQualifyFields: aceita stage=null', () => {
  assert.equal(validateLeadQualifyFields({ status: 'lead', stage: null }), null);
});

test('validateLeadQualifyFields: aceita stage válido com status lead', () => {
  assert.equal(validateLeadQualifyFields({ status: 'lead', stage: 'qualificado' }), null);
  assert.equal(validateLeadQualifyFields({ status: 'lead', stage: 'cliente' }), null);
  assert.equal(validateLeadQualifyFields({ status: 'lead', stage: 'perdido' }), null);
});

test('validateLeadQualifyFields: aceita stage=desqualificado com status not_lead', () => {
  assert.equal(validateLeadQualifyFields({ status: 'not_lead', stage: 'desqualificado' }), null);
});

test('validateLeadQualifyFields: rejeita stage inválido', () => {
  const err = validateLeadQualifyFields({ status: 'lead', stage: 'interessado' });
  assert.ok(err !== null, 'deveria retornar erro');
  assert.ok(err!.includes('stage inválido'));
});

test('validateLeadQualifyFields: rejeita stage=desqualificado com status=lead (CHECK coherence)', () => {
  const err = validateLeadQualifyFields({ status: 'lead', stage: 'desqualificado' });
  assert.ok(err !== null, 'deveria retornar erro');
  assert.ok(err!.includes('desqualificado'));
  assert.ok(err!.includes('lead'));
});

test('validateLeadQualifyFields: sem status, stage=desqualificado não causa erro puro', () => {
  // Sem status a coerção de is_lead não pode ser checada — passa sem erro de coherência
  assert.equal(validateLeadQualifyFields({ stage: 'desqualificado' }), null);
});
