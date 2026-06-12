import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { enqueueEligibleEpisodes, claimProcessing } from '../../src/lua/db.js';
import { runStageA } from '../../src/lua/pipeline.js';
import type { EmbeddingClient } from '../../src/lua/embeddings.js';

// ── Fake embedding client (determinístico, SEM rede) ───────────────────────
// Um vetor 1024-dim por input: tudo 0 exceto a posição i%1024 = 1. A ordem é
// preservada (o batcher concatena na ordem de entrada), então cada chunk recebe
// um embedding distinto e reconstituível.
const fakeEmbeddingClient: EmbeddingClient = {
  model: 'fake@1024',
  async embed(xs: string[]): Promise<number[][]> {
    return xs.map((_, i) => {
      const v = new Array(1024).fill(0);
      v[i % 1024] = 1;
      return v;
    });
  },
};

// ── Seed: episódio (colunas reais da migration 015) + N turnos ─────────────

async function seedEpisode(args: {
  externalId: string;
  workspaceId: string | null;
  occurredAt?: string;
  revision?: number;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, $3, $4)
     RETURNING id`,
    [
      args.externalId,
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

/** Enfileira + reivindica e devolve a (única) linha reivindicada. */
async function enqueueAndClaim() {
  await enqueueEligibleEpisodes();
  const claimed = await claimProcessing('w-test', 10);
  assert.equal(claimed.length, 1, 'esperava exatamente 1 linha reivindicada');
  return claimed[0]!;
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE lua_processing, episode_chunks, episodes, episode_turns RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

// ── 1. Happy path: chunks persistidos com embedding_model + status chunked ──

test('runStageA grava chunks com embedding_model e marca status chunked', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'Oi pessoal, bom dia.' },
    { index: 1, name: 'Gustavo', text: 'Bom dia! Vamos comecar.' },
    { index: 2, name: 'Ana', text: 'A verba do mes que vem sobe pra 8k.' },
  ]);
  const row = await enqueueAndClaim();

  const res = await runStageA(row, { embeddingClient: fakeEmbeddingClient });

  assert.ok(res.chunks >= 1, 'esperava ao menos 1 chunk');

  const { rows: chunkRows } = await pool.query<{
    n: number;
    models: string[];
    ws: string[];
  }>(
    `SELECT count(*)::int AS n,
            array_agg(DISTINCT embedding_model) AS models,
            array_agg(DISTINCT workspace_id) AS ws
       FROM episode_chunks WHERE episode_id = $1`,
    [ep]
  );
  assert.equal(chunkRows[0]!.n, res.chunks, 'contagem persistida == retorno');
  assert.deepEqual(chunkRows[0]!.models, ['fake@1024']);
  assert.deepEqual(chunkRows[0]!.ws, ['w1']);

  const { rows: procRows } = await pool.query<{ status: string }>(
    `SELECT status FROM lua_processing WHERE id = $1`,
    [row.id]
  );
  assert.equal(procRows[0]!.status, 'chunked');
});

// ── 2. Contagem bate com o chunker (chunkTurns aplicado aos turnos do ep) ───

test('runStageA grava exatamente a contagem de chunks do chunker', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'Primeiro turno curto.' },
    { index: 1, name: 'Gustavo', text: 'Segundo turno curto.' },
  ]);
  const row = await enqueueAndClaim();

  const res = await runStageA(row, { embeddingClient: fakeEmbeddingClient });

  // Dois turnos curtos cabem num único chunk multi-turno (~< 450 tokens).
  assert.equal(res.chunks, 1);
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_chunks WHERE episode_id = $1`,
    [ep]
  );
  assert.equal(rows[0]!.n, 1);
});

// ── 3. Idempotência: re-rodar num claim fresco não duplica (delete-insert) ──

test('runStageA é idempotente em re-claim (sem duplicatas)', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'Turno um do episodio.' },
    { index: 1, name: 'Gustavo', text: 'Turno dois do episodio.' },
    { index: 2, name: 'Ana', text: 'Turno tres do episodio.' },
  ]);

  const row1 = await enqueueAndClaim();
  const res1 = await runStageA(row1, { embeddingClient: fakeEmbeddingClient });

  // Segundo claim: status 'chunked' é reivindicável (lista de status do claim),
  // mas o lease ainda é recente → forçamos um novo claim expirando o anterior.
  await pool.query(
    `UPDATE lua_processing SET claimed_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
    [row1.id]
  );
  const claimed2 = await claimProcessing('w-test-2', 10);
  assert.equal(claimed2.length, 1);
  const res2 = await runStageA(claimed2[0]!, { embeddingClient: fakeEmbeddingClient });

  assert.equal(res2.chunks, res1.chunks, 'contagem estável entre rodadas');
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_chunks WHERE episode_id = $1`,
    [ep]
  );
  assert.equal(rows[0]!.n, res1.chunks, 'sem linhas duplicadas');
});

// ── 4. Fencing do lease: claimed_at obsoleto → {chunks:0}, NÃO marca chunked ─

test('runStageA com lease perdido descarta (chunks 0) e não marca chunked', async () => {
  const ep = await seedEpisode({ externalId: 'a', workspaceId: 'w1' });
  await seedTurns(ep, [
    { index: 0, name: 'Ana', text: 'Turno do episodio com lease perdido.' },
    { index: 1, name: 'Gustavo', text: 'Outro turno qualquer aqui.' },
  ]);
  const row = await enqueueAndClaim();

  // Simula lease perdido: muta o claimed_at do row em memória para um instante
  // antigo que NÃO bate com o claimed_at vigente na linha → finishProcessingTx
  // afeta 0 linhas (fencing) → ROLLBACK → {chunks:0}.
  const staleRow = { ...row, claimed_at: new Date('2000-01-01T00:00:00Z') };

  const res = await runStageA(staleRow, { embeddingClient: fakeEmbeddingClient });
  assert.equal(res.chunks, 0);

  // Status NÃO virou 'chunked' por essa chamada obsoleta; chunks revertidos.
  const { rows: procRows } = await pool.query<{ status: string }>(
    `SELECT status FROM lua_processing WHERE id = $1`,
    [row.id]
  );
  assert.notEqual(procRows[0]!.status, 'chunked');
  const { rows: chunkRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_chunks WHERE episode_id = $1`,
    [ep]
  );
  assert.equal(chunkRows[0]!.n, 0, 'chunks da TX abortada não persistem');
});
