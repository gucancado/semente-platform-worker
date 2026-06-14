// Task 15 — ciclo de condutas (proposta -> portao Bloquim -> approve/reject) + get_condutas.
// DB vivo + FAKE LlmClient + FAKE createApprovalTask (sem rede). Token de owner
// vem do env-file c:/tmp/lua-test.env; token de agente e `testworkertoken`.
//
// Ordem de transicao testada (spec §9, load-bearing para os indices parciais
// idx_condutas_one_active / idx_condutas_one_proposed):
//  - propor de novo: proposta anterior -> rejected ANTES do INSERT da nova;
//  - aprovar: ativa anterior -> superseded ANTES de proposta -> active.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool } from '../../src/db.js';
import { registerMemoriaRoutes } from '../../src/lua/routes.js';
import type { LlmClient } from '../../src/lua/llm.js';
import {
  proposeConduta,
  approveConduta,
  rejectConduta,
  type CreateApprovalTask,
} from '../../src/lua/condutas.js';

const AGENT_TOKEN = 'testworkertoken';
const agentAuth = { 'x-agent-token': AGENT_TOKEN };
const OWNER_TOKEN = process.env.OWNER_ADMIN_TOKEN!;
const ownerAuth = { 'x-owner-token': OWNER_TOKEN };

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerMemoriaRoutes);
  return app;
}

// ── Fakes ─────────────────────────────────────────────────────────────────

/** LlmClient roteirizado: devolve o objeto fornecido em cada complete(). */
class FakeLlm {
  calls = 0;
  readonly client: LlmClient;
  constructor(scripted: { content_md: string; rules: { text: string; fact_ids: number[] }[] }) {
    this.client = {
      model: 'fake-sonnet@condutas',
      complete: async <T = unknown>(): Promise<T> => {
        this.calls += 1;
        return scripted as unknown as T;
      },
    };
  }
}
function fakeLlm(scripted: { content_md: string; rules: { text: string; fact_ids: number[] }[] }): FakeLlm {
  return new FakeLlm(scripted);
}

/** createApprovalTask espiao: registra os args e devolve {id}. */
function fakeApprovalTask(id = 'task_1'): { fn: CreateApprovalTask; calls: { workspaceId: string; title: string; description: string }[] } {
  const calls: { workspaceId: string; title: string; description: string }[] = [];
  const fn: CreateApprovalTask = async (args) => {
    calls.push(args);
    return { id };
  };
  return { fn, calls };
}

// ── Seed helpers ────────────────────────────────────────────────────────────

function toVec(): string {
  return `[${new Array(1024).fill(0).join(',')}]`;
}

async function seedEpisode(externalId: string, workspaceId: string | null): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, '2026-05-01T14:00:00Z', $3, 1)
     RETURNING id`,
    [externalId, `ep ${externalId}`, workspaceId]
  );
  return Number(rows[0]!.id);
}

async function seedFact(args: {
  workspaceId: string;
  factType?: string;
  statement: string;
  episodeId: number;
  validAt?: string;
  invalidAt?: string | null;
  invalidationReason?: string | null;
  turnStart?: number;
  turnEnd?: number;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO facts
       (workspace_id, fact_type, statement, confidence, valid_at, invalid_at, invalidation_reason,
        episode_id, episode_revision, turn_start, turn_end,
        embedding, embedding_model, extracted_by)
     VALUES ($1,$2,$3,0.9,$4,$5,$6,$7,1,$8,$9,$10::vector,'fake@1024','test')
     RETURNING id`,
    [
      args.workspaceId,
      args.factType ?? 'preferencia',
      args.statement,
      args.validAt ?? '2026-05-01T00:00:00Z',
      args.invalidAt ?? null,
      args.invalidationReason ?? null,
      args.episodeId,
      args.turnStart ?? 0,
      args.turnEnd ?? 1,
      toVec(),
    ]
  );
  return Number(rows[0]!.id);
}

async function condutaRow(id: number): Promise<{ status: string; version: number; proposed_by: string; approval_task_id: string | null; content_md: string; approved_by: string | null; rejection_note: string | null } | null> {
  const { rows } = await pool.query(
    `SELECT status, version, proposed_by, approval_task_id, content_md, approved_by, rejection_note
       FROM condutas WHERE id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  return {
    status: rows[0].status,
    version: Number(rows[0].version),
    proposed_by: rows[0].proposed_by,
    approval_task_id: rows[0].approval_task_id,
    content_md: rows[0].content_md,
    approved_by: rows[0].approved_by,
    rejection_note: rows[0].rejection_note,
  };
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE condutas, conduta_rules, conduta_rule_sources,
              lua_processing, lua_runs, episode_chunks, facts,
              recaps, recap_sources, project_status, project_status_sources,
              episodes, episode_turns RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

// ── proposeConduta ──────────────────────────────────────────────────────────

test('propose: cria conduta v1 com regras+fontes, grava approval_task_id, chama portao 1x', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'aprovar criativo com Fulana', episodeId: ep, turnStart: 41, turnEnd: 44 });
  const f2 = await seedFact({ workspaceId: 'w1', factType: 'restricao', statement: 'nunca pausar campanha sem aviso', episodeId: ep, turnStart: 60, turnEnd: 62 });

  const llm = fakeLlm({
    content_md: '## Conduta — w1\n1. Aprovar criativo com Fulana\n2. Nunca pausar sem aviso',
    rules: [
      { text: 'Aprovar criativo com Fulana', fact_ids: [f1] },
      { text: 'Nunca pausar campanha sem aviso', fact_ids: [f2] },
    ],
  });
  const portao = fakeApprovalTask('task_99');

  const id = await proposeConduta('w1', { llm: llm.client, createApprovalTask: portao.fn });
  assert.ok(id, 'esperava id de conduta');

  const c = await condutaRow(id!);
  assert.equal(c!.status, 'proposed');
  assert.equal(c!.version, 1);
  assert.equal(c!.proposed_by, 'lua');
  assert.equal(c!.approval_task_id, 'task_99');

  const { rows: rules } = await pool.query(`SELECT id, rule_index, text FROM conduta_rules WHERE conduta_id=$1 ORDER BY rule_index`, [id]);
  assert.equal(rules.length, 2);
  assert.equal(rules[0]!.text, 'Aprovar criativo com Fulana');

  const { rows: srcs } = await pool.query(`SELECT fact_id FROM conduta_rule_sources WHERE rule_id=$1`, [rules[0]!.id]);
  assert.equal(srcs.length, 1);
  assert.equal(Number(srcs[0]!.fact_id), f1);

  assert.equal(portao.calls.length, 1);
  assert.equal(portao.calls[0]!.workspaceId, 'w1');
  assert.match(portao.calls[0]!.title, /conduta v1/);
  assert.equal(llm.calls, 1);
});

test('propose: sem fatos elegiveis novos → null, sem chamar LLM nem portao', async () => {
  const ep = await seedEpisode('e1', 'w1');
  // fato de tipo NAO elegivel (contexto) — nao dispara conduta
  await seedFact({ workspaceId: 'w1', factType: 'contexto', statement: 'cliente e e-commerce', episodeId: ep });

  const llm = fakeLlm({ content_md: 'x', rules: [] });
  const portao = fakeApprovalTask();
  const id = await proposeConduta('w1', { llm: llm.client, createApprovalTask: portao.fn });
  assert.equal(id, null);
  assert.equal(llm.calls, 0);
  assert.equal(portao.calls.length, 0);
});

test('propose: citacao inventada (fact_id inexistente/outro workspace) → descarta, null, nada persiste', async () => {
  const epA = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: epA });
  const epB = await seedEpisode('e2', 'w2');
  const fOther = await seedFact({ workspaceId: 'w2', factType: 'preferencia', statement: 'de outro ws', episodeId: epB });

  // LLM cita f1 (valido) + fOther (de w2) + 999999 (inexistente)
  const llm = fakeLlm({
    content_md: 'x',
    rules: [{ text: 'regra', fact_ids: [f1, fOther, 999999] }],
  });
  const portao = fakeApprovalTask();
  const id = await proposeConduta('w1', { llm: llm.client, createApprovalTask: portao.fn });
  assert.equal(id, null);

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM condutas WHERE workspace_id='w1'`);
  assert.equal(rows[0]!.n, 0);
  const { rows: r2 } = await pool.query(`SELECT count(*)::int AS n FROM conduta_rules`);
  assert.equal(r2[0]!.n, 0);
  assert.equal(portao.calls.length, 0, 'portao nao deve ser chamado em proposta descartada');
});

test('propose de novo: proposta anterior vira rejected(superseded_by_newer_proposal) ANTES da nova; so 1 proposed', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep });

  const llm1 = fakeLlm({ content_md: 'v1', rules: [{ text: 'r1', fact_ids: [f1] }] });
  const id1 = await proposeConduta('w1', { llm: llm1.client, createApprovalTask: fakeApprovalTask().fn });
  assert.ok(id1);

  // segundo fato elegivel novo dispara nova proposta
  const f2 = await seedFact({ workspaceId: 'w1', factType: 'restricao', statement: 'r2', episodeId: ep });
  const llm2 = fakeLlm({ content_md: 'v2', rules: [{ text: 'r1', fact_ids: [f1] }, { text: 'r2', fact_ids: [f2] }] });
  const id2 = await proposeConduta('w1', { llm: llm2.client, createApprovalTask: fakeApprovalTask().fn });
  assert.ok(id2);
  assert.notEqual(id1, id2);

  const old = await condutaRow(id1!);
  assert.equal(old!.status, 'rejected');
  assert.equal(old!.rejection_note, 'superseded_by_newer_proposal');

  const novo = await condutaRow(id2!);
  assert.equal(novo!.status, 'proposed');
  assert.equal(novo!.version, 2);

  // invariante do indice parcial: exatamente 1 proposed
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM condutas WHERE workspace_id='w1' AND status='proposed'`);
  assert.equal(rows[0]!.n, 1);
});

// ── approveConduta ──────────────────────────────────────────────────────────

test('approve: ativa anterior → superseded ANTES; proposta → active; so 1 active', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep });

  const id1 = await proposeConduta('w1', { llm: fakeLlm({ content_md: 'v1', rules: [{ text: 'r1', fact_ids: [f1] }] }).client, createApprovalTask: fakeApprovalTask().fn });
  await approveConduta(id1!, { approvedBy: 'gustavo' });
  let c1 = await condutaRow(id1!);
  assert.equal(c1!.status, 'active');
  assert.equal(c1!.approved_by, 'gustavo');

  // nova proposta (precisa de fato novo elegivel)
  const f2 = await seedFact({ workspaceId: 'w1', factType: 'restricao', statement: 'r2', episodeId: ep });
  const id2 = await proposeConduta('w1', { llm: fakeLlm({ content_md: 'v2', rules: [{ text: 'r1', fact_ids: [f1] }, { text: 'r2', fact_ids: [f2] }] }).client, createApprovalTask: fakeApprovalTask().fn });
  await approveConduta(id2!, { approvedBy: 'gustavo' });

  c1 = await condutaRow(id1!);
  assert.equal(c1!.status, 'superseded');
  const c2 = await condutaRow(id2!);
  assert.equal(c2!.status, 'active');

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM condutas WHERE workspace_id='w1' AND status='active'`);
  assert.equal(rows[0]!.n, 1);
});

test('approve: contentMdOverride usa o texto ajustado e proposed_by vira human:<id>', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep });
  const id1 = await proposeConduta('w1', { llm: fakeLlm({ content_md: 'v1 da lua', rules: [{ text: 'r1', fact_ids: [f1] }] }).client, createApprovalTask: fakeApprovalTask().fn });
  await approveConduta(id1!, { approvedBy: 'gustavo', contentMdOverride: 'v1 editada pelo humano' });
  const c = await condutaRow(id1!);
  assert.equal(c!.status, 'active');
  assert.equal(c!.content_md, 'v1 editada pelo humano');
  assert.equal(c!.proposed_by, 'human:gustavo');
});

// ── rejectConduta ───────────────────────────────────────────────────────────

test('reject: status rejected + nota gravada', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep });
  const id1 = await proposeConduta('w1', { llm: fakeLlm({ content_md: 'v1', rules: [{ text: 'r1', fact_ids: [f1] }] }).client, createApprovalTask: fakeApprovalTask().fn });
  await rejectConduta(id1!, { note: 'preferimos manter o processo antigo' });
  const c = await condutaRow(id1!);
  assert.equal(c!.status, 'rejected');
  assert.equal(c!.rejection_note, 'preferimos manter o processo antigo');
});

// ── get_condutas (REST agent-scope) ──────────────────────────────────────────

test('GET /memoria/condutas: ativa com version, content_md, rules+sources', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep, turnStart: 41, turnEnd: 44 });
  const id1 = await proposeConduta('w1', { llm: fakeLlm({ content_md: '## Conduta\n1. Aprovar com Fulana', rules: [{ text: 'Aprovar com Fulana', fact_ids: [f1] }] }).client, createApprovalTask: fakeApprovalTask().fn });
  await approveConduta(id1!, { approvedBy: 'gustavo' });

  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/memoria/condutas?workspace_id=w1', headers: agentAuth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'conduta_v1');
  assert.equal(body.workspace_id, 'w1');
  assert.equal(body.version, 1);
  assert.match(body.content_md, /Aprovar com Fulana/);
  assert.equal(body.rules.length, 1);
  assert.equal(body.rules[0].rule_index, 0);
  assert.equal(body.rules[0].text, 'Aprovar com Fulana');
  assert.equal(body.rules[0].sources.length, 1);
  assert.equal(body.rules[0].sources[0].fact_id, f1);
  assert.equal(body.rules[0].sources[0].episode_id, ep);
  assert.equal(body.rules[0].sources[0].turn_start, 41);
  assert.equal(body.rules[0].sources[0].turn_end, 44);
});

test('GET /memoria/condutas: sem ativa → shape nulo', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/memoria/condutas?workspace_id=vazio', headers: agentAuth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'conduta_v1');
  assert.equal(body.workspace_id, 'vazio');
  assert.equal(body.version, null);
  assert.equal(body.content_md, null);
  assert.deepEqual(body.rules, []);
});

test('GET /memoria/condutas sem token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/memoria/condutas?workspace_id=w1' });
  assert.equal(res.statusCode, 401);
});

// ── admin approve/reject (owner-scope) ───────────────────────────────────────

test('POST /admin/condutas/:id/approve (owner) → active', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep });
  const id1 = await proposeConduta('w1', { llm: fakeLlm({ content_md: 'v1', rules: [{ text: 'r1', fact_ids: [f1] }] }).client, createApprovalTask: fakeApprovalTask().fn });

  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/condutas/${id1}/approve`, headers: ownerAuth, payload: { approved_by: 'gustavo' } });
  assert.equal(res.statusCode, 200);
  const c = await condutaRow(id1!);
  assert.equal(c!.status, 'active');
  assert.equal(c!.approved_by, 'gustavo');
});

test('POST /admin/condutas/:id/approve com content_md override', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep });
  const id1 = await proposeConduta('w1', { llm: fakeLlm({ content_md: 'v1 lua', rules: [{ text: 'r1', fact_ids: [f1] }] }).client, createApprovalTask: fakeApprovalTask().fn });

  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/condutas/${id1}/approve`, headers: ownerAuth, payload: { approved_by: 'gustavo', content_md: 'v1 editada' } });
  assert.equal(res.statusCode, 200);
  const c = await condutaRow(id1!);
  assert.equal(c!.content_md, 'v1 editada');
  assert.equal(c!.proposed_by, 'human:gustavo');
});

test('POST /admin/condutas/:id/approve sem approved_by → 400', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/condutas/1/approve`, headers: ownerAuth, payload: {} });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/condutas/:id/approve sem owner token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/condutas/1/approve`, payload: { approved_by: 'x' } });
  assert.equal(res.statusCode, 401);
});

test('POST /admin/condutas/:id/reject (owner) → rejected + nota', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f1 = await seedFact({ workspaceId: 'w1', factType: 'preferencia', statement: 'p1', episodeId: ep });
  const id1 = await proposeConduta('w1', { llm: fakeLlm({ content_md: 'v1', rules: [{ text: 'r1', fact_ids: [f1] }] }).client, createApprovalTask: fakeApprovalTask().fn });

  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/condutas/${id1}/reject`, headers: ownerAuth, payload: { note: 'nao agora' } });
  assert.equal(res.statusCode, 200);
  const c = await condutaRow(id1!);
  assert.equal(c!.status, 'rejected');
  assert.equal(c!.rejection_note, 'nao agora');
});

test('POST /admin/condutas/:id/reject sem note → 400', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/condutas/1/reject`, headers: ownerAuth, payload: {} });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/condutas/:id/approve id inexistente → 404', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/condutas/99999/approve`, headers: ownerAuth, payload: { approved_by: 'x' } });
  assert.equal(res.statusCode, 404);
});
