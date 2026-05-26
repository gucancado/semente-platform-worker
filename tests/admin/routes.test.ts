import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { cleanScheduling } from '../_helpers/db.js';
import { registerAdminRoutes } from '../../src/admin/routes.js';

const TOKEN = 'a'.repeat(32);
process.env.OWNER_ADMIN_TOKEN = TOKEN;

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerAdminRoutes);
  return app;
}

beforeEach(async () => {
  await cleanScheduling();
});

const auth = { 'x-owner-token': TOKEN };

test('POST /admin/agents/:agent/projects cria projeto', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'acme', display_name: 'ACME' },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.agent, 'mercurio');
  assert.equal(body.slug, 'acme');
  assert.ok(body.id);
});

test('POST cria — slug duplicado retorna 409', async () => {
  const app = buildApp();
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'acme', display_name: 'ACME' },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'acme', display_name: 'ACME 2' },
  });
  assert.equal(res.statusCode, 409);
});

test('GET /admin/agents/:agent/projects lista', async () => {
  const app = buildApp();
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'a', display_name: 'A' },
  });
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'b', display_name: 'B' },
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const { projects } = JSON.parse(res.body);
  assert.equal(projects.length, 2);
});

test('GET /admin/agents/:agent/projects/:slug retorna projeto + goals + agendas', async () => {
  const app = buildApp();
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'acme', display_name: 'ACME' },
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/agents/mercurio/projects/acme',
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.project.slug, 'acme');
  assert.deepEqual(body.goals, []);
  assert.deepEqual(body.agendas, []);
});

test('GET /admin/agents/:agent/projects/:slug 404 se não existe', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/admin/agents/mercurio/projects/nope',
    headers: auth,
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH /admin/agents/:agent/projects/:slug', async () => {
  const app = buildApp();
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'acme', display_name: 'ACME' },
  });
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/agents/mercurio/projects/acme',
    headers: auth,
    payload: { display_name: 'ACME Brasil' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.display_name, 'ACME Brasil');
});

test('sem X-Owner-Token: 401', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/admin/agents/mercurio/projects',
  });
  assert.equal(res.statusCode, 401);
});
