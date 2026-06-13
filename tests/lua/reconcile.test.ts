import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db.js';
import { reconcileEpisode } from '../../src/lua/reconcile.js';
import { insertFactTx, type FactInput } from '../../src/lua/db.js';
import type { FactCandidate, FactType } from '../../src/lua/extract.js';
import type { EmbeddingClient } from '../../src/lua/embeddings.js';
import type { LlmClient, LlmCompletionArgs } from '../../src/lua/llm.js';
import type { Verdict } from '../../src/lua/reconcile.js';

// ─────────────────────────────────────────────────────────────────────────
// Fakes (sem rede): embedding determinístico + judge roteirizado.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Embedding determinístico: statement -> one-hot vetor 1024-dim. O dim é
 * mapeado por `dimMap` (statements que devem COLIDIR como vizinhos recebem o
 * mesmo dim) com fallback por hash estável. Cosseno de dois one-hot iguais = 1
 * (>= 0.55 => vizinho); de dois one-hot distintos = 0 (< 0.55 => não-vizinho).
 */
function makeFakeEmbedding(dimMap: Record<string, number> = {}): EmbeddingClient {
  const hash = (s: string): number => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    // 1..1023 (reservamos faixas distintas; evita colisão acidental com dimMap baixos)
    return (h % 1000) + 20;
  };
  return {
    model: 'fake@1024',
    async embed(inputs: string[]): Promise<number[][]> {
      return inputs.map((s) => {
        const v = new Array(1024).fill(0);
        const dim = dimMap[s] ?? hash(s);
        v[dim] = 1;
        return v;
      });
    },
  };
}

/**
 * Judge roteirizado: mapa (statementA :: statementB) -> Verdict, simétrico
 * (tenta A::B e B::A). Sem entrada => lança (teste mal-roteirizado falha alto).
 * O judge real recebe os dois statements no `user`; aqui extraímos via marcadores.
 */
function makeFakeJudge(verdicts: Record<string, Verdict>): LlmClient {
  return {
    model: 'fake-judge',
    async complete<T = unknown>(args: LlmCompletionArgs): Promise<T> {
      // O reconcile passa os dois statements no user, demarcados por linhas
      // "A: <statement>" e "B: <statement>" (ver montaJudgeUser no reconcile).
      const a = /(?:^|\n)A: (.*)(?:\n|$)/.exec(args.user)?.[1] ?? '';
      const b = /(?:^|\n)B: (.*)(?:\n|$)/.exec(args.user)?.[1] ?? '';
      const v = verdicts[`${a}::${b}`] ?? verdicts[`${b}::${a}`];
      if (!v) {
        throw new Error(`judge sem veredicto roteirizado para par: "${a}" :: "${b}"`);
      }
      return { verdict: v, reasoning: 'roteirizado' } as unknown as T;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers de seed.
// ─────────────────────────────────────────────────────────────────────────

async function seedEpisode(args: {
  externalId: string;
  workspaceId: string;
  occurredAt: string;
  revision?: number;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, $3, $4, $5)
     RETURNING id`,
    [args.externalId, `ep ${args.externalId}`, args.occurredAt, args.workspaceId, args.revision ?? 1]
  );
  return Number(rows[0]!.id);
}

function vecOneHot(dim: number): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

/** Insere um fato existente (vigente por padrão) direto no banco. */
async function seedFact(
  client: PoolClient,
  overrides: Partial<FactInput> & { workspaceId: string; episodeId: number; statement: string; validAt: string; embedDim: number }
): Promise<number> {
  const base: FactInput = {
    workspaceId: overrides.workspaceId,
    factType: overrides.factType ?? 'decisao',
    statement: overrides.statement,
    attributes: overrides.attributes ?? {},
    confidence: overrides.confidence ?? 0.9,
    validAt: overrides.validAt,
    episodeId: overrides.episodeId,
    episodeRevision: overrides.episodeRevision ?? 1,
    turnStart: overrides.turnStart ?? 0,
    turnEnd: overrides.turnEnd ?? 1,
    embedding: vecOneHot(overrides.embedDim),
    embeddingModel: 'fake@1024',
    extractedBy: 'seed',
    needsReview: overrides.needsReview,
    reviewNote: overrides.reviewNote,
    invalidAt: overrides.invalidAt,
    invalidationReason: overrides.invalidationReason,
    supersededByFactId: overrides.supersededByFactId,
  };
  return insertFactTx(client, base);
}

function candidate(overrides: Partial<FactCandidate> & { statement: string }): FactCandidate {
  return {
    fact_type: overrides.fact_type ?? 'decisao',
    statement: overrides.statement,
    attributes: overrides.attributes ?? {},
    turn_start: overrides.turn_start ?? 0,
    turn_end: overrides.turn_end ?? 1,
    confidence: overrides.confidence ?? 0.9,
    valid_at_hint: overrides.valid_at_hint,
  };
}

/** Roda reconcileEpisode dentro de uma TX própria (BEGIN/COMMIT no caller — o teste). */
async function runReconcile(
  args: {
    workspaceId: string;
    episodeId: number;
    occurredAt: string;
    candidates: FactCandidate[];
    episodeRevision?: number;
  },
  deps: { embeddingClient: EmbeddingClient; judge: LlmClient }
): Promise<{ inserted: number; superseded: number; flagged: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await reconcileEpisode(
      client,
      {
        workspaceId: args.workspaceId,
        episodeId: args.episodeId,
        episodeRevision: args.episodeRevision ?? 1,
        occurredAt: args.occurredAt,
        candidates: args.candidates,
        extractedBy: 'test-extractor',
      },
      deps
    );
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function fetchFacts(workspaceId: string): Promise<
  {
    id: number;
    statement: string;
    valid_at: Date;
    invalid_at: Date | null;
    superseded_by_fact_id: number | null;
    invalidation_reason: string | null;
    needs_review: boolean;
    review_note: string | null;
    confidence: number;
  }[]
> {
  const { rows } = await pool.query(
    `SELECT id, statement, valid_at, invalid_at, superseded_by_fact_id,
            invalidation_reason, needs_review, review_note, confidence
       FROM facts WHERE workspace_id = $1 ORDER BY id`,
    [workspaceId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    statement: r.statement,
    valid_at: r.valid_at,
    invalid_at: r.invalid_at,
    superseded_by_fact_id: r.superseded_by_fact_id == null ? null : Number(r.superseded_by_fact_id),
    invalidation_reason: r.invalidation_reason,
    needs_review: r.needs_review,
    review_note: r.review_note,
    confidence: Number(r.confidence),
  }));
}

// ─────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await pool.query(
    `TRUNCATE facts, conduta_rule_sources, conduta_rules, condutas, episode_chunks RESTART IDENTITY CASCADE`
  );
  await pool.query(`TRUNCATE episodes, episode_turns RESTART IDENTITY CASCADE`);
});

after(async () => {
  await pool.end();
});

const WS = 'w1';

// ── 1. Zero vizinhos → INSERT direto ───────────────────────────────────────

test('zero vizinhos: candidato vira fato vigente direto', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-05-01T00:00:00Z' });
  const res = await runReconcile(
    { workspaceId: WS, episodeId: ep, occurredAt: '2026-05-01T00:00:00Z', candidates: [candidate({ statement: 'a verba e 5k' })] },
    { embeddingClient: makeFakeEmbedding(), judge: makeFakeJudge({}) }
  );
  assert.equal(res.inserted, 1);
  assert.equal(res.superseded, 0);
  const facts = await fetchFacts(WS);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.invalid_at, null);
  assert.equal(facts[0]!.needs_review, false);
});

// ── 2. duplicate: não insere; bumpa confidence e registra no review_note ────

test('duplicate: nao insere; bumpa confidence do existente e registra no review_note (sem needs_review)', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-05-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let existingId: number;
  try {
    await seedClient.query('BEGIN');
    existingId = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'a verba e 5k', validAt: '2026-05-01T00:00:00Z',
      embedDim: 5, confidence: 0.6,
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-05-02T00:00:00Z',
      candidates: [candidate({ statement: 'verba mensal de 5k', confidence: 0.95 })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 5k': 5, 'verba mensal de 5k': 5 }),
      judge: makeFakeJudge({ 'verba mensal de 5k::a verba e 5k': 'duplicate' }),
    }
  );

  assert.equal(res.inserted, 0);
  const facts = await fetchFacts(WS);
  assert.equal(facts.length, 1, 'duplicate nao insere');
  assert.equal(facts[0]!.id, existingId!);
  assert.ok(Math.abs(facts[0]!.confidence - 0.95) < 1e-6, 'confidence bumpada para a do candidato');
  assert.equal(facts[0]!.needs_review, false, 'bump nao seta needs_review (§14 #15)');
  assert.match(facts[0]!.review_note ?? '', /confiden/i, 'bump registrado no review_note');
});

// ── 3. supersedes normal (N.valid_at > E.valid_at) ─────────────────────────

test('supersedes normal: E invalidado por N, superseded_by=N', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-06-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let existingId: number;
  try {
    await seedClient.query('BEGIN');
    existingId = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'a verba e 5k', validAt: '2026-05-01T00:00:00Z', embedDim: 7,
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-06-01T00:00:00Z',
      candidates: [candidate({ statement: 'a verba e 8k' })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 5k': 7, 'a verba e 8k': 7 }),
      judge: makeFakeJudge({ 'a verba e 8k::a verba e 5k': 'supersedes' }),
    }
  );

  assert.equal(res.inserted, 1);
  assert.equal(res.superseded, 1);
  const facts = await fetchFacts(WS);
  const E = facts.find((f) => f.id === existingId!)!;
  const N = facts.find((f) => f.statement === 'a verba e 8k')!;
  assert.equal(N.invalid_at, null, 'N vigente');
  assert.notEqual(E.invalid_at, null, 'E invalidado');
  assert.equal(E.superseded_by_fact_id, N.id);
  assert.equal(E.invalidation_reason, 'superseded');
  // invalid_at do E = valid_at do N (= occurred_at, pois sem hint)
  assert.equal(E.invalid_at!.getTime(), N.valid_at.getTime());
});

// ── 4. supersedes RETROATIVO (N.valid_at < E.valid_at) ─────────────────────

test('supersedes retroativo: N nasce invalido apontando E (CHECK satisfeito)', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-04-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let existingId: number;
  try {
    await seedClient.query('BEGIN');
    existingId = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'a verba e 8k', validAt: '2026-06-01T00:00:00Z', embedDim: 9,
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  // Episódio antigo processado depois: N.valid_at = occurred_at = 2026-04-01 < E.valid_at
  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-04-01T00:00:00Z',
      candidates: [candidate({ statement: 'a verba e 5k' })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 8k': 9, 'a verba e 5k': 9 }),
      judge: makeFakeJudge({ 'a verba e 5k::a verba e 8k': 'supersedes' }),
    }
  );

  assert.equal(res.inserted, 1);
  const facts = await fetchFacts(WS);
  const E = facts.find((f) => f.id === existingId!)!;
  const N = facts.find((f) => f.statement === 'a verba e 5k')!;
  assert.equal(E.invalid_at, null, 'E (mais novo) permanece vigente');
  assert.notEqual(N.invalid_at, null, 'N (retroativo) nasce invalido');
  assert.equal(N.superseded_by_fact_id, E.id, 'N apontando E como sucessor');
  assert.equal(N.invalidation_reason, 'superseded');
  assert.equal(N.invalid_at!.getTime(), E.valid_at.getTime(), 'N.invalid_at = E.valid_at');
});

// ── 5. retroativo com MÚLTIPLOS vigentes: sucessor = menor valid_at > N.valid_at

test('retroativo com multiplos vigentes: sucessor e o E de menor valid_at posterior a N', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-03-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let e1: number; // valid_at 2026-05-01 (o adjacente — sucessor esperado)
  let e2: number; // valid_at 2026-07-01 (mais longe)
  try {
    await seedClient.query('BEGIN');
    e1 = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'verba maio 6k', validAt: '2026-05-01T00:00:00Z', embedDim: 11,
    });
    e2 = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'verba julho 9k', validAt: '2026-07-01T00:00:00Z', embedDim: 11,
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  // N retroativo (2026-03-01), supersedes contra AMBOS os vigentes posteriores.
  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-03-01T00:00:00Z',
      candidates: [candidate({ statement: 'verba marco 4k' })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'verba maio 6k': 11, 'verba julho 9k': 11, 'verba marco 4k': 11 }),
      judge: makeFakeJudge({
        'verba marco 4k::verba maio 6k': 'supersedes',
        'verba marco 4k::verba julho 9k': 'supersedes',
      }),
    }
  );

  assert.equal(res.inserted, 1);
  const facts = await fetchFacts(WS);
  const N = facts.find((f) => f.statement === 'verba marco 4k')!;
  assert.notEqual(N.invalid_at, null, 'N nasce invalido');
  assert.equal(N.superseded_by_fact_id, e1!, 'sucessor e o E de MENOR valid_at posterior (maio, nao julho)');
  // os vigentes posteriores NAO sao invalidados por N retroativo
  const E1 = facts.find((f) => f.id === e1!)!;
  const E2 = facts.find((f) => f.id === e2!)!;
  assert.equal(E1.invalid_at, null);
  assert.equal(E2.invalid_at, null);
});

// ── 6. same valid_at, valores diferentes → contradicts forçado ─────────────

test('mesmo valid_at com supersedes: forca contradicts (ambos needs_review), nunca por ordem', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-05-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let existingId: number;
  try {
    await seedClient.query('BEGIN');
    existingId = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'a verba e 8k', validAt: '2026-05-01T00:00:00Z', embedDim: 13,
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-05-01T00:00:00Z',
      candidates: [candidate({ statement: 'a verba e 5k' })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 8k': 13, 'a verba e 5k': 13 }),
      judge: makeFakeJudge({ 'a verba e 5k::a verba e 8k': 'supersedes' }),
    }
  );

  assert.equal(res.inserted, 1, 'contradicts insere o candidato');
  const facts = await fetchFacts(WS);
  const E = facts.find((f) => f.id === existingId!)!;
  const N = facts.find((f) => f.statement === 'a verba e 5k')!;
  assert.equal(E.invalid_at, null, 'nenhum invalidado (ambiguo)');
  assert.equal(N.invalid_at, null);
  assert.equal(E.needs_review, true);
  assert.equal(N.needs_review, true);
});

// ── 7. contradicts → insere + needs_review em ambos ────────────────────────

test('contradicts: insere candidato e marca needs_review em ambos', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-05-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let existingId: number;
  try {
    await seedClient.query('BEGIN');
    existingId = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'cliente prefere reels', validAt: '2026-05-01T00:00:00Z',
      embedDim: 15, factType: 'preferencia',
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-05-02T00:00:00Z',
      candidates: [candidate({ statement: 'cliente prefere feed', fact_type: 'preferencia' as FactType })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'cliente prefere reels': 15, 'cliente prefere feed': 15 }),
      judge: makeFakeJudge({ 'cliente prefere feed::cliente prefere reels': 'contradicts' }),
    }
  );

  assert.equal(res.inserted, 1);
  const facts = await fetchFacts(WS);
  const E = facts.find((f) => f.id === existingId!)!;
  const N = facts.find((f) => f.statement === 'cliente prefere feed')!;
  assert.equal(E.needs_review, true);
  assert.equal(N.needs_review, true);
  assert.equal(E.invalid_at, null);
  assert.equal(N.invalid_at, null);
});

// ── 8. unrelated → INSERT direto ───────────────────────────────────────────

test('unrelated: coexistem, candidato vira fato vigente', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-05-01T00:00:00Z' });
  const seedClient = await pool.connect();
  try {
    await seedClient.query('BEGIN');
    await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'a verba e 5k', validAt: '2026-05-01T00:00:00Z', embedDim: 17,
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-05-02T00:00:00Z',
      candidates: [candidate({ statement: 'meta de 100 leads' })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 5k': 17, 'meta de 100 leads': 17 }),
      judge: makeFakeJudge({ 'meta de 100 leads::a verba e 5k': 'unrelated' }),
    }
  );

  assert.equal(res.inserted, 1);
  const facts = await fetchFacts(WS);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((f) => f.invalid_at === null));
});

// ── 9. intra-episódio: duplicate colapsa mantendo janela mais larga ────────

test('intra-episodio duplicate: colapsa em 1 candidato, mantem a janela de turnos mais larga', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-05-01T00:00:00Z' });
  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-05-01T00:00:00Z',
      candidates: [
        candidate({ statement: 'a verba e 5k', turn_start: 10, turn_end: 12 }),
        candidate({ statement: 'verba mensal 5k', turn_start: 8, turn_end: 20 }), // janela mais larga
      ],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 5k': 19, 'verba mensal 5k': 19 }),
      judge: makeFakeJudge({ 'a verba e 5k::verba mensal 5k': 'duplicate' }),
    }
  );

  assert.equal(res.inserted, 1, 'duplicate intra-episodio insere 1 so');
  const { rows } = await pool.query<{ turn_start: number; turn_end: number }>(
    `SELECT turn_start, turn_end FROM facts WHERE workspace_id = $1`,
    [WS]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.turn_start, 8, 'janela mais larga preservada (turn_start menor)');
  assert.equal(rows[0]!.turn_end, 20, 'janela mais larga preservada (turn_end maior)');
});

// ── 10. intra-episódio: supersedes → turn_start maior vence ────────────────

test('intra-episodio supersedes: o de turn_start MAIOR vence; o anterior nasce invalido', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-05-01T00:00:00Z' });
  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-05-01T00:00:00Z',
      candidates: [
        candidate({ statement: 'verba de 5k', turn_start: 10, turn_end: 11 }), // anterior
        candidate({ statement: 'na real 6k', turn_start: 40, turn_end: 41 }), // posterior (vence)
      ],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'verba de 5k': 21, 'na real 6k': 21 }),
      judge: makeFakeJudge({ 'verba de 5k::na real 6k': 'supersedes' }),
    }
  );

  assert.equal(res.inserted, 2, 'ambas as falas preservadas');
  const facts = await fetchFacts(WS);
  const anterior = facts.find((f) => f.statement === 'verba de 5k')!;
  const posterior = facts.find((f) => f.statement === 'na real 6k')!;
  assert.notEqual(anterior.invalid_at, null, 'o anterior (turn_start menor) nasce invalido');
  assert.equal(posterior.invalid_at, null, 'o posterior (turn_start maior) vence');
  assert.equal(anterior.superseded_by_fact_id, posterior.id);
  assert.equal(anterior.invalidation_reason, 'superseded');
});

// ── 11. confidence < 0.5 → needs_review e nunca supersede automático como N ─

test('confianca < 0.5: insere com needs_review e NUNCA invalida outro como N', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-06-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let existingId: number;
  try {
    await seedClient.query('BEGIN');
    existingId = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'a verba e 5k', validAt: '2026-05-01T00:00:00Z', embedDim: 23,
    });
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  // candidato com confidence baixa, judge diria supersedes — mas não pode agir como N
  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-06-01T00:00:00Z',
      candidates: [candidate({ statement: 'talvez a verba seja 8k', confidence: 0.3 })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 5k': 23, 'talvez a verba seja 8k': 23 }),
      judge: makeFakeJudge({ 'talvez a verba seja 8k::a verba e 5k': 'supersedes' }),
    }
  );

  assert.equal(res.inserted, 1);
  const facts = await fetchFacts(WS);
  const E = facts.find((f) => f.id === existingId!)!;
  const N = facts.find((f) => f.statement === 'talvez a verba seja 8k')!;
  assert.equal(N.needs_review, true, 'confianca baixa => needs_review');
  assert.equal(E.invalid_at, null, 'E NAO invalidado por candidato de confianca baixa');
  assert.equal(N.invalid_at, null, 'N inserido vigente (apenas flagado)');
});

// ── 12. supersede sobre fato citado em conduta ativa → conduta_rules.needs_review

test('supersede sobre fato citado em conduta ativa: marca conduta_rules.needs_review', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: WS, occurredAt: '2026-06-01T00:00:00Z' });
  const seedClient = await pool.connect();
  let existingId: number;
  let ruleId: number;
  try {
    await seedClient.query('BEGIN');
    existingId = await seedFact(seedClient, {
      workspaceId: WS, episodeId: ep, statement: 'a verba e 5k', validAt: '2026-05-01T00:00:00Z', embedDim: 25,
    });
    // conduta ativa citando o fato
    const { rows: cond } = await seedClient.query<{ id: string }>(
      `INSERT INTO condutas (workspace_id, version, status, content_md) VALUES ($1, 1, 'active', '# conduta') RETURNING id`,
      [WS]
    );
    const condId = Number(cond[0]!.id);
    const { rows: rule } = await seedClient.query<{ id: string }>(
      `INSERT INTO conduta_rules (conduta_id, rule_index, text) VALUES ($1, 0, 'regra que cita o fato') RETURNING id`,
      [condId]
    );
    ruleId = Number(rule[0]!.id);
    await seedClient.query(
      `INSERT INTO conduta_rule_sources (rule_id, fact_id) VALUES ($1, $2)`,
      [ruleId, existingId]
    );
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }

  const res = await runReconcile(
    {
      workspaceId: WS, episodeId: ep, occurredAt: '2026-06-01T00:00:00Z',
      candidates: [candidate({ statement: 'a verba e 8k' })],
    },
    {
      embeddingClient: makeFakeEmbedding({ 'a verba e 5k': 25, 'a verba e 8k': 25 }),
      judge: makeFakeJudge({ 'a verba e 8k::a verba e 5k': 'supersedes' }),
    }
  );

  assert.equal(res.superseded, 1, 'supersede acontece normalmente');
  const facts = await fetchFacts(WS);
  const E = facts.find((f) => f.id === existingId!)!;
  assert.notEqual(E.invalid_at, null, 'fato citado foi invalidado');
  const { rows } = await pool.query<{ needs_review: boolean }>(
    `SELECT needs_review FROM conduta_rules WHERE id = $1`,
    [ruleId!]
  );
  assert.equal(rows[0]!.needs_review, true, 'a regra de conduta que citava o fato fica needs_review');
});
