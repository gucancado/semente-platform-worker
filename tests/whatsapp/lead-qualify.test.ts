import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLeadQualifyFields, resolveLeadStatus } from '../../src/whatsapp/lead-qualify.js';
import { emptyToUndefined } from '../../src/whatsapp/query-coerce.js';

test('emptyToUndefined: empty / whitespace-only string → undefined', () => {
  assert.equal(emptyToUndefined(''), undefined);
  assert.equal(emptyToUndefined('   '), undefined);
  assert.equal(emptyToUndefined('\t\n'), undefined);
});

test('emptyToUndefined: absent value → undefined', () => {
  assert.equal(emptyToUndefined(undefined), undefined);
  assert.equal(emptyToUndefined(null), undefined);
});

test('emptyToUndefined: real value passes through trimmed', () => {
  assert.equal(emptyToUndefined('qualificado'), 'qualificado');
  assert.equal(emptyToUndefined('  vip  '), 'vip');
});

test('validateLeadQualifyFields: accepts status without reason', () => {
  assert.equal(validateLeadQualifyFields({ status: 'lead' }), null);
  assert.equal(validateLeadQualifyFields({ status: 'not_lead' }), null);
});

test('validateLeadQualifyFields: disqualifyReason requires not_lead', () => {
  assert.match(
    validateLeadQualifyFields({ status: 'lead', disqualifyReason: 'sem_fit' })!,
    /not_lead/,
  );
  assert.equal(
    validateLeadQualifyFields({ status: 'not_lead', disqualifyReason: 'sem_fit' }),
    null,
  );
  assert.equal(
    validateLeadQualifyFields({ status: 'lead', disqualifyReason: null }),
    null,
  );
});

test('resolveLeadStatus: accepts explicit compatible values', () => {
  assert.deepEqual(resolveLeadStatus('lead'), { status: 'lead' });
  assert.deepEqual(resolveLeadStatus('not_lead'), { status: 'not_lead' });
});

test('resolveLeadStatus: missing status is an error', () => {
  const result = resolveLeadStatus(undefined);
  assert.ok('error' in result);
  assert.match(result.error, /obrigatório/);
});

test('resolveLeadStatus: invalid status is an error', () => {
  const result = resolveLeadStatus('foo');
  assert.ok('error' in result);
});
