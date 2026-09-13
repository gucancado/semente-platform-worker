import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceNames } from '../../src/bloquim/workspace-names.js';

const WS_A = '0c525b99-42eb-4669-8ece-8174bbfd6b9e';
const WS_B = 'b4255a9c-94ad-4947-bcbb-ce1357b58ad8';

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: any }> = []) {
  return (async (url: string, init: any) => {
    seen.push({ url, init });
    return { ok: status < 400, status, json: async () => body } as any;
  }) as any;
}

const base = { secret: 's3cr3t', bloquimOrigin: 'https://bloquim.test' };

test('resolve nomes pela rota interna, com o segredo no header e ids deduplicados', async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const names = await resolveWorkspaceNames([WS_A, WS_B, WS_A], {
    ...base,
    fetch: fakeFetch(200, { workspaces: [{ id: WS_A, name: 'Pousada Recanto de Moriá' }, { id: WS_B, name: ' Hoenka ' }] }, seen),
  });
  assert.equal(names.get(WS_A), 'Pousada Recanto de Moriá');
  assert.equal(names.get(WS_B), 'Hoenka');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://bloquim.test/api/internal/workspaces?ids=${WS_A},${WS_B}`);
  assert.equal(seen[0].init.headers['X-Internal-Secret'], 's3cr3t');
});

test('resposta não-ok devolve mapa vazio', async () => {
  const names = await resolveWorkspaceNames([WS_A], { ...base, fetch: fakeFetch(503, {}) });
  assert.equal(names.size, 0);
});

test('erro de rede devolve mapa vazio, nunca exceção', async () => {
  const names = await resolveWorkspaceNames([WS_A], {
    ...base,
    fetch: (async () => { throw new Error('ECONNREFUSED'); }) as any,
  });
  assert.equal(names.size, 0);
});

test('sem segredo nem chama a rede', async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const names = await resolveWorkspaceNames([WS_A], { ...base, secret: '', fetch: fakeFetch(200, {}, seen) });
  assert.equal(names.size, 0);
  assert.equal(seen.length, 0);
});

test('lista vazia nem chama a rede', async () => {
  const seen: Array<{ url: string; init: any }> = [];
  assert.equal((await resolveWorkspaceNames([], { ...base, fetch: fakeFetch(200, {}, seen) })).size, 0);
  assert.equal(seen.length, 0);
});

test('ignora entrada sem nome ou com forma inesperada', async () => {
  const names = await resolveWorkspaceNames([WS_A, WS_B], {
    ...base,
    fetch: fakeFetch(200, { workspaces: [{ id: WS_A, name: '   ' }, { id: 42, name: 'x' }, { id: WS_B }] }),
  });
  assert.equal(names.size, 0);
});
