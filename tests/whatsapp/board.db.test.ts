/**
 * tests/whatsapp/board.db.test.ts  (roda no servidor/CI com DATABASE_URL)
 * SERVER-GATED: requires a live Postgres. Run ONE FILE AT A TIME.
 *
 * Prova o CASE `board_column` REAL + a projeção do board contra Postgres (o que os
 * testes puros não alcançam):
 *   1. Fixtures nas 4 colunas → cada opp cai na coluna certa (spec §1).
 *   2. statusFilter (toggle §2): default 'em_andamento' mostra as opps em andamento
 *      nas 3 colunas de posição; 'perdido' mostra as perdidas na MESMA posição;
 *      'ganhos' ignora o filtro (sempre visível). Totais refletem o filtro.
 *   3. Exclusões: not_lead (is_lead=FALSE), perda nao_lead (cascata) e grupos
 *      (row em whatsapp_groups OU mensagem com author) ficam FORA do board.
 *   4. Ordenação por última atividade DESC (NULLS LAST) + totais independentes do
 *      limit + paginação por cursor dentro de uma coluna + contactName (push_name).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getBoard, decodeBoardCursor, BOARD_COLUMN_CASE_SQL } from '../../src/whatsapp/board.js';
import { boardColumn, type OppStatus } from '../../src/whatsapp/opportunity-core.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events,
  whatsapp_opportunity_tags, whatsapp_tags, whatsapp_thread_meta, whatsapp_groups, webhook_logs
  RESTART IDENTITY CASCADE`;

beforeEach(async () => {
  await pool.query(TRUNCATE);
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','inst-1')`);
});
after(() => pool.end());

async function insertMsg(o: {
  identifier: string; createdAt: string; direction?: string; author?: string | null; eventId?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at, author, evolution_event_id)
     VALUES (1,'ws','whatsapp',$1,$2,'msg',$3,$4,$5)`,
    [o.identifier, o.direction ?? 'inbound', o.createdAt, o.author ?? null, o.eventId ?? null],
  );
}

async function insertLead(identifier: string, isLead: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (1,$1,$2)`,
    [identifier, isLead],
  );
}

async function insertOpp(o: {
  identifier: string; status: string; isQualified: boolean | null; lossReason?: string | null;
}): Promise<number> {
  const closed = o.status === 'em_andamento' ? null : '2026-07-01T00:00:00Z';
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_opportunities (whatsapp_number_id, workspace_id, identifier, status, is_qualified, loss_reason, closed_at)
     VALUES (1,'ws',$1,$2,$3,$4,$5) RETURNING id`,
    [o.identifier, o.status, o.isQualified, o.lossReason ?? null, closed],
  );
  return Number(rows[0].id);
}

const ids = (cards: { identifier: string }[]) => cards.map((c) => c.identifier);

/**
 * Monta as 4 colunas em DOIS modos do toggle + as exclusões:
 *  - em andamento: nova·int·neg (posição) + ganho (sempre em ganhos).
 *  - perdido: perda_nova·perda_int·perda_neg caem na MESMA posição (§1), visíveis
 *    só no modo 'perdido'.
 *  - exclusões: not_lead, perda nao_lead (cascata), grupos.
 */
async function seedAllColumns(): Promise<void> {
  // ── modo em andamento (as 3 posições) + ganho ──
  await insertMsg({ identifier: 'nova', createdAt: '2026-07-20T00:00:00Z', eventId: 'ev-nova' });
  await insertOpp({ identifier: 'nova', status: 'em_andamento', isQualified: null }); // sem thread_meta → is_lead NULL

  await insertMsg({ identifier: 'int', createdAt: '2026-07-19T00:00:00Z' });
  await insertLead('int', true);
  await insertOpp({ identifier: 'int', status: 'em_andamento', isQualified: null });

  await insertMsg({ identifier: 'neg', createdAt: '2026-07-18T00:00:00Z' });
  await insertLead('neg', true);
  await insertOpp({ identifier: 'neg', status: 'em_andamento', isQualified: true });

  await insertMsg({ identifier: 'ganho', createdAt: '2026-07-17T00:00:00Z' });
  await insertLead('ganho', true);
  await insertOpp({ identifier: 'ganho', status: 'ganho', isQualified: true });

  // ── modo perdido: perdidas caem na coluna de POSIÇÃO (não mais numa 'perdas') ──
  await insertMsg({ identifier: 'perda_nova', createdAt: '2026-07-16T00:00:00Z' });
  await insertOpp({ identifier: 'perda_nova', status: 'perdido', isQualified: null, lossReason: 'sem_orcamento' }); // is_lead NULL → novas_conversas

  await insertMsg({ identifier: 'perda_int', createdAt: '2026-07-15T12:00:00Z' });
  await insertLead('perda_int', true);
  await insertOpp({ identifier: 'perda_int', status: 'perdido', isQualified: null, lossReason: 'sem_orcamento' }); // lead + isQ null → interessados

  await insertMsg({ identifier: 'perda_neg', createdAt: '2026-07-15T00:00:00Z' });
  await insertLead('perda_neg', true);
  await insertOpp({ identifier: 'perda_neg', status: 'perdido', isQualified: true, lossReason: 'sem_orcamento' }); // qualificado → negociacoes

  // ── exclusões ──
  await insertMsg({ identifier: 'notlead', createdAt: '2026-07-14T12:00:00Z' });
  await insertLead('notlead', false);
  await insertOpp({ identifier: 'notlead', status: 'perdido', isQualified: null, lossReason: 'nao_lead' });

  await insertMsg({ identifier: 'naolead', createdAt: '2026-07-14T00:00:00Z' });
  await insertLead('naolead', true);
  await insertOpp({ identifier: 'naolead', status: 'perdido', isQualified: null, lossReason: 'nao_lead' });

  // grupo por row em whatsapp_groups
  await insertMsg({ identifier: 'g1@g.us', createdAt: '2026-07-13T00:00:00Z' });
  await insertLead('g1@g.us', true);
  await insertOpp({ identifier: 'g1@g.us', status: 'em_andamento', isQualified: null });
  await pool.query(
    `INSERT INTO whatsapp_groups (jid, subject, whatsapp_number_id, workspace_id) VALUES ('g1@g.us','Grupo',1,'ws')`,
  );

  // grupo por mensagem com author
  await insertMsg({ identifier: 'g2', createdAt: '2026-07-12T00:00:00Z', author: '+5511999999999' });
  await insertLead('g2', true);
  await insertOpp({ identifier: 'g2', status: 'em_andamento', isQualified: null });
}

test('modo em andamento (default): as 4 colunas recebem as opps certas; exclusões e perdidas ficam fora', async () => {
  await seedAllColumns();
  const { columns } = await getBoard(pool, { workspaceId: 'ws', numberId: 1, limitPerColumn: 30 });

  // As 4 chaves canônicas, sem 'perdas'.
  assert.deepEqual(Object.keys(columns), ['novas_conversas', 'interessados', 'negociacoes', 'ganhos']);

  assert.deepEqual(ids(columns.novas_conversas.cards), ['nova']);
  assert.deepEqual(ids(columns.interessados.cards), ['int']);
  assert.deepEqual(ids(columns.negociacoes.cards), ['neg']);
  assert.deepEqual(ids(columns.ganhos.cards), ['ganho']);

  // Perdidas NÃO aparecem no modo em andamento (default); exclusões nunca aparecem.
  const all = Object.values(columns).flatMap((c) => ids(c.cards));
  for (const hidden of ['perda_nova', 'perda_int', 'perda_neg', 'notlead', 'naolead', 'g1@g.us', 'g2']) {
    assert.equal(all.includes(hidden), false, `${hidden} fora do modo em andamento`);
  }

  // Totais coerentes (refletem o filtro em andamento).
  assert.equal(columns.novas_conversas.total, 1);
  assert.equal(columns.interessados.total, 1);
  assert.equal(columns.negociacoes.total, 1);
  assert.equal(columns.ganhos.total, 1);
});

test('modo perdido (statusFilter): perdidas caem na coluna de posição; ganhos permanece; em andamento some', async () => {
  await seedAllColumns();
  const { columns } = await getBoard(pool, {
    workspaceId: 'ws', numberId: 1, limitPerColumn: 30, statusFilter: 'perdido',
  });

  assert.deepEqual(Object.keys(columns), ['novas_conversas', 'interessados', 'negociacoes', 'ganhos']);

  // As 3 colunas de posição mostram AGORA as perdidas (mesma posição), não as em andamento.
  assert.deepEqual(ids(columns.novas_conversas.cards), ['perda_nova']);
  assert.deepEqual(ids(columns.interessados.cards), ['perda_int']);
  assert.deepEqual(ids(columns.negociacoes.cards), ['perda_neg']);
  // ganhos IGNORA o filtro — segue mostrando o ganho nos 2 modos.
  assert.deepEqual(ids(columns.ganhos.cards), ['ganho']);

  // As em andamento (e as exclusões) somem no modo perdido.
  const all = Object.values(columns).flatMap((c) => ids(c.cards));
  for (const hidden of ['nova', 'int', 'neg', 'notlead', 'naolead', 'g1@g.us', 'g2']) {
    assert.equal(all.includes(hidden), false, `${hidden} fora do modo perdido`);
  }

  // Totais refletem o filtro perdido.
  assert.equal(columns.novas_conversas.total, 1);
  assert.equal(columns.interessados.total, 1);
  assert.equal(columns.negociacoes.total, 1);
  assert.equal(columns.ganhos.total, 1);
});

test('ordenação por última atividade DESC com NULLS LAST', async () => {
  // 3 interessados: int (mais nova) > int2 (mais velha) > int3 (sem mensagem → null, por último).
  await insertMsg({ identifier: 'int', createdAt: '2026-07-19T00:00:00Z' });
  await insertLead('int', true);
  await insertOpp({ identifier: 'int', status: 'em_andamento', isQualified: null });

  await insertMsg({ identifier: 'int2', createdAt: '2026-07-15T00:00:00Z' });
  await insertLead('int2', true);
  await insertOpp({ identifier: 'int2', status: 'em_andamento', isQualified: null });

  await insertLead('int3', true); // sem mensagem → lastMessageAt null
  await insertOpp({ identifier: 'int3', status: 'em_andamento', isQualified: null });

  const { columns } = await getBoard(pool, { workspaceId: 'ws', numberId: 1, limitPerColumn: 30 });
  assert.deepEqual(ids(columns.interessados.cards), ['int', 'int2', 'int3']);
  assert.equal(columns.interessados.cards[0].lastMessageAt, new Date('2026-07-19T00:00:00Z').toISOString());
  assert.equal(columns.interessados.cards[2].lastMessageAt, null, 'int3 sem mensagem = null, por último');
});

test('total é independente do limit; paginação por cursor dentro da coluna', async () => {
  for (const [i, id] of ['a', 'b', 'c'].entries()) {
    await insertMsg({ identifier: id, createdAt: `2026-07-${20 - i}T00:00:00Z` }); // a>b>c por data
    await insertLead(id, true);
    await insertOpp({ identifier: id, status: 'em_andamento', isQualified: null });
  }

  // Primeira página da coluna interessados, limit 2 → [a,b] + nextCursor; total=3.
  const p1 = await getBoard(pool, { workspaceId: 'ws', numberId: 1, limitPerColumn: 2, column: 'interessados' });
  assert.deepEqual(ids(p1.columns.interessados.cards), ['a', 'b']);
  assert.equal(p1.columns.interessados.total, 3, 'total independe do limit');
  assert.ok(p1.columns.interessados.nextCursor);
  // As 5 chaves seguem presentes mesmo no modo single-column.
  assert.deepEqual(Object.keys(p1.columns), ['novas_conversas', 'interessados', 'negociacoes', 'ganhos', 'perdas']);

  // Segunda página via cursor → [c], sem nextCursor.
  const cur = decodeBoardCursor(p1.columns.interessados.nextCursor!)!;
  const p2 = await getBoard(pool, { workspaceId: 'ws', numberId: 1, limitPerColumn: 2, column: 'interessados', cursor: cur });
  assert.deepEqual(ids(p2.columns.interessados.cards), ['c']);
  assert.equal(p2.columns.interessados.nextCursor, null);
});

test('CASE board_column REAL == kernel boardColumn nos 81 estados (via VALUES)', async () => {
  // Blindagem de regressão: exercita o CASE SQL de board.ts (BOARD_COLUMN_CASE_SQL,
  // fonte única) sobre TODOS os 81 estados — inclusive os sensíveis à ORDEM dos
  // WHENs que os fixtures em tabela não alcançam (ganho/perdido com is_lead NULL;
  // em_andamento+lead+is_qualified=FALSE → ELSE). Reordenar o CASE quebra este teste.
  // VALUES não passa por CHECK, então estados impossíveis em tabela existem aqui.
  const LEADS: (boolean | null)[] = [null, true, false];
  const STATUSES: OppStatus[] = ['em_andamento', 'ganho', 'perdido'];
  const QUALS: (boolean | null)[] = [null, true, false];
  const LOSS: (string | null)[] = [null, 'nao_lead', 'sem_orcamento'];

  const tuples: { isLead: boolean | null; status: OppStatus; isQualified: boolean | null; lossReason: string | null }[] = [];
  for (const isLead of LEADS)
    for (const status of STATUSES)
      for (const isQualified of QUALS)
        for (const lossReason of LOSS)
          tuples.push({ isLead, status, isQualified, lossReason });
  assert.equal(tuples.length, 81);

  // Literais 100% test-controlled (enums fixos) → sem risco de injeção; casts
  // explícitos por valor pra o VALUES ter tipos de coluna determinísticos.
  const boolLit = (v: boolean | null) => (v === null ? 'NULL::boolean' : v ? 'TRUE' : 'FALSE');
  const textLit = (v: string | null) => (v === null ? 'NULL::text' : `'${v}'::text`);
  const rowsSql = tuples
    .map((t, i) => `(${i}, ${boolLit(t.isLead)}, ${textLit(t.status)}, ${boolLit(t.isQualified)}, ${textLit(t.lossReason)})`)
    .join(',\n');

  const { rows } = await pool.query(
    `SELECT idx, (${BOARD_COLUMN_CASE_SQL}) AS board_column
       FROM (VALUES ${rowsSql}) AS t(idx, is_lead, status, is_qualified, loss_reason)
      ORDER BY idx`,
  );
  assert.equal(rows.length, 81);
  for (const r of rows) {
    const t = tuples[Number(r.idx)];
    const kernel = boardColumn(t.isLead, { status: t.status, isQualified: t.isQualified, lossReason: t.lossReason });
    assert.equal(
      r.board_column, kernel,
      `divergência SQL↔kernel idx=${r.idx} isLead=${t.isLead} status=${t.status} isQ=${t.isQualified} loss=${t.lossReason}: sql=${r.board_column} kernel=${kernel}`,
    );
  }
});

test('contactName vem do push_name de evento com mensagem inbound', async () => {
  await insertMsg({ identifier: 'nova', createdAt: '2026-07-20T00:00:00Z', eventId: 'ev-nova' });
  await insertOpp({ identifier: 'nova', status: 'em_andamento', isQualified: null });
  await pool.query(
    `INSERT INTO webhook_logs (agent, channel, identifier, evolution_event_id, push_name, whatsapp_number_id)
     VALUES ('sys','whatsapp','nova','ev-nova','Alice',1)`,
  );

  const { columns } = await getBoard(pool, { workspaceId: 'ws', numberId: 1, limitPerColumn: 30 });
  assert.equal(columns.novas_conversas.cards[0].contactName, 'Alice');
});
