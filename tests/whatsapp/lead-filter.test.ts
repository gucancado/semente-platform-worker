// tests/whatsapp/lead-filter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadFilterSql } from '../../src/whatsapp/lead-filter.js';

test('leadFilterSql: all não filtra', () => {
  assert.equal(leadFilterSql('all'), 'TRUE');
});
// Tri-state v3: NULL deixou de contar como lead — lead = is_lead=TRUE APENAS.
test('leadFilterSql: lead só is_lead=TRUE', () => {
  assert.equal(leadFilterSql('lead'), 'tm.is_lead = TRUE');
});
test('leadFilterSql: not_lead só is_lead=false', () => {
  assert.equal(leadFilterSql('not_lead'), 'tm.is_lead = FALSE');
});
test('leadFilterSql: indefinido = sem-linha ou is_lead IS NULL', () => {
  assert.equal(leadFilterSql('indefinido'), 'tm.is_lead IS NULL');
});
