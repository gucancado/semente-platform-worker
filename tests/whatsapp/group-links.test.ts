/**
 * tests/whatsapp/group-links.test.ts
 *
 * Resolução do vínculo grupo→workspace, DB-free (fake pool que devolve rows
 * fixas e captura os params). O que importa aqui: o predicado casa jid E
 * workspace VINCULADO, e a linha resolve num de DOIS escopos possíveis
 * (`number` — número + workspace do número, via JOIN; `agent` — linha legada
 * sem número). Linha sem os dois não resolve (sem escopo seguro de leitura).
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

const NUMBER_ROW = {
  id: 7,
  jid: '+120363001',
  subject: 'Symmetry CWB + BeeAds',
  whatsapp_number_id: 3,
  number_workspace_id: 'ws-saturno',
  number_phone: '+553196039118',
  agent: null,
  linked_workspace_id: 'ws-cliente',
};

// A linha "da organização": legada, sem whatsapp_number_id, agent='saturno'
// (hoje o único caso real em produção — 51 grupos, número nunca migrado pra
// whatsapp_numbers, sem workspace próprio).
const AGENT_ROW = {
  id: 11,
  jid: '+120363099',
  subject: 'Decisão de produto',
  whatsapp_number_id: null,
  number_workspace_id: null,
  agent: 'saturno',
  linked_workspace_id: 'ws-cliente',
};

test('resolveLinkedGroup mapeia row com número → scope.kind "number"', async () => {
  const { pool, calls } = fakePool([NUMBER_ROW]);
  const g = await resolveLinkedGroup(pool, 'ws-cliente', '+120363001');
  assert.deepEqual(g, {
    id: 7,
    jid: '+120363001',
    subject: 'Symmetry CWB + BeeAds',
    linkedWorkspaceId: 'ws-cliente',
    scope: { kind: 'number', numberId: 3, numberWorkspaceId: 'ws-saturno', numberPhone: '+553196039118' },
  });
  assert.deepEqual(calls[0].params, ['ws-cliente', '+120363001']);
});

test('resolveLinkedGroup mapeia row legada (sem número, com agent) → scope.kind "agent"', async () => {
  const { pool } = fakePool([AGENT_ROW]);
  const g = await resolveLinkedGroup(pool, 'ws-cliente', '+120363099');
  assert.deepEqual(g, {
    id: 11,
    jid: '+120363099',
    subject: 'Decisão de produto',
    linkedWorkspaceId: 'ws-cliente',
    scope: { kind: 'agent', agent: 'saturno' },
  });
});

test('resolveLinkedGroup devolve null quando a linha não tem número NEM agent (sem escopo seguro)', async () => {
  const { pool } = fakePool([{ ...AGENT_ROW, agent: null }]);
  assert.equal(await resolveLinkedGroup(pool, 'ws-cliente', '+120363099'), null);
});

test('resolveLinkedGroup filtra por linked_workspace_id (não por workspace_id do grupo)', async () => {
  const { pool, calls } = fakePool([NUMBER_ROW]);
  await resolveLinkedGroup(pool, 'ws-cliente', '+120363001');
  assert.match(calls[0].sql, /linked_workspace_id\s*=\s*\$1/);
  assert.doesNotMatch(calls[0].sql, /g\.workspace_id\s*=\s*\$1/);
});

test('resolveLinkedGroup devolve null quando não há vínculo', async () => {
  const { pool } = fakePool([]);
  assert.equal(await resolveLinkedGroup(pool, 'ws-cliente', '+120363001'), null);
});

// Duas linhas vinculadas pro mesmo jid = ambiguidade sobre qual escopo dá a
// leitura. Devolver rows[0] escolheria um tenant no sorteio.
test('resolveLinkedGroup falha alto se o jid tiver vínculo ambíguo', async () => {
  const { pool } = fakePool([NUMBER_ROW, { ...NUMBER_ROW, id: 9, whatsapp_number_id: 4, number_workspace_id: 'ws-outro' }]);
  await assert.rejects(() => resolveLinkedGroup(pool, 'ws-cliente', '+120363001'), /ambíguo/);
});

test('listLinkedGroups devolve lista vazia sem vínculo (não erro)', async () => {
  const { pool, calls } = fakePool([]);
  assert.deepEqual(await listLinkedGroups(pool, 'ws-cliente'), []);
  assert.deepEqual(calls[0].params, ['ws-cliente']);
});

test('listLinkedGroups mapeia várias rows, número e agent misturados', async () => {
  const { pool } = fakePool([NUMBER_ROW, AGENT_ROW]);
  const gs = await listLinkedGroups(pool, 'ws-cliente');
  assert.equal(gs.length, 2);
  assert.equal(gs[0].scope.kind, 'number');
  assert.equal(gs[1].scope.kind, 'agent');
});

test('listLinkedGroups omite linha sem número e sem agent (sem escopo seguro)', async () => {
  const { pool } = fakePool([NUMBER_ROW, { ...AGENT_ROW, agent: null }]);
  const gs = await listLinkedGroups(pool, 'ws-cliente');
  assert.equal(gs.length, 1);
  assert.equal(gs[0].jid, '+120363001');
});

// O JOIN precisa ser LEFT (não INNER): a linha legada (whatsapp_number_id
// NULL) não tem correspondente em whatsapp_numbers, e um INNER a descartaria
// no SELECT antes de chegar em `map()` — voltaríamos a perder o escopo
// 'agent' em silêncio, do jeito que o INNER fazia antes desta mudança.
test('SELECT usa LEFT JOIN em whatsapp_numbers (não INNER — preserva linhas legadas sem número)', async () => {
  const { pool, calls } = fakePool([]);
  await listLinkedGroups(pool, 'ws-cliente');
  assert.match(calls[0].sql, /LEFT JOIN whatsapp_numbers/);
});

// Gate 2 foi removido por decisão de produto (ver group-links.ts / group-read-routes.ts):
// a condição só existia pra impedir que aquele gate virasse tautologia. Sem o
// gate, a condição não protege mais nada — e bloquearia vínculos legítimos em
// que o número é do mesmo workspace do cliente.
test('SELECT não filtra mais por n.workspace_id <> g.linked_workspace_id (gate 2 removido)', async () => {
  const { pool, calls } = fakePool([NUMBER_ROW]);
  await resolveLinkedGroup(pool, 'ws-cliente', '+120363001');
  assert.doesNotMatch(calls[0].sql, /n\.workspace_id\s*<>\s*g\.linked_workspace_id/);
});
