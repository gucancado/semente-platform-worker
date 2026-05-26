import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanScheduling } from '../_helpers/db.js';
import {
  createProject,
  listProjects,
  getProjectBySlug,
  updateProject,
} from '../../src/admin/db.js';

beforeEach(async () => {
  await cleanScheduling();
});

test('createProject + getProjectBySlug', async () => {
  const p = await createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME' });
  assert.equal(p.agent, 'mercurio');
  assert.equal(p.slug, 'acme');
  assert.equal(p.display_name, 'ACME');
  assert.ok(p.id > 0);

  const got = await getProjectBySlug('mercurio', 'acme');
  assert.deepEqual(got, p);
});

test('createProject: duplicate (agent, slug) rejeitado', async () => {
  await createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME' });
  await assert.rejects(
    () => createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME 2' }),
    /duplicate key/
  );
});

test('listProjects: ordena por created_at desc', async () => {
  await createProject({ agent: 'mercurio', slug: 'p1', display_name: 'P1' });
  await new Promise((r) => setTimeout(r, 10));
  await createProject({ agent: 'mercurio', slug: 'p2', display_name: 'P2' });
  await createProject({ agent: 'outro', slug: 'p3', display_name: 'P3' });

  const list = await listProjects('mercurio');
  assert.equal(list.length, 2);
  assert.equal(list[0]!.slug, 'p2');
  assert.equal(list[1]!.slug, 'p1');
});

test('updateProject: muda display_name e bumpa updated_at', async () => {
  const p = await createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME' });
  await new Promise((r) => setTimeout(r, 10));
  const u = await updateProject(p.id, { display_name: 'ACME Brasil' });
  assert.equal(u.display_name, 'ACME Brasil');
  assert.ok(u.updated_at.getTime() > p.updated_at.getTime());
});

test('getProjectBySlug: retorna null se não existe', async () => {
  const got = await getProjectBySlug('mercurio', 'nope');
  assert.equal(got, null);
});

import {
  upsertGoal,
  listGoals,
  disableGoal,
} from '../../src/admin/db.js';

test('upsertGoal: cria novo goal', async () => {
  const p = await createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME' });
  const g = await upsertGoal({
    project_id: p.id,
    goal_type: 'scheduling',
    enabled: true,
    config: { selection_strategy: 'single' },
  });
  assert.equal(g.goal_type, 'scheduling');
  assert.equal(g.enabled, true);
  assert.deepEqual(g.config, { selection_strategy: 'single' });
});

test('upsertGoal: atualiza goal existente sem criar duplicata', async () => {
  const p = await createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME' });
  await upsertGoal({
    project_id: p.id,
    goal_type: 'scheduling',
    enabled: true,
    config: { selection_strategy: 'single' },
  });
  const updated = await upsertGoal({
    project_id: p.id,
    goal_type: 'scheduling',
    enabled: true,
    config: { selection_strategy: 'round_robin' },
  });
  assert.deepEqual(updated.config, { selection_strategy: 'round_robin' });

  const goals = await listGoals(p.id);
  assert.equal(goals.length, 1);
});

test('disableGoal', async () => {
  const p = await createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME' });
  await upsertGoal({ project_id: p.id, goal_type: 'scheduling', enabled: true, config: {} });
  const disabled = await disableGoal(p.id, 'scheduling');
  assert.equal(disabled.enabled, false);
});

test('listGoals: vazio se projeto sem goals', async () => {
  const p = await createProject({ agent: 'mercurio', slug: 'acme', display_name: 'ACME' });
  const goals = await listGoals(p.id);
  assert.deepEqual(goals, []);
});
