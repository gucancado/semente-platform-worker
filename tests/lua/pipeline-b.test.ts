import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { enqueueEligibleEpisodes, claimProcessing } from '../../src/lua/db.js';
import { runStageB, runEpisode } from '../../src/lua/pipeline.js';
import type { EmbeddingClient } from '../../src/lua/embeddings.js';
import type { LlmClient, LlmCompletionArgs } from '../../src/lua/llm.js';
import type { FactCandidate } from '../../src/lua/extract.js';

// ─────────────────────────────────────────────────────────────────────────
// Fakes (sem rede): embedding determinístico + llm de extração roteirizado +
// judge roteirizado. Espelham os fakes de reconcile.test/pipeline-a.test.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Embedding determinístico: input -> one-hot 1024-dim por hash estável do texto.
 * Statements distintos colidem só por acaso (faixa 20..1019); para o cenário
 * limpo de reprocessamento basta que statements diferentes NÃO sejam vizinhos.
 */
const fakeEmbeddingClient: EmbeddingClient = {
  model: 'fake@1024',
  async embed(inputs: string[]): Promise<number[][]> {
    const hash = (s: string): number => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      return (h % 1000) + 20;
    };
    return inputs.map((s) => {
      const v = new Array(1024).fill(0);
      v[hash(s)] = 1;
      return v;
    });
  },
};

/**
 * LLM de extração roteirizado: devolve um conjunto fixo de FactCandidate[] no
 * shape do structured output ({ facts }). Ignora o prompt (não há rede). O
 * `model` vira `facts.extracted_by` via reconcileEpisode.
 */
function makeFakeExtractor(facts: FactCandidate[]): LlmClient {
  return {
    model: 'fake-extractor',
    async complete<T = unknown>(_args: LlmCompletionArgs): Promise<T> {
      return { facts } as unknown as T;
    },
  };
}

/**
 * Judge roteirizado: no cenário limpo (sem vizinhos de banco e sem pares
 * intra-episódio de mesmo tipo que colidam) nunca é chamado. Default 'unrelated'
 * para qualquer par que apareça, evitando quebra acidental.
 */
const fakeJudge: LlmClient = {
  model: 'fake-judge',
  async complete<T = unknown>(_args: LlmCompletionArgs): Promise<T> {
    return { verdict: 'unrelated', reasoning: 'default' } as unknown as T;
  },
};

function deps() {
  return { llmClient: makeFakeExtractor([]), embeddingClient: fakeEmbeddingClient, judge: fakeJudge };
}

// ─────────────────────────────────────────────────────────────────────────
// Seed helpers.
// ─────────────────────────────────────────────────────────────────────────

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

async function seedTurns(
  episodeId: number,
  turns: Array<{ index: number; name: string | null; text: string }>
): Promise<void> {
  for (const t of turns) {
    await pool.query(
      `INSERT INTO episode_turns (episode_id, turn_index, speaker_name, speaker_label, text)
       VALUES ($1, $2, $3, NULL, $4)`,
      [episodeId, t.index, t.name, t.text]
    );
  }
}

/** Enfileira + reivindica a (única) linha esperada e a devolve. */
async function enqueueAndClaim(workerId = 'w-test') {
  await enqueueEligibleEpisodes();
  const claimed = await claimProcessing(workerId, 10);
  assert.equal(claimed.length, 1, 'esperava exatamente 1 linha reivindicada');
  return claimed[0]!;
}

/** Candidato de fato com defaults. */
function candidate(o: Partial<FactCandidate> & { statement: string }): FactCandidate {
  return {
    fact_type: o.fact_type ?? 'decisao',
    statement: o.statement,
    attributes: o.attributes ?? {},
    turn_start: o.turn_start ?? 0,
    turn_end: o.turn_end ?? 1,
    confidence: o.confidence ?? 0.9,
    valid_at_hint: o.valid_at_hint,
  };
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE lua_processing, episode_chunks, facts, episodes, episode_turns,
              condutas, conduta_rules, conduta_rule_sources
     RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Pipeline completo (runEpisode): estágio A grava chunks; estágio B grava
//    fatos com proveniência; status 'done'; stats populadas.
// ─────────────────────────────────────────────────────────────────────────

test('runEpisode roda A+B: chunks + fatos com proveniencia, status done, stats', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1', title: 'Reuniao A' });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'A verba do mes que vem sobe pra 8k.' },
    { index: 1, name: 'Gustavo', text: 'Combinado, fecho com 8k entao.' },
    { index: 2, name: 'Ana', text: 'A meta de leads passa a ser 200 por mes.' },
  ]);
  const row = await enqueueAndClaim();

  const extracted: FactCandidate[] = [
    candidate({ fact_type: 'decisao', statement: 'A verba mensal e 8 mil reais.', turn_start: 0, turn_end: 1 }),
    candidate({ fact_type: 'objetivo', statement: 'A meta de leads e 200 por mes.', turn_start: 2, turn_end: 2 }),
  ];

  const res = await runEpisode(row, {
    llmClient: makeFakeExtractor(extracted),
    embeddingClient: fakeEmbeddingClient,
    judge: fakeJudge,
  });

  assert.equal(res.inserted, 2, 'dois fatos inseridos');
  assert.equal(res.superseded, 0);
  assert.equal(res.flagged, 0);
  assert.ok(res.chunks >= 1, 'estagio A produziu chunks');

  // Estágio A: chunks persistidos.
  const { rows: chunkRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_chunks WHERE episode_id = $1`,
    [ep]
  );
  assert.equal(chunkRows[0]!.n, res.chunks);

  // Estágio B: fatos persistidos com proveniência (episode_id, revision, turnos, extracted_by).
  const { rows: factRows } = await pool.query<{
    n: number;
    eps: number[];
    revs: number[];
    extractors: string[];
  }>(
    `SELECT count(*)::int AS n,
            array_agg(DISTINCT episode_id) AS eps,
            array_agg(DISTINCT episode_revision) AS revs,
            array_agg(DISTINCT extracted_by) AS extractors
       FROM facts WHERE workspace_id = 'w1'`
  );
  assert.equal(factRows[0]!.n, 2, 'dois fatos no banco');
  assert.deepEqual(factRows[0]!.eps.map(Number), [ep], 'proveniencia: episode_id correto');
  assert.deepEqual(factRows[0]!.revs.map(Number), [1], 'proveniencia: revision 1');
  assert.deepEqual(factRows[0]!.extractors, ['fake-extractor'], 'extracted_by = model do extrator');

  // lua_processing concluída como done, com stats.
  const { rows: procRows } = await pool.query<{ status: string; stats: Record<string, unknown> }>(
    `SELECT status, stats FROM lua_processing WHERE id = $1`,
    [row.id]
  );
  assert.equal(procRows[0]!.status, 'done');
  assert.equal((procRows[0]!.stats as { facts_new: number }).facts_new, 2);
  assert.equal((procRows[0]!.stats as { facts_superseded: number }).facts_superseded, 0);
  assert.equal((procRows[0]!.stats as { facts_flagged: number }).facts_flagged, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Reprocessamento de revision (§4.6): fatos vigentes da revision anterior
//    NÃO citados por conduta ativa são invalidados ('revision_reprocessed');
//    fatos da revision nova nascem vigentes.
// ─────────────────────────────────────────────────────────────────────────

test('runStageB reprocesso de revision invalida fatos da rev anterior nao citados', async () => {
  const ep = await seedEpisode({ externalId: 'b', workspaceId: 'w2', revision: 1 });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'A verba e 5k.' },
    { index: 1, name: 'Gustavo', text: 'Ok.' },
  ]);

  // Rodada 1 (revision 1): cria dois fatos da rev 1.
  const row1 = await enqueueAndClaim('w1');
  const rev1Facts: FactCandidate[] = [
    candidate({ fact_type: 'decisao', statement: 'Fato antigo rev1 alpha.', turn_start: 0, turn_end: 0 }),
    candidate({ fact_type: 'contexto', statement: 'Fato antigo rev1 beta.', turn_start: 1, turn_end: 1 }),
  ];
  await runStageB(row1, { llmClient: makeFakeExtractor(rev1Facts), embeddingClient: fakeEmbeddingClient, judge: fakeJudge });

  const { rows: afterRev1 } = await pool.query<{ id: string; statement: string }>(
    `SELECT id, statement FROM facts WHERE workspace_id = 'w2' AND invalid_at IS NULL ORDER BY id`
  );
  assert.equal(afterRev1.length, 2, 'rev1 criou 2 fatos vigentes');
  const alphaId = Number(afterRev1[0]!.id);

  // Bump revision do episódio para 2 + enfileira/claima a linha da rev 2.
  await pool.query(`UPDATE episodes SET revision = 2 WHERE id = $1`, [ep]);
  await pool.query(`UPDATE episode_turns SET text = 'A verba e 9k.' WHERE episode_id = $1 AND turn_index = 0`, [ep]);
  const row2 = await enqueueAndClaim('w2-worker');
  assert.equal(row2.episode_revision, 2, 'claim trouxe a linha da rev 2');

  // Estágio A precisa rodar antes (status pending -> chunked). runEpisode faz isso;
  // aqui rodamos só A via runEpisode-like: chamamos runStageB exige status chunked,
  // então rodamos o pipeline completo para a rev 2.
  const rev2Facts: FactCandidate[] = [
    candidate({ fact_type: 'decisao', statement: 'Fato novo rev2 gamma.', turn_start: 0, turn_end: 0 }),
  ];
  const res = await runEpisode(row2, {
    llmClient: makeFakeExtractor(rev2Facts),
    embeddingClient: fakeEmbeddingClient,
    judge: fakeJudge,
  });
  assert.equal(res.inserted, 1, 'rev2 inseriu 1 fato novo');

  // Fatos da rev1 (não citados por conduta) devem estar invalidados com reason.
  const { rows: rev1After } = await pool.query<{
    invalid_at: Date | null;
    invalidation_reason: string | null;
    needs_review: boolean;
  }>(
    `SELECT invalid_at, invalidation_reason, needs_review
       FROM facts WHERE workspace_id = 'w2' AND episode_revision = 1 ORDER BY id`
  );
  assert.equal(rev1After.length, 2);
  for (const f of rev1After) {
    assert.ok(f.invalid_at !== null, 'fato rev1 invalidado');
    assert.equal(f.invalidation_reason, 'revision_reprocessed');
    assert.equal(f.needs_review, false, 'nao citado -> nao precisa review');
  }

  // O fato novo da rev2 está vigente.
  const { rows: rev2After } = await pool.query<{ n: number; statement: string }>(
    `SELECT count(*)::int AS n, min(statement) AS statement
       FROM facts WHERE workspace_id = 'w2' AND episode_revision = 2 AND invalid_at IS NULL`
  );
  assert.equal(rev2After[0]!.n, 1, 'rev2 vigente');
  assert.equal(rev2After[0]!.statement, 'Fato novo rev2 gamma.');

  // Sanity: alphaId é um dos invalidados.
  const { rows: alphaRow } = await pool.query<{ invalid_at: Date | null }>(
    `SELECT invalid_at FROM facts WHERE id = $1`,
    [alphaId]
  );
  assert.ok(alphaRow[0]!.invalid_at !== null);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Reprocessamento §4.6: fato vigente da rev anterior CITADO por conduta
//    ativa NÃO é invalidado — recebe needs_review.
// ─────────────────────────────────────────────────────────────────────────

test('runStageB reprocesso preserva fato citado por conduta ativa (needs_review)', async () => {
  const ep = await seedEpisode({ externalId: 'c', workspaceId: 'w3', revision: 1 });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'Regra: nunca pausar campanha na sexta.' },
  ]);

  const row1 = await enqueueAndClaim('wA');
  const rev1Facts: FactCandidate[] = [
    candidate({ fact_type: 'restricao', statement: 'Nunca pausar campanha na sexta.', turn_start: 0, turn_end: 0 }),
  ];
  await runStageB(row1, { llmClient: makeFakeExtractor(rev1Facts), embeddingClient: fakeEmbeddingClient, judge: fakeJudge });

  const { rows: factRows } = await pool.query<{ id: string }>(
    `SELECT id FROM facts WHERE workspace_id = 'w3' AND invalid_at IS NULL`
  );
  assert.equal(factRows.length, 1);
  const citedFactId = Number(factRows[0]!.id);

  // Cria uma conduta ATIVA que cita esse fato.
  const { rows: cRows } = await pool.query<{ id: string }>(
    `INSERT INTO condutas (workspace_id, version, status, content_md)
     VALUES ('w3', 1, 'active', '# conduta') RETURNING id`
  );
  const condutaId = Number(cRows[0]!.id);
  const { rows: rRows } = await pool.query<{ id: string }>(
    `INSERT INTO conduta_rules (conduta_id, rule_index, text)
     VALUES ($1, 0, 'Nunca pausar sexta') RETURNING id`,
    [condutaId]
  );
  const ruleId = Number(rRows[0]!.id);
  await pool.query(
    `INSERT INTO conduta_rule_sources (rule_id, fact_id) VALUES ($1, $2)`,
    [ruleId, citedFactId]
  );

  // Rev 2.
  await pool.query(`UPDATE episodes SET revision = 2 WHERE id = $1`, [ep]);
  const row2 = await enqueueAndClaim('wB');
  const rev2Facts: FactCandidate[] = [
    candidate({ fact_type: 'restricao', statement: 'Nunca pausar campanha na sexta nem no feriado.', turn_start: 0, turn_end: 0 }),
  ];
  await runEpisode(row2, {
    llmClient: makeFakeExtractor(rev2Facts),
    embeddingClient: fakeEmbeddingClient,
    judge: fakeJudge,
  });

  // O fato citado NÃO foi invalidado; recebeu needs_review.
  const { rows: citedAfter } = await pool.query<{
    invalid_at: Date | null;
    needs_review: boolean;
  }>(
    `SELECT invalid_at, needs_review FROM facts WHERE id = $1`,
    [citedFactId]
  );
  assert.equal(citedAfter[0]!.invalid_at, null, 'fato citado nao invalidado');
  assert.equal(citedAfter[0]!.needs_review, true, 'fato citado recebeu needs_review');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Fencing: claimed_at obsoleto no estágio B → ROLLBACK, status != done,
//    nenhum fato persistido.
// ─────────────────────────────────────────────────────────────────────────

test('runStageB com lease perdido faz ROLLBACK: nao marca done nem grava fatos', async () => {
  const ep = await seedEpisode({ externalId: 'd', workspaceId: 'w4' });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'A verba sobe pra 10k.' },
    { index: 1, name: 'Gustavo', text: 'Fechado.' },
  ]);
  const row = await enqueueAndClaim('wX');

  // Estágio A precisa concluir (status chunked) com o claim vigente.
  const { runStageA } = await import('../../src/lua/pipeline.js');
  await runStageA(row, { embeddingClient: fakeEmbeddingClient });

  // Re-lê a linha (agora chunked, claim ainda vigente) e adultera o claimed_at
  // em memória para um instante que NÃO bate -> fencing reprova.
  const { rows: freshRows } = await pool.query(
    `SELECT * FROM lua_processing WHERE id = $1`,
    [row.id]
  );
  const chunkedRow = freshRows[0] as typeof row;
  const staleRow = { ...chunkedRow, claimed_at: new Date('2000-01-01T00:00:00Z') };

  const rev2Facts: FactCandidate[] = [candidate({ statement: 'fato que nao deve persistir.' })];
  const res = await runStageB(staleRow, {
    llmClient: makeFakeExtractor(rev2Facts),
    embeddingClient: fakeEmbeddingClient,
    judge: fakeJudge,
  });

  assert.equal(res.inserted, 0, 'lease perdido -> nada inserido');

  const { rows: procRows } = await pool.query<{ status: string }>(
    `SELECT status FROM lua_processing WHERE id = $1`,
    [row.id]
  );
  assert.notEqual(procRows[0]!.status, 'done', 'fencing impede done');

  const { rows: factRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts WHERE workspace_id = 'w4'`
  );
  assert.equal(factRows[0]!.n, 0, 'TX abortada: nenhum fato persistido');
});
