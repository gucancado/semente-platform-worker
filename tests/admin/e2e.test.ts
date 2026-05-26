import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { cleanScheduling } from '../_helpers/db.js';
import { registerAdminRoutes } from '../../src/admin/routes.js';

const TOKEN = 'a'.repeat(32);
process.env.OWNER_ADMIN_TOKEN = TOKEN;
const auth = { 'x-owner-token': TOKEN };

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerAdminRoutes);
  return app;
}

beforeEach(async () => {
  await cleanScheduling();
});

test('e2e: fluxo completo de provisionamento de projeto', async () => {
  const app = buildApp();

  // 1. criar projeto
  const createRes = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects',
    headers: auth,
    payload: { slug: 'metido-a-gente', display_name: 'metido-a-gente' },
  });
  assert.equal(createRes.statusCode, 201);

  // 2. habilitar goal scheduling
  const goalRes = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/metido-a-gente/goals',
    headers: auth,
    payload: { goal_type: 'scheduling', config: { selection_strategy: 'single' } },
  });
  assert.equal(goalRes.statusCode, 201);

  // 3. cadastrar 1 agenda
  const agendaRes = await app.inject({
    method: 'POST',
    url: '/admin/agents/mercurio/projects/metido-a-gente/agendas',
    headers: auth,
    payload: {
      person_name: 'Rodrigo',
      person_email: 'rodrigo@beeads.com.br',
      display_label: 'o time comercial',
      description: 'Diretor comercial.',
      working_hours: {
        mon: ['10:00-12:00', '14:00-18:00'],
        tue: ['09:00-12:00', '14:00-18:00'],
        wed: ['09:00-12:00', '14:00-18:00'],
        thu: ['09:00-12:00', '14:00-18:00'],
        fri: ['09:00-12:00', '14:00-17:00'],
        timezone: 'America/Sao_Paulo',
      },
    },
  });
  assert.equal(agendaRes.statusCode, 201);
  const agendaId = JSON.parse(agendaRes.body).id;

  // 4. GET projeto retorna tudo aninhado
  const detailRes = await app.inject({
    method: 'GET',
    url: '/admin/agents/mercurio/projects/metido-a-gente',
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  const detail = JSON.parse(detailRes.body);
  assert.equal(detail.project.slug, 'metido-a-gente');
  assert.equal(detail.goals.length, 1);
  assert.equal(detail.goals[0].goal_type, 'scheduling');
  assert.equal(detail.agendas.length, 1);
  assert.equal(detail.agendas[0].person_email, 'rodrigo@beeads.com.br');

  // 5. atualizar agenda
  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/admin/agents/mercurio/projects/metido-a-gente/agendas/${agendaId}`,
    headers: auth,
    payload: { meeting_duration_min: 45 },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(JSON.parse(patchRes.body).meeting_duration_min, 45);

  // 6. desativar agenda (soft-delete)
  const delRes = await app.inject({
    method: 'DELETE',
    url: `/admin/agents/mercurio/projects/metido-a-gente/agendas/${agendaId}`,
    headers: auth,
  });
  assert.equal(delRes.statusCode, 200);
  assert.equal(JSON.parse(delRes.body).active, false);

  // 7. lista de agendas ativas fica vazia
  const listActiveRes = await app.inject({
    method: 'GET',
    url: '/admin/agents/mercurio/projects/metido-a-gente/agendas',
    headers: auth,
  });
  const { agendas: allAgendas } = JSON.parse(listActiveRes.body);
  assert.equal(allAgendas.length, 1); // ainda lista a inativa por default
  assert.equal(allAgendas[0].active, false);
});
