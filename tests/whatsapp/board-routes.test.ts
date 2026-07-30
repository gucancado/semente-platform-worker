/**
 * tests/whatsapp/board-routes.test.ts — teste de ROTA (stub pool, sem DB).
 *
 * Cobre (Task C1.2): auth (401/400 ator), validação de params (number_id,
 * limit_per_column, column, cursor), 404 número inexistente, 403 gate, e o SHAPE
 * do envelope — as 5 chaves de coluna SEMPRE presentes, cada uma
 * {cards,nextCursor,total}; modo column+cursor encaminha os params ao SQL.
 *
 * A correção da projeção SQL é do board.db.test.ts; aqui só o wiring da rota.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerBoardRoutes } from '../../src/whatsapp/board-routes.js';
import { encodeBoardCursor } from '../../src/whatsapp/board.js';

const TOKEN = 'panel';
const headers = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
const D = (n: number) => new Date(`2026-07-${String(n).padStart(2, '0')}T12:00:00.000Z`);

type CardRow = {
  opp_id: number; identifier: string; title: string | null; status: string;
  is_qualified: boolean | null; loss_reason: string | null; board_column: string;
  contact_name: string | null; tags: any[]; last_at_raw: Date | null;
};

function makePool(opts: {
  numberFound?: boolean;
  cards?: CardRow[];
  counts?: Record<string, number>;
} = {}) {
  const state = { queries: [] as { text: string; params: any[] }[] };
  const found = opts.numberFound ?? true;
  const cards = opts.cards ?? [];
  const counts = opts.counts ?? {};
  const query = async (text: string, params: any[] = []) => {
    state.queries.push({ text, params });
    if (/FROM whatsapp_numbers WHERE id/.test(text)) {
      return found && Number(params[0]) === 1
        ? { rows: [{ id: 1, workspace_id: 'ws-1', phone: '+5511', evolution_instance: 'i', label: 'N',
            status: 'connected', mode: 'monitored', expose_groups_in_mcp: false, created_by: null,
            created_at: D(1), updated_at: D(1), removed_at: null }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/GROUP BY board_column/.test(text)) {
      return { rows: Object.entries(counts).map(([board_column, total]) => ({ board_column, total })), rowCount: 0 };
    }
    if (/ROW_NUMBER\(\) OVER/.test(text)) {
      return { rows: cards, rowCount: cards.length };
    }
    if (/INSERT INTO whatsapp_access_log/.test(text)) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { pool: { query, connect: async () => ({ query, release() {} }) } as any, state };
}

function appFor(pool: any, authz: any = passAuthz) {
  const app = Fastify({ logger: false });
  registerBoardRoutes(app, { pool, panelToken: TOKEN, authz, logAccess: () => {} });
  return app;
}

const CARDS: CardRow[] = [
  { opp_id: 1, identifier: 'c1', title: null, status: 'em_andamento', is_qualified: null,
    loss_reason: null, board_column: 'novas_conversas', contact_name: 'Alice', tags: [], last_at_raw: D(20) },
  { opp_id: 2, identifier: 'c2', title: 'Deal', status: 'ganho', is_qualified: true,
    loss_reason: null, board_column: 'ganhos', contact_name: null,
    tags: [{ id: 5, name: 'VIP', color: 'warn' }], last_at_raw: D(18) },
];
const COUNTS = { novas_conversas: 3, negociacoes: 1, ganhos: 2, perdas: 4 };

// ── Auth ───────────────────────────────────────────────────────────────────────

test('401 sem X-Panel-Token', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1' });
  assert.equal(res.statusCode, 401); await app.close();
});

test('400 sem x-acting-user (não toca o DB)', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1', headers: { 'x-panel-token': TOKEN } });
  assert.equal(res.statusCode, 400);
  assert.equal(state.queries.length, 0, 'sem query de número antes do ator');
  await app.close();
});

// ── Validação de params ─────────────────────────────────────────────────────────

test('400 sem number_id / number_id não-numérico', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  assert.equal((await app.inject({ method: 'GET', url: '/whatsapp/board', headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=abc', headers })).statusCode, 400);
  await app.close();
});

test('400 limit_per_column fora de 1..100', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  for (const v of ['0', '101', '-1', 'x', '1.5']) {
    const res = await app.inject({ method: 'GET', url: `/whatsapp/board?number_id=1&limit_per_column=${v}`, headers });
    assert.equal(res.statusCode, 400, `limit=${v}`);
  }
  await app.close();
});

test('400 column inválida', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1&column=ganho', headers });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'invalid column' }); await app.close();
});

test('400 cursor sem column', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const cur = encodeBoardCursor(D(10).toISOString(), 9);
  const res = await app.inject({ method: 'GET', url: `/whatsapp/board?number_id=1&cursor=${encodeURIComponent(cur)}`, headers });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'cursor requires column' }); await app.close();
});

test('400 cursor inválido (com column)', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1&column=ganhos&cursor=lixo!!', headers });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'invalid cursor' }); await app.close();
});

// ── 404 / 403 ────────────────────────────────────────────────────────────────────

test('404 número inexistente', async () => {
  const { pool } = makePool({ numberFound: false }); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1', headers });
  assert.equal(res.statusCode, 404); await app.close();
});

test('403 quando gateMember nega', async () => {
  const { pool } = makePool();
  const authz = { assertMember: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); }, assertAdmin: async () => {} };
  const app = appFor(pool, authz);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1', headers });
  assert.equal(res.statusCode, 403); await app.close();
});

// ── Shape do envelope ────────────────────────────────────────────────────────────

test('200: envelope + 5 chaves de coluna SEMPRE presentes com {cards,nextCursor,total}', async () => {
  const { pool } = makePool({ cards: CARDS, counts: COUNTS }); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1', headers });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.context.number.id, 1);
  assert.ok(body.generatedAt);
  const cols = body.columns;
  assert.deepEqual(Object.keys(cols), ['novas_conversas', 'interessados', 'negociacoes', 'ganhos', 'perdas']);
  for (const k of Object.keys(cols)) {
    assert.ok(Array.isArray(cols[k].cards), `${k}.cards é array`);
    assert.ok('nextCursor' in cols[k], `${k}.nextCursor presente`);
    assert.equal(typeof cols[k].total, 'number', `${k}.total numérico`);
  }
  // totais vêm do COUNT (independentes do limit); coluna ausente do COUNT → 0.
  assert.equal(cols.novas_conversas.total, 3);
  assert.equal(cols.ganhos.total, 2);
  assert.equal(cols.perdas.total, 4);
  assert.equal(cols.interessados.total, 0, 'coluna sem count → total 0');
  // cards mapeados na coluna certa.
  assert.equal(cols.novas_conversas.cards.length, 1);
  assert.equal(cols.novas_conversas.cards[0].contactName, 'Alice');
  assert.equal(cols.novas_conversas.cards[0].lastMessageAt, D(20).toISOString());
  assert.equal(cols.novas_conversas.cards[0].opportunity.qualification, 'indefinido');
  assert.equal(cols.ganhos.cards[0].opportunity.title, 'Deal');
  assert.deepEqual(cols.ganhos.cards[0].opportunity.tags, [{ id: 5, name: 'VIP', color: 'warn' }]);
  // coluna vazia mantém o contrato.
  assert.deepEqual(cols.negociacoes, { cards: [], nextCursor: null, total: 1 });
  await app.close();
});

test('200: limit_per_column default 30 → cards query pede $7 = 31 (limit+1)', async () => {
  const { pool, state } = makePool({ cards: [], counts: {} }); const app = appFor(pool);
  await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1', headers });
  const cardsQ = state.queries.find(q => /ROW_NUMBER\(\) OVER/.test(q.text))!;
  assert.equal(cardsQ.params[6], 31, '$7 = limit+1');
  assert.equal(cardsQ.params[2], null, '$3 column null (todas as colunas)');
  assert.equal(cardsQ.params[5], false, '$6 cursorPresent false');
  await app.close();
});

test('200: nextCursor setado quando há mais que o limit numa coluna', async () => {
  // 2 cards em novas_conversas, limit 1 → 1 card + nextCursor derivado do 1º.
  const twoInOne: CardRow[] = [
    { ...CARDS[0], opp_id: 10, last_at_raw: D(20) },
    { ...CARDS[0], opp_id: 11, last_at_raw: D(19) },
  ];
  const { pool } = makePool({ cards: twoInOne, counts: { novas_conversas: 2 } }); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/board?number_id=1&limit_per_column=1', headers });
  const col = res.json().columns.novas_conversas;
  assert.equal(col.cards.length, 1);
  assert.ok(col.nextCursor, 'nextCursor presente');
  await app.close();
});

test('200: column+cursor encaminha column ($3) + cursor ($4/$5) + cursorPresent ($6) ao SQL', async () => {
  const { pool, state } = makePool({ cards: [], counts: COUNTS }); const app = appFor(pool);
  const cur = encodeBoardCursor(D(15).toISOString(), 42);
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/board?number_id=1&column=ganhos&cursor=${encodeURIComponent(cur)}`, headers,
  });
  assert.equal(res.statusCode, 200);
  const cardsQ = state.queries.find(q => /ROW_NUMBER\(\) OVER/.test(q.text))!;
  assert.equal(cardsQ.params[2], 'ganhos', '$3 = column');
  assert.equal(cardsQ.params[3], D(15).toISOString(), '$4 = cursor.lastMessageAt');
  assert.equal(cardsQ.params[4], 42, '$5 = cursor.oppId');
  assert.equal(cardsQ.params[5], true, '$6 cursorPresent true');
  // As 5 chaves seguem presentes mesmo no modo single-column (carregar mais).
  assert.deepEqual(Object.keys(res.json().columns), ['novas_conversas', 'interessados', 'negociacoes', 'ganhos', 'perdas']);
  await app.close();
});

test('200: cursor com lastMessageAt null (cauda NULLS LAST) → $4 null, $5 oppId', async () => {
  const { pool, state } = makePool({ cards: [], counts: {} }); const app = appFor(pool);
  const cur = encodeBoardCursor(null, 7);
  await app.inject({ method: 'GET', url: `/whatsapp/board?number_id=1&column=perdas&cursor=${encodeURIComponent(cur)}`, headers });
  const cardsQ = state.queries.find(q => /ROW_NUMBER\(\) OVER/.test(q.text))!;
  assert.equal(cardsQ.params[3], null, '$4 null');
  assert.equal(cardsQ.params[4], 7, '$5 oppId');
  assert.equal(cardsQ.params[5], true);
  await app.close();
});
