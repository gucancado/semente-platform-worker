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

async function createTestProject(app: FastifyInstance, slug: string) {
  return app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug, display_name: slug.toUpperCase() },
  });
}

test('POST /admin/agents/:agent/projects/:slug/goals cria goal', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/goals',
    headers: auth,
    payload: {
      goal_type: 'scheduling',
      enabled: true,
      config: { selection_strategy: 'single' },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.goal_type, 'scheduling');
  assert.deepEqual(body.config, { selection_strategy: 'single' });
});

test('POST goals: upsert atualiza existente', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/goals',
    headers: auth,
    payload: { goal_type: 'scheduling', config: { selection_strategy: 'single' } },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/goals',
    headers: auth,
    payload: { goal_type: 'scheduling', config: { selection_strategy: 'round_robin' } },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.config.selection_strategy, 'round_robin');
});

test('DELETE /admin/agents/:agent/projects/:slug/goals/:goal_type disable', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/goals',
    headers: auth,
    payload: { goal_type: 'scheduling', config: { selection_strategy: 'single' } },
  });
  const res = await app.inject({
    method: 'DELETE',
    url: '/admin/agents/mercurio/projects/acme/goals/scheduling',
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.enabled, false);
});

test('POST goals: 404 se projeto não existe', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/nope/goals',
    headers: auth,
    payload: { goal_type: 'scheduling', config: { selection_strategy: 'single' } },
  });
  assert.equal(res.statusCode, 404);
});

const validAgendaPayload = {
  person_name: 'Rodrigo Silva',
  person_email: 'rodrigo@acme.com',
  display_label: 'o time comercial',
  description: 'Diretor comercial.',
  working_hours: {
    mon: ['09:00-12:00', '14:00-18:00'],
    tue: ['09:00-12:00', '14:00-18:00'],
    wed: ['09:00-12:00', '14:00-18:00'],
    thu: ['09:00-12:00', '14:00-18:00'],
    fri: ['09:00-12:00', '14:00-17:00'],
    timezone: 'America/Sao_Paulo',
  },
};

test('POST /admin/agents/:agent/projects/:slug/agendas cria agenda', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/agendas',
    headers: auth,
    payload: validAgendaPayload,
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.person_email, 'rodrigo@acme.com');
  assert.equal(body.meeting_duration_min, 30); // default
});

test('POST agendas: rejeita working_hours sem nenhum dia', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/agendas',
    headers: auth,
    payload: {
      ...validAgendaPayload,
      working_hours: { timezone: 'America/Sao_Paulo' },
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST agendas: rejeita janela mal formatada', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/agendas',
    headers: auth,
    payload: {
      ...validAgendaPayload,
      working_hours: { mon: ['9-12'], timezone: 'America/Sao_Paulo' },
    },
  });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/agents/:agent/projects/:slug/agendas lista', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/agendas',
    headers: auth,
    payload: validAgendaPayload,
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/agents/mercurio/projects/acme/agendas',
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const { agendas } = JSON.parse(res.body);
  assert.equal(agendas.length, 1);
});

test('PATCH /admin/agents/:agent/projects/:slug/agendas/:id', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  const created = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/agendas',
    headers: auth,
    payload: validAgendaPayload,
  });
  const id = JSON.parse(created.body).id;
  const res = await app.inject({
    method: 'PATCH',
    url: `/admin/agents/mercurio/projects/acme/agendas/${id}`,
    headers: auth,
    payload: { display_label: 'novo label' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.display_label, 'novo label');
});

test('DELETE /admin/agents/:agent/projects/:slug/agendas/:id (soft-delete)', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  const created = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/acme/agendas',
    headers: auth,
    payload: validAgendaPayload,
  });
  const id = JSON.parse(created.body).id;
  const res = await app.inject({
    method: 'DELETE',
    url: `/admin/agents/mercurio/projects/acme/agendas/${id}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).active, false);
});

test('PATCH agendas: 404 se id não pertence ao projeto', async () => {
  const app = buildApp();
  await createTestProject(app, 'acme');
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/agents/mercurio/projects/acme/agendas/99999',
    headers: auth,
    payload: { display_label: 'x' },
  });
  assert.equal(res.statusCode, 404);
});
