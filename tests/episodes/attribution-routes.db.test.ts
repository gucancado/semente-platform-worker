import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool } from '../../src/db.js';
import { registerAttributionRoutes } from '../../src/episodes/attribution-routes.js';

// Contrato attribution_v1: o Bloquim resolve o workspace de um evento de agenda
// ANTES da reunião existir, com as mesmas regras do import (domain > title >
// internal > none), + upsert de title rule. Auth X-Panel-Token.

const PANEL = 'test-panel';
const INTERNAL_WS = 'wks-interno';
const panelAuth = { 'x-panel-token': PANEL };

function buildApp(): FastifyInstance {
  const app = Fastify();
  // internalWorkspaceId injetado via deps (não depende de INTERNAL_WORKSPACE_ID no .env.test).
  registerAttributionRoutes(app, { panelToken: PANEL, internalWorkspaceId: INTERNAL_WS });
  return app;
}

beforeEach(async () => {
  await pool.query('TRUNCATE workspace_domains, workspace_title_rules RESTART IDENTITY CASCADE');
});
after(() => pool.end());

// 1. sem token → 401
test('POST /attribution/resolve sem x-panel-token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST', url: '/attribution/resolve',
    payload: { attendees: [{ email: 'g@beeads.com.br' }] },
  });
  assert.equal(res.statusCode, 401);
});

// 2. attendee de domínio conhecido → method 'domain', workspace certo
test('domínio conhecido (workspace_domains) → method domain', async () => {
  await pool.query(
    `INSERT INTO workspace_domains (domain, workspace_id, project_slug) VALUES ($1,$2,$3)`,
    ['tagless.com.br', 'wks-tagless', 'tagless-brasil'],
  );
  const app = buildApp();
  const res = await app.inject({
    method: 'POST', url: '/attribution/resolve', headers: panelAuth,
    payload: { title: null, attendees: [{ email: 'ana@tagless.com.br' }, { email: 'g@beeads.com.br' }] },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'attribution_v1');
  assert.equal(body.method, 'domain');
  assert.equal(body.workspace_id, 'wks-tagless');
  assert.equal(body.project_slug, 'tagless-brasil');
  assert.deepEqual(body.unresolved_domains, []);
});

// 3. só beeads + título casando rule → method 'title' (título vence internal)
test('só beeads + título casa title rule → method title (vence internal)', async () => {
  await pool.query(
    `INSERT INTO workspace_title_rules (pattern, workspace_id) VALUES ($1,$2)`,
    ['hoenka', 'wks-hoenka'],
  );
  const app = buildApp();
  const res = await app.inject({
    method: 'POST', url: '/attribution/resolve', headers: panelAuth,
    payload: { title: 'Hoenka + BeeAds | Alinhamento', attendees: [{ email: 'g@beeads.com.br' }] },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.method, 'title');
  assert.equal(body.workspace_id, 'wks-hoenka');
});

// 4. só beeads sem título → method 'internal' (internalWorkspaceId via deps)
test('só beeads sem título → method internal (internalWorkspaceId injetado)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST', url: '/attribution/resolve', headers: panelAuth,
    payload: { attendees: [{ email: 'g@beeads.com.br' }, { email: 'a@beeads.com.br' }] },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.method, 'internal');
  assert.equal(body.workspace_id, INTERNAL_WS);
});

// 5. desconhecido sem título → method 'none' + unresolved_domains
test('desconhecido sem título → method none + unresolved_domains', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST', url: '/attribution/resolve', headers: panelAuth,
    payload: { attendees: [{ email: 'x@fornecedor.com' }] },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.method, 'none');
  assert.equal(body.workspace_id, null);
  assert.deepEqual(body.unresolved_domains, ['fornecedor.com']);
});

// 6. POST title-rules cria; upsert por pattern (ws diferente atualiza); lowercase; <3 → 400
test('POST /attribution/title-rules cria, upserta por pattern, lowercase, <3 → 400', async () => {
  const app = buildApp();

  // sem token → 401
  const noAuth = await app.inject({
    method: 'POST', url: '/attribution/title-rules',
    payload: { pattern: 'hoenka', workspace_id: 'wks-hoenka' },
  });
  assert.equal(noAuth.statusCode, 401);

  // cria — pattern mixed-case vira lowercase
  const create = await app.inject({
    method: 'POST', url: '/attribution/title-rules', headers: panelAuth,
    payload: { pattern: 'Hoenka', workspace_id: 'wks-hoenka', project_slug: 'hoenka-slug' },
  });
  assert.equal(create.statusCode, 201);
  assert.deepEqual(JSON.parse(create.body), { ok: true, pattern: 'hoenka' });

  let { rows } = await pool.query(`SELECT pattern, workspace_id, project_slug FROM workspace_title_rules`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pattern, 'hoenka');
  assert.equal(rows[0].workspace_id, 'wks-hoenka');

  // mesmo pattern, workspace diferente → upsert (não duplica, atualiza ws + slug)
  const upsert = await app.inject({
    method: 'POST', url: '/attribution/title-rules', headers: panelAuth,
    payload: { pattern: 'Hoenka', workspace_id: 'wks-hoenka-2', project_slug: 'hoenka-2' },
  });
  assert.equal(upsert.statusCode, 201);
  ({ rows } = await pool.query(`SELECT pattern, workspace_id, project_slug FROM workspace_title_rules`));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, 'wks-hoenka-2');
  assert.equal(rows[0].project_slug, 'hoenka-2');

  // pattern com <3 chars → 400
  const tooShort = await app.inject({
    method: 'POST', url: '/attribution/title-rules', headers: panelAuth,
    payload: { pattern: 'ab', workspace_id: 'wks-x' },
  });
  assert.equal(tooShort.statusCode, 400);

  // workspace_id ausente → 400
  const noWs = await app.inject({
    method: 'POST', url: '/attribution/title-rules', headers: panelAuth,
    payload: { pattern: 'valido' },
  });
  assert.equal(noWs.statusCode, 400);
});

// 7. resolve APÓS title-rules → reflete o workspace atualizado (regras NÃO cacheadas entre requests)
test('resolve reflete title rule escrita via endpoint + upsert (sem cache entre requests)', async () => {
  const app = buildApp();
  const resolveHoenka = () => app.inject({
    method: 'POST', url: '/attribution/resolve', headers: panelAuth,
    payload: { title: 'Hoenka sync', attendees: [{ email: 'g@beeads.com.br' }] },
  });

  await app.inject({
    method: 'POST', url: '/attribution/title-rules', headers: panelAuth,
    payload: { pattern: 'hoenka', workspace_id: 'wks-A' },
  });
  let body = JSON.parse((await resolveHoenka()).body);
  assert.equal(body.method, 'title');
  assert.equal(body.workspace_id, 'wks-A');

  // upsert do MESMO pattern pra outro workspace → próximo resolve já enxerga (re-consulta)
  await app.inject({
    method: 'POST', url: '/attribution/title-rules', headers: panelAuth,
    payload: { pattern: 'Hoenka', workspace_id: 'wks-B' },
  });
  body = JSON.parse((await resolveHoenka()).body);
  assert.equal(body.method, 'title');
  assert.equal(body.workspace_id, 'wks-B');
});
