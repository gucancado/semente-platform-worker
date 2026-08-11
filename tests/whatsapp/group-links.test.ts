/**
 * tests/whatsapp/group-links.test.ts
 *
 * Resolução do vínculo grupo→workspace, DB-free (fake pool que devolve rows
 * fixas e captura os params). O que importa aqui: o predicado casa jid E
 * workspace VINCULADO, e o `numberWorkspaceId` vem do NÚMERO (join), não da
 * coluna workspace_id do grupo — é isso que escopa a leitura das mensagens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listLinkedGroups, resolveLinkedGroup } from '../../src/whatsapp/group-links.js';

function fakePool(rows: any[]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows }; },
  } as any;
  return { pool, calls };
}

const ROW = {
  id: 7,
  jid: '+120363001',
  subject: 'Symmetry CWB + BeeAds',
  whatsapp_number_id: 3,
  number_workspace_id: 'ws-saturno',
  linked_workspace_id: 'ws-cliente',
};

test('resolveLinkedGroup mapeia a row e passa (workspace, jid) como params', async () => {
  const { pool, calls } = fakePool([ROW]);
  const g = await resolveLinkedGroup(pool, 'ws-cliente', '+120363001');
  assert.deepEqual(g, {
    id: 7,
    jid: '+120363001',
    subject: 'Symmetry CWB + BeeAds',
    numberId: 3,
    numberWorkspaceId: 'ws-saturno',
    linkedWorkspaceId: 'ws-cliente',
  });
  assert.deepEqual(calls[0].params, ['ws-cliente', '+120363001']);
});

test('resolveLinkedGroup filtra por linked_workspace_id (não por workspace_id do grupo)', async () => {
  const { pool, calls } = fakePool([ROW]);
  await resolveLinkedGroup(pool, 'ws-cliente', '+120363001');
  assert.match(calls[0].sql, /linked_workspace_id\s*=\s*\$1/);
  assert.doesNotMatch(calls[0].sql, /g\.workspace_id\s*=\s*\$1/);
});

test('resolveLinkedGroup devolve null quando não há vínculo', async () => {
  const { pool } = fakePool([]);
  assert.equal(await resolveLinkedGroup(pool, 'ws-cliente', '+120363001'), null);
});

// Duas linhas vinculadas pro mesmo jid = ambiguidade sobre qual número dá o
// escopo de leitura. Devolver rows[0] escolheria um tenant no sorteio.
test('resolveLinkedGroup falha alto se o jid tiver vínculo ambíguo', async () => {
  const { pool } = fakePool([ROW, { ...ROW, id: 9, whatsapp_number_id: 4, number_workspace_id: 'ws-outro' }]);
  await assert.rejects(() => resolveLinkedGroup(pool, 'ws-cliente', '+120363001'), /ambíguo/);
});

test('listLinkedGroups devolve lista vazia sem vínculo (não erro)', async () => {
  const { pool, calls } = fakePool([]);
  assert.deepEqual(await listLinkedGroups(pool, 'ws-cliente'), []);
  assert.deepEqual(calls[0].params, ['ws-cliente']);
});

test('listLinkedGroups mapeia várias rows', async () => {
  const { pool } = fakePool([ROW, { ...ROW, id: 8, jid: '+120363002', subject: 'Outro' }]);
  const gs = await listLinkedGroups(pool, 'ws-cliente');
  assert.equal(gs.length, 2);
  assert.equal(gs[1].jid, '+120363002');
  assert.equal(gs[1].numberWorkspaceId, 'ws-saturno');
});

// O gate 2 (assertMember no workspace do NÚMERO) só barra alguém que o gate 1
// (assertAdmin no workspace do CLIENTE) já não barraria sozinho quando os dois
// workspaces são DIFERENTES. Se o vínculo apontar pra uma linha cujo número é
// do PRÓPRIO workspace do cliente, admin implica membro e o gate 2 vira
// tautologia — o SQL tem que excluir essa linha na origem (JOIN), não confiar
// em quem chama pra perceber a ambiguidade depois.
test('SELECT exige n.workspace_id <> g.linked_workspace_id (senão o gate 2 vira tautologia)', async () => {
  const { pool, calls } = fakePool([ROW]);
  await resolveLinkedGroup(pool, 'ws-cliente', '+120363001');
  assert.match(calls[0].sql, /n\.workspace_id\s*<>\s*g\.linked_workspace_id/);
});

test('listLinkedGroups também carrega n.workspace_id <> g.linked_workspace_id', async () => {
  const { pool, calls } = fakePool([]);
  await listLinkedGroups(pool, 'ws-cliente');
  assert.match(calls[0].sql, /n\.workspace_id\s*<>\s*g\.linked_workspace_id/);
});
