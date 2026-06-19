import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { upsertWorkspaceAgent, getAgentsForNumber, getObservers } from '../../src/whatsapp/workspace-agents.js';

beforeEach(async () => {
  await pool.query('TRUNCATE workspace_agents RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('getAgentsForNumber filtra por operates_numbers + reaction_mode', async () => {
  await upsertWorkspaceAgent(pool, { workspaceId: 'ws-1', agent: 'mercurio', config: { reaction_mode: 'reactive', operates_numbers: [10] } });
  await upsertWorkspaceAgent(pool, { workspaceId: 'ws-1', agent: 'saturno', config: { reaction_mode: 'sweep', observes_numbers: [10] } });
  const reactive = await getAgentsForNumber(pool, { workspaceId: 'ws-1', numberId: 10, reactionMode: 'reactive' });
  assert.deepEqual(reactive.map(a => a.agent), ['mercurio']);
  const reactiveOther = await getAgentsForNumber(pool, { workspaceId: 'ws-1', numberId: 99, reactionMode: 'reactive' });
  assert.equal(reactiveOther.length, 0);
  const observers = await getObservers(pool, 'ws-1');
  assert.deepEqual(observers.map(a => a.agent).sort(), ['mercurio', 'saturno']);
});

test('upsert é idempotente por (workspace,agent) e bumpa version', async () => {
  await upsertWorkspaceAgent(pool, { workspaceId: 'ws-1', agent: 'mercurio', config: { reaction_mode: 'reactive' } });
  await upsertWorkspaceAgent(pool, { workspaceId: 'ws-1', agent: 'mercurio', config: { reaction_mode: 'reactive', operates_numbers: [5] } });
  const rows = await getAgentsForNumber(pool, { workspaceId: 'ws-1', numberId: 5, reactionMode: 'reactive' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 2);
});
