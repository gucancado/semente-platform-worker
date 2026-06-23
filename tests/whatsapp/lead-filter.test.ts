// tests/whatsapp/lead-filter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadFilterSql } from '../../src/whatsapp/lead-filter.js';

test('leadFilterSql: all não filtra', () => {
  assert.equal(leadFilterSql('all'), 'TRUE');
});
test('leadFilterSql: lead inclui sem-linha e is_lead=true', () => {
  assert.equal(leadFilterSql('lead'), '(tm.is_lead IS NULL OR tm.is_lead = TRUE)');
});
test('leadFilterSql: not_lead só is_lead=false', () => {
  assert.equal(leadFilterSql('not_lead'), 'tm.is_lead = FALSE');
});
