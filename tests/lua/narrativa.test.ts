import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool } from '../../src/db.js';
import { registerMemoriaRoutes } from '../../src/lua/routes.js';
import { generateStatus, generateRecap } from '../../src/lua/narrativa.js';
import type { LlmClient, LlmCompletionArgs } from '../../src/lua/llm.js';

// ── Fake LLM ────────────────────────────────────────────────────────────────
//
// Roteiriza `complete` com um content_md fixo e registra os prompts vistos
// (system + user) para assercoes de substring. `calls` conta as invocacoes
// (prova de idempotencia: recap nao chama LLM 2x na mesma semana).

type Captured = { system: string; user: string };

function fakeLlm(contentMd: string): LlmClient & { calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    model: 'fake-sonnet@1',
    calls,
    async complete<T = unknown>(args: LlmCompletionArgs): Promise<T> {
      calls.push({ system: args.system, user: args.user });
      return { content_md: contentMd } as T;
    },
  };
}

// ── Seed helpers (colunas reais das migrations 015/021/022) ─────────────────

function toVec(v: number[]): string {
  return `[${v.join(',')}]`;
}
function zeroVec(): number[] {
  return new Array(1024).fill(0);
}

async function seedEpisode(args: {
  externalId: string;
  workspaceId: string | null;
  occurredAt?: string;
  title?: string;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, $3, $4, 1)
     RETURNING id`,
    [
      args.externalId,
      args.title ?? `ep ${args.externalId}`,
      args.occurredAt ?? '2026-05-04T14:00:00Z',
      args.workspaceId,
    ]
  );
  return Number(rows[0]!.id);
}

async function seedFact(args: {
  workspaceId: string;
  factType: string;
  statement: string;
  episodeId: number;
  validAt?: string;
  invalidAt?: string | null;
  invalidationReason?: string | null;
  needsReview?: boolean;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO facts
       (workspace_id, fact_type, statement, confidence, valid_at,
        invalid_at, invalidation_reason,
        episode_id, episode_revision, turn_start, turn_end,
        needs_review, embedding, embedding_model, extracted_by)
     VALUES ($1, $2, $3, 0.9, $4, $5, $6, $7, 1, 0, 2, $8, $9::vector, 'm', 'fake')
     RETURNING id`,
    [
      args.workspaceId,
      args.factType,
      args.statement,
      args.validAt ?? '2026-05-04T14:00:00Z',
      args.invalidAt ?? null,
      args.invalidationReason ?? null,
      args.episodeId,
      args.needsReview ?? false,
      toVec(zeroVec()),
    ]
  );
  return Number(rows[0]!.id);
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE project_status, project_status_sources, recaps, recap_sources,
              facts, episode_chunks, episodes RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

// ── generateStatus ──────────────────────────────────────────────────────────

test('generateStatus: persiste status com fontes apenas dos fatos vigentes nao-flagados', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1' });
  const objetivo = await seedFact({ workspaceId: 'w1', factType: 'objetivo', statement: 'meta X', episodeId: ep });
  const compromisso = await seedFact({ workspaceId: 'w1', factType: 'compromisso', statement: 'entregar Y', episodeId: ep });
  // fato flagado: precisa ser EXCLUIDO (status nao publica suspeita)
  const flagged = await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'suspeito', episodeId: ep, needsReview: true });
  // fato invalido: nao vigente, deve ser ignorado
  await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'antigo', episodeId: ep, invalidAt: '2026-05-05T00:00:00Z', invalidationReason: 'superseded' });

  const llm = fakeLlm('Projeto rodando com meta X. Compromisso aberto: entregar Y.');
  const statusId = await generateStatus('w1', { llm });
  assert.ok(statusId !== null, 'esperava um id de status');

  // prompt instrui status DESCRITIVO, sem voz narrativa
  const sys = llm.calls[0]!.system.toLowerCase();
  assert.ok(sys.includes('sem voz narrativa') || sys.includes('descritivo'), 'prompt deve pedir descritivo/sem voz narrativa');

  // persistido com content_md
  const { rows } = await pool.query(`SELECT content_md, model FROM project_status WHERE id = $1`, [statusId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.model, 'fake-sonnet@1');

  // fontes = apenas os 2 fatos vigentes nao-flagados (exclui o flagged e o invalido)
  const { rows: src } = await pool.query<{ fact_id: string }>(
    `SELECT fact_id FROM project_status_sources WHERE status_id = $1 ORDER BY fact_id`, [statusId]
  );
  const ids = src.map((s) => Number(s.fact_id)).sort((a, b) => a - b);
  assert.deepEqual(ids, [objetivo, compromisso].sort((a, b) => a - b));
  assert.ok(!ids.includes(flagged), 'fato flagado nao pode ser fonte');
});

test('generateStatus: zero fatos vigentes => retorna null, nao chama LLM, nada persiste', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1' });
  // apenas um fato flagado (excluido) e um invalido => nenhum vigente publicavel
  await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'flag', episodeId: ep, needsReview: true });

  const llm = fakeLlm('nao deveria ser chamado');
  const statusId = await generateStatus('w1', { llm });
  assert.equal(statusId, null);
  assert.equal(llm.calls.length, 0, 'sem fato vigente publicavel => sem chamada LLM');
  const { rows } = await pool.query(`SELECT 1 FROM project_status WHERE workspace_id = 'w1'`);
  assert.equal(rows.length, 0);
});

// ── generateRecap ───────────────────────────────────────────────────────────

const WEEK = { start: '2026-05-04', end: '2026-05-10' }; // segunda a domingo (ISO)

test('generateRecap: persiste recap com fontes = episodios da semana', async () => {
  const ep1 = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', occurredAt: '2026-05-05T14:00:00Z', title: 'Alinhamento' });
  const ep2 = await seedEpisode({ externalId: 'e2', workspaceId: 'w1', occurredAt: '2026-05-07T14:00:00Z', title: 'Revisao' });
  await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'verba dobrou', episodeId: ep1, validAt: '2026-05-05T14:00:00Z' });

  const llm = fakeLlm('A verba dobrou; a aposta agora e Reels.');
  const recapId = await generateRecap('w1', WEEK, { llm });
  assert.ok(recapId !== null);

  // prompt carrega marcadores do style guide do Norte
  const sys = llm.calls[0]!.system.toLowerCase();
  assert.ok(sys.includes('nunca epico') || sys.includes('nunca épico'), 'prompt deve vetar epico corporativo');
  assert.ok(sys.includes('gentil'), 'prompt deve pedir tom gentil');
  assert.ok(sys.includes('pendencias') || sys.includes('pendências'), 'prompt deve fechar com pendencias');

  const { rows } = await pool.query(`SELECT period_start, period_end, content_md, model FROM recaps WHERE id = $1`, [recapId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.model, 'fake-sonnet@1');

  const { rows: src } = await pool.query<{ episode_id: string }>(
    `SELECT episode_id FROM recap_sources WHERE recap_id = $1 ORDER BY episode_id`, [recapId]
  );
  const ids = src.map((s) => Number(s.episode_id)).sort((a, b) => a - b);
  assert.deepEqual(ids, [ep1, ep2].sort((a, b) => a - b));
});

test('generateRecap: idempotente por semana — re-run nao chama LLM 2x, devolve mesmo id', async () => {
  const ep1 = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', occurredAt: '2026-05-05T14:00:00Z' });
  await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'x', episodeId: ep1, validAt: '2026-05-05T14:00:00Z' });

  const llm = fakeLlm('recap original');
  const first = await generateRecap('w1', WEEK, { llm });
  assert.ok(first !== null);
  assert.equal(llm.calls.length, 1);

  const second = await generateRecap('w1', WEEK, { llm });
  assert.equal(second, first, 'mesmo id no re-run');
  assert.equal(llm.calls.length, 1, 'recap ja existe => nenhuma 2a chamada LLM');

  // content_md nao foi reescrito
  const { rows } = await pool.query<{ content_md: string }>(`SELECT content_md FROM recaps WHERE id = $1`, [first!]);
  assert.equal(rows[0]!.content_md, 'recap original');
});

test('generateRecap: sem atividade na semana => null, sem chamada LLM, nada persiste', async () => {
  // episodio FORA da janela => nao conta como atividade
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', occurredAt: '2026-04-01T14:00:00Z' });
  await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'velho', episodeId: ep, validAt: '2026-04-01T14:00:00Z' });

  const llm = fakeLlm('nao deveria');
  const recapId = await generateRecap('w1', WEEK, { llm });
  assert.equal(recapId, null);
  assert.equal(llm.calls.length, 0);
  const { rows } = await pool.query(`SELECT 1 FROM recaps WHERE workspace_id = 'w1'`);
  assert.equal(rows.length, 0);
});

// ── get_recap via REST (Fastify inject) ──────────────────────────────────────

const AGENT_TOKEN = 'testworkertoken';
const agentAuth = { 'x-agent-token': AGENT_TOKEN };

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerMemoriaRoutes);
  return app;
}

test('GET /memoria/recap retorna recap_v1 com sources', async () => {
  const ep1 = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', occurredAt: '2026-05-05T14:00:00Z' });
  await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'x', episodeId: ep1, validAt: '2026-05-05T14:00:00Z' });
  const llm = fakeLlm('recap da semana');
  await generateRecap('w1', WEEK, { llm });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/memoria/recap?workspace_id=w1&week=2026-W19',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'recap_v1');
  assert.equal(body.workspace_id, 'w1');
  assert.equal(body.period_start, '2026-05-04');
  assert.equal(body.content_md, 'recap da semana');
  assert.deepEqual(body.sources, [ep1]);
});

test('GET /memoria/recap sem recap gerado => content_md null', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/memoria/recap?workspace_id=w-vazio&week=2026-W19',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'recap_v1');
  assert.equal(body.content_md, null);
});
