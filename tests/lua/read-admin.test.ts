// Task 14 — camada de leitura (get_fatos / get_status) + admin de triagem/DLQ.
// DB vivo + Fastify inject, SEM LLM. Token de owner vem do env-file
// c:/tmp/lua-test.env (OWNER_ADMIN_TOKEN) e o de agente (`testworkertoken`).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool } from '../../src/db.js';
import { registerMemoriaRoutes } from '../../src/lua/routes.js';
import {
  getFatos,
  getStatusVigente,
  listRuns,
  listProcessing,
  replayDead,
  forceReprocess,
  listReviewFacts,
  resolveFact,
  deleteRecap,
} from '../../src/lua/db.js';

const AGENT_TOKEN = 'testworkertoken';
const agentAuth = { 'x-agent-token': AGENT_TOKEN };
const OWNER_TOKEN = process.env.OWNER_ADMIN_TOKEN!;
const ownerAuth = { 'x-owner-token': OWNER_TOKEN };

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerMemoriaRoutes);
  return app;
}

// ── Seed helpers ────────────────────────────────────────────────────────────

function toVec(dim = 0): string {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return `[${v.join(',')}]`;
}

async function seedEpisode(externalId: string, workspaceId: string | null, revision = 1): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, '2026-05-01T14:00:00Z', $3, $4)
     RETURNING id`,
    [externalId, `ep ${externalId}`, workspaceId, revision]
  );
  return Number(rows[0]!.id);
}

async function seedFact(args: {
  workspaceId: string;
  factType?: string;
  statement: string;
  episodeId: number;
  validAt: string;
  invalidAt?: string | null;
  invalidationReason?: string | null;
  needsReview?: boolean;
  reviewNote?: string | null;
  supersededBy?: number | null;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO facts
       (workspace_id, fact_type, statement, confidence, valid_at, invalid_at,
        superseded_by_fact_id, invalidation_reason,
        episode_id, episode_revision, turn_start, turn_end,
        needs_review, review_note, embedding, embedding_model, extracted_by)
     VALUES ($1,$2,$3,0.9,$4,$5,$6,$7,$8,1,0,1,$9,$10,$11::vector,'fake@1024','test')
     RETURNING id`,
    [
      args.workspaceId,
      args.factType ?? 'decisao',
      args.statement,
      args.validAt,
      args.invalidAt ?? null,
      args.supersededBy ?? null,
      args.invalidationReason ?? null,
      args.episodeId,
      args.needsReview ?? false,
      args.reviewNote ?? null,
      toVec(0),
    ]
  );
  return Number(rows[0]!.id);
}

async function seedRun(kind = 'manual'): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO lua_runs (kind, run_date, status, stats)
     VALUES ($1, CURRENT_DATE, 'done', '{"facts_new": 3}') RETURNING id`,
    [kind]
  );
  return Number(rows[0]!.id);
}

async function seedProcessing(args: {
  episodeId: number;
  revision?: number;
  status?: string;
  lastError?: string | null;
  attemptCount?: number;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO lua_processing (episode_id, episode_revision, status, last_error, attempt_count)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [args.episodeId, args.revision ?? 1, args.status ?? 'pending', args.lastError ?? null, args.attemptCount ?? 0]
  );
  return Number(rows[0]!.id);
}

async function seedStatus(workspaceId: string, contentMd: string, factId: number): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO project_status (workspace_id, content_md, model) VALUES ($1, $2, 'sonnet') RETURNING id`,
    [workspaceId, contentMd]
  );
  const id = Number(rows[0]!.id);
  await pool.query(`INSERT INTO project_status_sources (status_id, fact_id) VALUES ($1, $2)`, [id, factId]);
  return id;
}

async function seedRecap(workspaceId: string, episodeId: number): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO recaps (workspace_id, period_start, period_end, content_md, model)
     VALUES ($1, '2026-04-27', '2026-05-03', 'recap da semana', 'sonnet') RETURNING id`,
    [workspaceId]
  );
  const id = Number(rows[0]!.id);
  await pool.query(`INSERT INTO recap_sources (recap_id, episode_id) VALUES ($1, $2)`, [id, episodeId]);
  return id;
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE lua_processing, lua_runs, episode_chunks, facts,
              recaps, recap_sources, project_status, project_status_sources,
              episodes, episode_turns RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

// ── getFatos (db) ─────────────────────────────────────────────────────────

test('getFatos: as-of default retorna so vigentes', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedFact({ workspaceId: 'w1', statement: 'verba e 8k', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  await seedFact({
    workspaceId: 'w1', statement: 'verba era 5k', episodeId: ep,
    validAt: '2026-04-01T00:00:00Z', invalidAt: '2026-05-01T00:00:00Z', invalidationReason: 'superseded',
  });
  const { fatos } = await getFatos('w1', {});
  assert.equal(fatos.length, 1);
  assert.equal(fatos[0]!.statement, 'verba e 8k');
});

test('getFatos: includeInvalid retorna todos e preenche needs_review/superseded_by sempre', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const newer = await seedFact({ workspaceId: 'w1', statement: 'verba e 8k', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  await seedFact({
    workspaceId: 'w1', statement: 'verba era 5k', episodeId: ep,
    validAt: '2026-04-01T00:00:00Z', invalidAt: '2026-05-01T00:00:00Z', invalidationReason: 'superseded',
    supersededBy: newer, needsReview: true,
  });
  const { fatos } = await getFatos('w1', { includeInvalid: true });
  assert.equal(fatos.length, 2);
  const invalidada = fatos.find((f) => f.statement === 'verba era 5k')!;
  assert.equal(invalidada.superseded_by_fact_id, newer);
  assert.equal(invalidada.needs_review, true);
  // needs_review presente mesmo no fato vigente
  const vigente = fatos.find((f) => f.statement === 'verba e 8k')!;
  assert.equal(vigente.needs_review, false);
  assert.equal(vigente.superseded_by_fact_id, null);
});

test('getFatos: filtro por types', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedFact({ workspaceId: 'w1', factType: 'decisao', statement: 'd', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  await seedFact({ workspaceId: 'w1', factType: 'compromisso', statement: 'c', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  const { fatos } = await getFatos('w1', { types: ['compromisso'] });
  assert.equal(fatos.length, 1);
  assert.equal(fatos[0]!.fact_type, 'compromisso');
});

test('getFatos: isolado por workspace', async () => {
  const e1 = await seedEpisode('e1', 'w1');
  const e2 = await seedEpisode('e2', 'w2');
  await seedFact({ workspaceId: 'w1', statement: 'do w1', episodeId: e1, validAt: '2026-05-01T00:00:00Z' });
  await seedFact({ workspaceId: 'w2', statement: 'do w2', episodeId: e2, validAt: '2026-05-01T00:00:00Z' });
  const { fatos } = await getFatos('w1', {});
  assert.equal(fatos.length, 1);
  assert.equal(fatos[0]!.workspace_id, 'w1');
});

test('getFatos: keyset cursor pagina', async () => {
  const ep = await seedEpisode('e1', 'w1');
  for (let i = 0; i < 5; i++) {
    await seedFact({
      workspaceId: 'w1', statement: `fato ${i}`, episodeId: ep,
      validAt: `2026-05-0${i + 1}T00:00:00Z`,
    });
  }
  const page1 = await getFatos('w1', { limit: 3 });
  assert.equal(page1.fatos.length, 3);
  assert.ok(page1.next_cursor, 'esperava next_cursor na 1a pagina');
  const page2 = await getFatos('w1', { limit: 3, cursor: page1.next_cursor! });
  assert.equal(page2.fatos.length, 2);
  assert.equal(page2.next_cursor, null);
  // sem sobreposicao entre paginas
  const ids1 = page1.fatos.map((f) => f.id);
  const ids2 = page2.fatos.map((f) => f.id);
  assert.equal(ids1.filter((id) => ids2.includes(id)).length, 0);
});

test('getFatos: filtro lexical q', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedFact({ workspaceId: 'w1', statement: 'a verba mensal e 8000', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  await seedFact({ workspaceId: 'w1', statement: 'reuniao foi adiada', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  const { fatos } = await getFatos('w1', { q: 'verba' });
  assert.equal(fatos.length, 1);
  assert.match(fatos[0]!.statement, /verba/);
});

// ── getStatusVigente (db) ───────────────────────────────────────────────────

test('getStatusVigente: retorna a linha mais recente com sources', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f = await seedFact({ workspaceId: 'w1', statement: 'verba e 8k', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  await seedStatus('w1', 'status antigo', f);
  await new Promise((r) => setTimeout(r, 5));
  await seedStatus('w1', 'status novo', f);
  const status = await getStatusVigente('w1');
  assert.ok(status);
  assert.equal(status!.content_md, 'status novo');
  assert.equal(status!.sources.length, 1);
  assert.equal(status!.sources[0]!.fact_id, f);
});

test('getStatusVigente: null quando nao ha status', async () => {
  const status = await getStatusVigente('w-vazio');
  assert.equal(status, null);
});

// ── Admin db fns diretas ────────────────────────────────────────────────────

test('replayDead: dead -> pending, zera tentativas, preserva last_error', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const id = await seedProcessing({ episodeId: ep, status: 'dead', lastError: 'boom', attemptCount: 4 });
  const ok = await replayDead(id);
  assert.equal(ok, true);
  const { rows } = await pool.query(`SELECT status, attempt_count, last_error FROM lua_processing WHERE id=$1`, [id]);
  assert.equal(rows[0]!.status, 'pending');
  assert.equal(rows[0]!.attempt_count, 0);
  assert.equal(rows[0]!.last_error, 'boom');
});

test('replayDead: linha nao-dead retorna false', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const id = await seedProcessing({ episodeId: ep, status: 'done' });
  assert.equal(await replayDead(id), false);
});

test('forceReprocess: reseta linha existente para pending', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedProcessing({ episodeId: ep, status: 'done' });
  const ok = await forceReprocess(ep);
  assert.equal(ok, true);
  const { rows } = await pool.query(`SELECT status, attempt_count FROM lua_processing WHERE episode_id=$1`, [ep]);
  assert.equal(rows[0]!.status, 'pending');
  assert.equal(rows[0]!.attempt_count, 0);
});

test('forceReprocess: enfileira quando nao ha linha', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const ok = await forceReprocess(ep);
  assert.equal(ok, true);
  const { rows } = await pool.query(`SELECT status FROM lua_processing WHERE episode_id=$1`, [ep]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'pending');
});

test('resolveFact: confirm limpa needs_review', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f = await seedFact({ workspaceId: 'w1', statement: 'x', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  await resolveFact(f, { action: 'confirm' });
  const { rows } = await pool.query(`SELECT needs_review FROM facts WHERE id=$1`, [f]);
  assert.equal(rows[0]!.needs_review, false);
});

test('resolveFact: invalidate seta invalid_at + reason=manual', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f = await seedFact({ workspaceId: 'w1', statement: 'x', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  await resolveFact(f, { action: 'invalidate' });
  const { rows } = await pool.query(`SELECT invalid_at, invalidation_reason, needs_review FROM facts WHERE id=$1`, [f]);
  assert.ok(rows[0]!.invalid_at);
  assert.equal(rows[0]!.invalidation_reason, 'manual');
  assert.equal(rows[0]!.needs_review, false);
});

test('resolveFact: supersede_by aponta target e invalida', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const target = await seedFact({ workspaceId: 'w1', statement: 'novo', episodeId: ep, validAt: '2026-05-02T00:00:00Z' });
  const old = await seedFact({ workspaceId: 'w1', statement: 'velho', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  await resolveFact(old, { action: 'supersede_by', targetId: target });
  const { rows } = await pool.query(`SELECT invalid_at, invalidation_reason, superseded_by_fact_id FROM facts WHERE id=$1`, [old]);
  assert.ok(rows[0]!.invalid_at);
  assert.equal(rows[0]!.invalidation_reason, 'manual');
  assert.equal(Number(rows[0]!.superseded_by_fact_id), target);
});

test('listReviewFacts / listRuns / listProcessing', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedFact({ workspaceId: 'w1', statement: 'flagado', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  await seedFact({ workspaceId: 'w1', statement: 'ok', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  await seedRun('nightly');
  await seedProcessing({ episodeId: ep, status: 'dead' });

  const review = await listReviewFacts('w1');
  assert.equal(review.length, 1);
  assert.equal(review[0]!.statement, 'flagado');

  const runs = await listRuns(10);
  assert.equal(runs.length, 1);

  const dead = await listProcessing({ status: 'dead' });
  assert.equal(dead.length, 1);
  const all = await listProcessing({});
  assert.equal(all.length, 1);
});

test('deleteRecap remove a linha', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const r = await seedRecap('w1', ep);
  assert.equal(await deleteRecap(r), true);
  const { rows } = await pool.query(`SELECT id FROM recaps WHERE id=$1`, [r]);
  assert.equal(rows.length, 0);
  assert.equal(await deleteRecap(r), false);
});

// ── REST agent-scope ────────────────────────────────────────────────────────

test('GET /memoria/fatos → 200 vigentes, schema, isolado por workspace', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedFact({ workspaceId: 'w1', statement: 'verba e 8k', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  const ep2 = await seedEpisode('e2', 'w2');
  await seedFact({ workspaceId: 'w2', statement: 'do w2', episodeId: ep2, validAt: '2026-05-01T00:00:00Z' });

  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/memoria/fatos?workspace_id=w1', headers: agentAuth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'memoria_fatos_v1');
  assert.equal(body.fatos.length, 1);
  assert.equal(body.fatos[0].statement, 'verba e 8k');
  assert.equal(body.fatos[0].needs_review, false);
});

test('GET /memoria/fatos sem workspace_id → 400', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/memoria/fatos', headers: agentAuth });
  assert.equal(res.statusCode, 400);
});

test('GET /memoria/fatos sem token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/memoria/fatos?workspace_id=w1' });
  assert.equal(res.statusCode, 401);
});

test('GET /memoria/status → 200 com content_md / null shape', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f = await seedFact({ workspaceId: 'w1', statement: 'verba e 8k', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  await seedStatus('w1', 'rodando com 8k', f);

  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/memoria/status?workspace_id=w1', headers: agentAuth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'status_v1');
  assert.equal(body.content_md, 'rodando com 8k');
  assert.equal(body.sources.length, 1);

  const res2 = await app.inject({ method: 'GET', url: '/memoria/status?workspace_id=vazio', headers: agentAuth });
  assert.equal(res2.statusCode, 200);
  assert.equal(JSON.parse(res2.body).content_md, null);
});

// ── REST owner-scope ────────────────────────────────────────────────────────

test('GET /admin/lua/runs sem owner token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/lua/runs' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/lua/runs com owner token → 200', async () => {
  await seedRun('nightly');
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/lua/runs', headers: ownerAuth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.runs.length, 1);
});

test('GET /admin/lua/processing?status=dead filtra', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedProcessing({ episodeId: ep, status: 'dead' });
  const ep2 = await seedEpisode('e2', 'w1');
  await seedProcessing({ episodeId: ep2, status: 'done' });

  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/lua/processing?status=dead', headers: ownerAuth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.processing.length, 1);
  assert.equal(body.processing[0].status, 'dead');
});

test('POST /admin/lua/processing/:id/replay vira dead->pending', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const id = await seedProcessing({ episodeId: ep, status: 'dead', lastError: 'boom', attemptCount: 4 });
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/lua/processing/${id}/replay`, headers: ownerAuth });
  assert.equal(res.statusCode, 200);
  const { rows } = await pool.query(`SELECT status FROM lua_processing WHERE id=$1`, [id]);
  assert.equal(rows[0]!.status, 'pending');
});

test('POST /admin/lua/episodes/:id/reprocess enfileira', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: `/admin/lua/episodes/${ep}/reprocess`, headers: ownerAuth });
  assert.equal(res.statusCode, 200);
  const { rows } = await pool.query(`SELECT status FROM lua_processing WHERE episode_id=$1`, [ep]);
  assert.equal(rows[0]!.status, 'pending');
});

test('GET /admin/lua/facts?needs_review=true lista flagados', async () => {
  const ep = await seedEpisode('e1', 'w1');
  await seedFact({ workspaceId: 'w1', statement: 'flagado', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  await seedFact({ workspaceId: 'w1', statement: 'ok', episodeId: ep, validAt: '2026-05-01T00:00:00Z' });
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/lua/facts?workspace_id=w1&needs_review=true', headers: ownerAuth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.facts.length, 1);
  assert.equal(body.facts[0].statement, 'flagado');
});

test('PATCH /admin/lua/facts/:id confirm limpa needs_review', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f = await seedFact({ workspaceId: 'w1', statement: 'x', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH', url: `/admin/lua/facts/${f}`, headers: ownerAuth, payload: { action: 'confirm' },
  });
  assert.equal(res.statusCode, 200);
  const { rows } = await pool.query(`SELECT needs_review FROM facts WHERE id=$1`, [f]);
  assert.equal(rows[0]!.needs_review, false);
});

test('PATCH /admin/lua/facts/:id invalidate seta invalid_at + reason', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f = await seedFact({ workspaceId: 'w1', statement: 'x', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH', url: `/admin/lua/facts/${f}`, headers: ownerAuth, payload: { action: 'invalidate' },
  });
  assert.equal(res.statusCode, 200);
  const { rows } = await pool.query(`SELECT invalid_at, invalidation_reason FROM facts WHERE id=$1`, [f]);
  assert.ok(rows[0]!.invalid_at);
  assert.equal(rows[0]!.invalidation_reason, 'manual');
});

test('PATCH /admin/lua/facts/:id supersede_by sem targetId → 400', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const f = await seedFact({ workspaceId: 'w1', statement: 'x', episodeId: ep, validAt: '2026-05-01T00:00:00Z', needsReview: true });
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH', url: `/admin/lua/facts/${f}`, headers: ownerAuth, payload: { action: 'supersede_by' },
  });
  assert.equal(res.statusCode, 400);
});

test('DELETE /admin/lua/recaps/:id remove', async () => {
  const ep = await seedEpisode('e1', 'w1');
  const r = await seedRecap('w1', ep);
  const app = buildApp();
  const res = await app.inject({ method: 'DELETE', url: `/admin/lua/recaps/${r}`, headers: ownerAuth });
  assert.equal(res.statusCode, 200);
  const { rows } = await pool.query(`SELECT id FROM recaps WHERE id=$1`, [r]);
  assert.equal(rows.length, 0);
});

test('DELETE /admin/lua/recaps/:id inexistente → 404', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'DELETE', url: '/admin/lua/recaps/99999', headers: ownerAuth });
  assert.equal(res.statusCode, 404);
});

test('admin sem owner token → 401 (cobertura geral)', async () => {
  const app = buildApp();
  for (const url of ['/admin/lua/processing', '/admin/lua/facts?workspace_id=w1']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, url);
  }
});
