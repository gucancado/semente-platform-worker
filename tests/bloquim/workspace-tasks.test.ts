import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkspaceTasks } from '../../src/bloquim/workspace-tasks.js';

const WS = '0c525b99-42eb-4669-8ece-8174bbfd6b9e';
const base = { secret: 's3cr3t', bloquimOrigin: 'https://bloquim.test' };

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: any }> = []) {
  return (async (url: string, init: any) => {
    seen.push({ url, init });
    return { ok: status < 400, status, json: async () => body } as any;
  }) as any;
}

test('busca pela rota interna com segredo e completedSince', async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const r = await fetchWorkspaceTasks(WS, new Date('2026-11-10T09:00:00Z'), {
    ...base,
    fetch: fakeFetch(200, {
      open: [{ title: ' Ajustar LP ', status: 'in_progress', overdue: true, dueDate: '2026-11-20T03:00:00.000Z', assigneeName: 'Ana' }],
      completed: [{ title: 'Criativo novo', status: 'completed', completedAt: '2026-11-22T15:00:00.000Z' }, { title: '' }],
    }, seen),
  });
  assert.equal(seen[0].url, `https://bloquim.test/api/internal/workspaces/${WS}/tasks?completedSince=2026-11-10T09%3A00%3A00.000Z`);
  assert.equal(seen[0].init.headers['X-Internal-Secret'], 's3cr3t');
  assert.equal(r?.open[0].title, 'Ajustar LP');
  assert.equal(r?.open[0].overdue, true);
  assert.equal(r?.completed.length, 1);
});

test('falha, forma errada ou sem segredo → null', async () => {
  const since = new Date();
  assert.equal(await fetchWorkspaceTasks(WS, since, { ...base, fetch: fakeFetch(500, {}) }), null);
  assert.equal(await fetchWorkspaceTasks(WS, since, { ...base, fetch: fakeFetch(200, { open: [] }) }), null);
  assert.equal(await fetchWorkspaceTasks(WS, since, { ...base, secret: '', fetch: fakeFetch(200, { open: [], completed: [] }) }), null);
  const boom = (async () => { throw new Error('rede'); }) as any;
  assert.equal(await fetchWorkspaceTasks(WS, since, { ...base, fetch: boom }), null);
});
