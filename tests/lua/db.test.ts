import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  enqueueEligibleEpisodes,
  claimProcessing,
  markStaleRevisions,
  insertChunksTx,
  finishProcessingTx,
  failProcessing,
  insertFactTx,
  supersedeFactTx,
  flagFactTx,
  searchNeighbors,
  startRun,
  finishRun,
  type ChunkInput,
  type FactInput,
} from '../../src/lua/db.js';

// ── Helpers de seed ───────────────────────────────────────────────────────

/** Insere um episódio (colunas reais da migration 015 — coluna é `fonte`, NAO `source`). */
async function seedEpisode(args: {
  externalId: string;
  workspaceId: string | null;
  occurredAt?: string;
  revision?: number;
  title?: string;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, $3, $4, $5)
     RETURNING id`,
    [
      args.externalId,
      args.title ?? `ep ${args.externalId}`,
      args.occurredAt ?? '2026-05-01T14:00:00Z',
      args.workspaceId,
      args.revision ?? 1,
    ]
  );
  return Number(rows[0]!.id);
}

/** Vetor 1024-dim determinístico: tudo 0 exceto a dimensão `dim`=1 (vizinhos distintos). */
function vec(dim = 0): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

/** Enfileira diretamente uma linha de processing (bypass da varredura) p/ testes de claim. */
async function seedProcessing(args: {
  episodeId: number;
  episodeRevision: number;
  status?: string;
  nextAttemptAt?: string;
  claimedAt?: string | null;
  claimedBy?: string | null;
  attemptCount?: number;
}): Promise<{ id: number; claimed_at: Date | null }> {
  const { rows } = await pool.query<{ id: number; claimed_at: Date | null }>(
    `INSERT INTO lua_processing
       (episode_id, episode_revision, status, next_attempt_at, claimed_at, claimed_by, attempt_count)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), $5, $6, $7)
     RETURNING id, claimed_at`,
    [
      args.episodeId,
      args.episodeRevision,
      args.status ?? 'pending',
      args.nextAttemptAt ?? null,
      args.claimedAt ?? null,
      args.claimedBy ?? null,
      args.attemptCount ?? 0,
    ]
  );
  return rows[0]!;
}

function makeChunk(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    chunkIndex: 0,
    turnStart: 0,
    turnEnd: 1,
    charStart: null,
    charEnd: null,
    text: 'Ana: oi\nGustavo: ola',
    tokenCount: 5,
    embedding: vec(0),
    embeddingModel: 'fake@1024',
    ...overrides,
  };
}

function makeFact(overrides: Partial<FactInput>): FactInput {
  return {
    workspaceId: 'w1',
    factType: 'decisao',
    statement: 'a verba e 5k',
    attributes: {},
    confidence: 0.9,
    validAt: '2026-05-01T14:00:00Z',
    episodeId: 0,
    episodeRevision: 1,
    turnStart: 0,
    turnEnd: 1,
    embedding: vec(0),
    embeddingModel: 'fake@1024',
    extractedBy: 'test',
    ...overrides,
  };
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE lua_processing, lua_runs, episode_chunks, facts RESTART IDENTITY CASCADE`
  );
  await pool.query(`TRUNCATE episodes, episode_turns RESTART IDENTITY CASCADE`);
});

after(async () => {
  await pool.end();
});

// ── 1. enqueueEligibleEpisodes ────────────────────────────────────────────

test('enqueue ignora episodios orfaos (workspace_id NULL)', async () => {
  await seedEpisode({ externalId: 'com-ws', workspaceId: 'w1' });
  await seedEpisode({ externalId: 'orfao', workspaceId: null });
  const n = await enqueueEligibleEpisodes();
  assert.equal(n, 1);
  const { rows } = await pool.query<{ episode_id: number }>(
    `SELECT episode_id FROM lua_processing`
  );
  assert.equal(rows.length, 1);
});

test('enqueue e idempotente: segunda varredura nao re-enfileira', async () => {
  await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const first = await enqueueEligibleEpisodes();
  assert.equal(first, 1);
  const second = await enqueueEligibleEpisodes();
  assert.equal(second, 0);
});

// ── 2. claimProcessing ─────────────────────────────────────────────────────

test('claim NAO seleciona linha cuja episode.revision avancou', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1', revision: 2 });
  // linha de processing de uma revision antiga (1)
  await seedProcessing({ episodeId: ep, episodeRevision: 1 });
  const claimed = await claimProcessing('w-1', 10);
  assert.equal(claimed.length, 0);
});

test('claim recente nao e re-claimado por segunda chamada imediata (lease)', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1', revision: 1 });
  await seedProcessing({ episodeId: ep, episodeRevision: 1 });
  const first = await claimProcessing('w-1', 10);
  assert.equal(first.length, 1);
  const second = await claimProcessing('w-2', 10);
  assert.equal(second.length, 0);
});

test('claim ordena por occurred_at ASC', async () => {
  const epLate = await seedEpisode({
    externalId: 'late', workspaceId: 'w1', occurredAt: '2026-05-10T10:00:00Z',
  });
  const epEarly = await seedEpisode({
    externalId: 'early', workspaceId: 'w1', occurredAt: '2026-05-01T10:00:00Z',
  });
  await seedProcessing({ episodeId: epLate, episodeRevision: 1 });
  await seedProcessing({ episodeId: epEarly, episodeRevision: 1 });
  const claimed = await claimProcessing('w-1', 10);
  assert.equal(claimed.length, 2);
  assert.equal(Number(claimed[0]!.episode_id), epEarly);
  assert.equal(Number(claimed[1]!.episode_id), epLate);
});

// ── 3. markStaleRevisions ──────────────────────────────────────────────────

test('markStaleRevisions vira skipped a linha de revision antiga', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1', revision: 2 });
  const p = await seedProcessing({ episodeId: ep, episodeRevision: 1, status: 'pending' });
  const n = await markStaleRevisions();
  assert.equal(n, 1);
  const { rows } = await pool.query<{ status: string; last_error: string }>(
    `SELECT status, last_error FROM lua_processing WHERE id = $1`, [p.id]
  );
  assert.equal(rows[0]!.status, 'skipped');
  assert.equal(rows[0]!.last_error, 'stale_revision');
});

// ── 4. insertChunksTx ──────────────────────────────────────────────────────

test('insertChunksTx e idempotente (delete-insert, sem duplicatas)', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const chunks: ChunkInput[] = [
    makeChunk({ chunkIndex: 0, embedding: vec(0) }),
    makeChunk({ chunkIndex: 1, turnStart: 2, turnEnd: 3, embedding: vec(1) }),
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertChunksTx(client, { episodeId: ep, episodeRevision: 1, workspaceId: 'w1', chunks });
    await client.query('COMMIT');
    await client.query('BEGIN');
    await insertChunksTx(client, { episodeId: ep, episodeRevision: 1, workspaceId: 'w1', chunks });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_chunks WHERE episode_id = $1`, [ep]
  );
  assert.equal(rows[0]!.n, 2);
});

// ── 5. finishProcessingTx (fencing de lease) ───────────────────────────────

test('finishProcessingTx falha (false) com claimedAt obsoleto e nao muda a linha', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  await seedProcessing({ episodeId: ep, episodeRevision: 1 });
  const [claimed] = await claimProcessing('w-1', 10);
  assert.ok(claimed);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ok = await finishProcessingTx(client, {
      id: claimed!.id,
      claimedBy: 'w-1',
      claimedAt: new Date('2000-01-01T00:00:00Z'), // lease obsoleto
      status: 'done',
      stats: { facts_new: 3 },
    });
    await client.query('COMMIT');
    assert.equal(ok, false);
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM lua_processing WHERE id = $1`, [claimed!.id]
  );
  assert.notEqual(rows[0]!.status, 'done');
});

test('finishProcessingTx sucede (true) com lease vigente', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  await seedProcessing({ episodeId: ep, episodeRevision: 1 });
  const [claimed] = await claimProcessing('w-1', 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ok = await finishProcessingTx(client, {
      id: claimed!.id,
      claimedBy: 'w-1',
      claimedAt: claimed!.claimed_at!,
      status: 'done',
      stats: { facts_new: 1 },
    });
    await client.query('COMMIT');
    assert.equal(ok, true);
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM lua_processing WHERE id = $1`, [claimed!.id]
  );
  assert.equal(rows[0]!.status, 'done');
});

// ── 6. failProcessing (backoff / dead) ─────────────────────────────────────

test('failProcessing abaixo do max => failed com next_attempt futuro', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const p = await seedProcessing({ episodeId: ep, episodeRevision: 1, attemptCount: 0 });
  const r = await failProcessing(p.id, 'erro x');
  assert.equal(r.dead, false);
  const { rows } = await pool.query<{ status: string; future: boolean }>(
    `SELECT status, (next_attempt_at > NOW()) AS future FROM lua_processing WHERE id = $1`, [p.id]
  );
  assert.equal(rows[0]!.status, 'failed');
  assert.equal(rows[0]!.future, true);
});

test('failProcessing no max => dead', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  // attempt_count=3; failProcessing incrementa pra 4 = LUA_MAX_ATTEMPTS
  const p = await seedProcessing({ episodeId: ep, episodeRevision: 1, attemptCount: 3 });
  const r = await failProcessing(p.id, 'erro fatal');
  assert.equal(r.dead, true);
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM lua_processing WHERE id = $1`, [p.id]
  );
  assert.equal(rows[0]!.status, 'dead');
});

// ── 7. insertFactTx ────────────────────────────────────────────────────────

test('insertFactTx faz round-trip de um fato', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const client = await pool.connect();
  let id: number;
  try {
    await client.query('BEGIN');
    id = await insertFactTx(client, makeFact({ episodeId: ep }));
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ statement: string; fact_type: string; invalid_at: Date | null }>(
    `SELECT statement, fact_type, invalid_at FROM facts WHERE id = $1`, [id!]
  );
  assert.equal(rows[0]!.statement, 'a verba e 5k');
  assert.equal(rows[0]!.fact_type, 'decisao');
  assert.equal(rows[0]!.invalid_at, null);
});

test('insertFactTx respeita o CHECK bi-temporal: invalid_at sem reason rejeita', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      () => insertFactTx(client, makeFact({
        episodeId: ep,
        invalidAt: '2026-05-02T00:00:00Z',
        invalidationReason: null, // viola facts_invalidation_chk
      })),
      /facts_invalidation_chk/
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

// ── 8. supersedeFactTx ─────────────────────────────────────────────────────

test('supersedeFactTx invalida o existente apontando o sucessor', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const client = await pool.connect();
  let existingId: number;
  let newId: number;
  try {
    await client.query('BEGIN');
    existingId = await insertFactTx(client, makeFact({ episodeId: ep, statement: 'verba 5k', embedding: vec(0) }));
    newId = await insertFactTx(client, makeFact({ episodeId: ep, statement: 'verba 8k', embedding: vec(1), validAt: '2026-06-01T00:00:00Z' }));
    await supersedeFactTx(client, {
      existingId, newId, invalidAt: '2026-06-01T00:00:00Z', reason: 'superseded',
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ invalid_at: Date | null; superseded_by_fact_id: number; invalidation_reason: string }>(
    `SELECT invalid_at, superseded_by_fact_id, invalidation_reason FROM facts WHERE id = $1`, [existingId!]
  );
  assert.notEqual(rows[0]!.invalid_at, null);
  assert.equal(Number(rows[0]!.superseded_by_fact_id), newId!);
  assert.equal(rows[0]!.invalidation_reason, 'superseded');
});

// ── 9. flagFactTx ──────────────────────────────────────────────────────────

test('flagFactTx seta needs_review e anexa nota', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const client = await pool.connect();
  let id: number;
  try {
    await client.query('BEGIN');
    id = await insertFactTx(client, makeFact({ episodeId: ep }));
    await flagFactTx(client, id, 'conflito com fato 99');
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ needs_review: boolean; review_note: string }>(
    `SELECT needs_review, review_note FROM facts WHERE id = $1`, [id!]
  );
  assert.equal(rows[0]!.needs_review, true);
  assert.match(rows[0]!.review_note, /conflito com fato 99/);
});

// ── 10. searchNeighbors ────────────────────────────────────────────────────

test('searchNeighbors retorna vizinho do mesmo workspace+tipo e ignora outro workspace', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  const ep2 = await seedEpisode({ externalId: 'b', workspaceId: 'w2' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertFactTx(client, makeFact({ workspaceId: 'w1', episodeId: ep, statement: 'w1 vizinho', embedding: vec(0) }));
    await insertFactTx(client, makeFact({ workspaceId: 'w2', episodeId: ep2, statement: 'w2 outro', embedding: vec(0) }));
    await client.query('COMMIT');
    await client.query('BEGIN');
    const neighbors = await searchNeighbors(client, {
      workspaceId: 'w1', factType: 'decisao', embedding: vec(0), limit: 8, minSim: 0.55,
    });
    await client.query('COMMIT');
    assert.equal(neighbors.length, 1);
    assert.equal(neighbors[0]!.statement, 'w1 vizinho');
    assert.ok(neighbors[0]!.similarity >= 0.99);
  } finally {
    client.release();
  }
});

// ── 11. startRun / finishRun ───────────────────────────────────────────────

test('startRun nightly e unico por data (ON CONFLICT)', async () => {
  const first = await startRun('nightly', '2026-06-12');
  assert.ok(typeof first === 'number');
  const second = await startRun('nightly', '2026-06-12');
  assert.equal(second, null);
  // bootstrap/manual nao disputam a chave
  const boot = await startRun('bootstrap', '2026-06-12');
  assert.ok(typeof boot === 'number');
});

test('finishRun fecha o run com status e stats', async () => {
  const id = await startRun('manual', '2026-06-12');
  await finishRun(id!, 'done', { facts_new: 5 });
  const { rows } = await pool.query<{ status: string; stats: { facts_new: number }; finished_at: Date }>(
    `SELECT status, stats, finished_at FROM lua_runs WHERE id = $1`, [id!]
  );
  assert.equal(rows[0]!.status, 'done');
  assert.equal(rows[0]!.stats.facts_new, 5);
  assert.notEqual(rows[0]!.finished_at, null);
});
