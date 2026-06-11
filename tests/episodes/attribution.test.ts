import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttribution, DEFAULT_FREEMAIL } from '../../src/episodes/attribution.js';

const RULES = new Map([
  ['tagless.com.br', { workspace_id: 'wks-tagless', project_slug: 'tagless-brasil' }],
  ['cbv.med.br', { workspace_id: 'wks-cbv', project_slug: 'cbv-clinica' }],
]);
const OPTS = { internalDomains: ['beeads.com.br'], freemailDomains: DEFAULT_FREEMAIL, internalWorkspaceId: 'wks-interno' };

test('domínio conhecido único → domain', () => {
  const r = resolveAttribution([{ email: 'gustavo@beeads.com.br' }, { email: 'ana@tagless.com.br' }], RULES, OPTS);
  assert.deepEqual(r, { workspace_id: 'wks-tagless', project_slug: 'tagless-brasil', method: 'domain', unresolved_domains: [] });
});

test('desconhecido não veta quando há conhecido sem conflito; registra unresolved', () => {
  const r = resolveAttribution([{ email: 'ana@tagless.com.br' }, { email: 'x@fornecedor.com' }], RULES, OPTS);
  assert.equal(r.method, 'domain');
  assert.deepEqual(r.unresolved_domains, ['fornecedor.com']);
});

test('conhecidos divergentes → none (ambíguo não chuta)', () => {
  const r = resolveAttribution([{ email: 'a@tagless.com.br' }, { email: 'b@cbv.med.br' }], RULES, OPTS);
  assert.equal(r.method, 'none');
  assert.equal(r.workspace_id, null);
});

test('freemail é ignorado como domínio mas participante segue externo', () => {
  const r = resolveAttribution([{ email: 'cliente@gmail.com' }, { email: 'g@beeads.com.br' }], RULES, OPTS);
  assert.equal(r.method, 'none');
});

test('todos internos → internal', () => {
  const r = resolveAttribution([{ email: 'a@beeads.com.br' }, { email: 'b@beeads.com.br' }], RULES, OPTS);
  assert.equal(r.method, 'internal');
  assert.equal(r.workspace_id, 'wks-interno');
});

test('todos internos sem INTERNAL_WORKSPACE_ID configurado → none', () => {
  const r = resolveAttribution([{ email: 'a@beeads.com.br' }], RULES, { ...OPTS, internalWorkspaceId: undefined });
  assert.equal(r.method, 'none');
});

test('participante sem email não quebra', () => {
  const r = resolveAttribution([{ name: 'Sem Email' }, { email: 'ana@tagless.com.br' }], RULES, OPTS);
  assert.equal(r.method, 'domain');
});
