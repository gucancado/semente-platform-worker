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

// ── resolveByTitle (fallback por título) ──
import { resolveByTitle } from '../../src/episodes/attribution.js';

const TITLE_RULES = [
  { pattern: 'hoenka', workspace_id: 'wks-hoenka', project_slug: null },
  { pattern: 'luhma', workspace_id: 'wks-luhma', project_slug: null },
  { pattern: 'bluma', workspace_id: 'wks-bluma', project_slug: null },
  { pattern: 'bluma rh', workspace_id: 'wks-bluma', project_slug: null }, // mesmo ws, pattern mais específico
];

test('resolveByTitle: título nomeia o cliente → title', () => {
  const r = resolveByTitle('Hoenka + BeeAds | Alinhamento', TITLE_RULES);
  assert.equal(r.method, 'title');
  assert.equal(r.workspace_id, 'wks-hoenka');
});

test('resolveByTitle: case-insensitive + substring', () => {
  const r = resolveByTitle('LUHMA + Beeads - Acompanhamento', TITLE_RULES);
  assert.equal(r.workspace_id, 'wks-luhma');
});

test('resolveByTitle: patterns do MESMO workspace → resolve (pattern mais específico)', () => {
  const r = resolveByTitle('Bluma RH + BeeAds | Alinhamento', TITLE_RULES);
  assert.equal(r.method, 'title');
  assert.equal(r.workspace_id, 'wks-bluma');
});

test('resolveByTitle: patterns de workspaces DIFERENTES casando → none (ambíguo)', () => {
  const r = resolveByTitle('Hoenka + Luhma sync', TITLE_RULES);
  assert.equal(r.method, 'none');
  assert.equal(r.workspace_id, null);
});

test('resolveByTitle: nenhum pattern casa → none', () => {
  const r = resolveByTitle('Charles Bronson - Onboard Site', TITLE_RULES);
  assert.equal(r.method, 'none');
});

test('resolveByTitle: título vazio/nulo → none', () => {
  assert.equal(resolveByTitle(null, TITLE_RULES).method, 'none');
  assert.equal(resolveByTitle('', TITLE_RULES).method, 'none');
});
