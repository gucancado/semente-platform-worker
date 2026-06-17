import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { runBootstrap } from '../../src/lua/bootstrap.js';

// ─────────────────────────────────────────────────────────────────────────
// Bootstrap CLI (Task 13 / spec §5.5). Cobrimos o caminho --dry-run, que é o
// único que NÃO toca rede (não chama embeddings nem LLM nem grava fatos/chunks).
// O caminho real é coberto por pipeline-b.test.ts (runEpisode em si).
// ─────────────────────────────────────────────────────────────────────────

async function seedEpisode(args: {
  externalId: string;
  workspaceId: string | null;
  occurredAt: string;
  title?: string;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, $3, $4, 1)
     RETURNING id`,
    [args.externalId, args.title ?? `ep ${args.externalId}`, args.occurredAt, args.workspaceId]
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

beforeEach(async () => {
  await pool.query(
    `TRUNCATE lua_processing, lua_runs, episode_chunks, facts, episodes, episode_turns
     RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. --dry-run: nada gravado (fatos/chunks), órfão ignorado, relatório com os
//    episódios elegíveis em occurred_at ASC + estimativa de tokens positiva.
// ─────────────────────────────────────────────────────────────────────────

test('--dry-run nao grava, ignora orfao, lista elegiveis em occurred_at ASC com estimativa', async () => {
  // 3 com workspace, ordens fora de sequência; 1 órfão (workspace NULL).
  const epB = await seedEpisode({ externalId: 'b', workspaceId: 'w1', occurredAt: '2026-05-10T10:00:00Z' });
  const epA = await seedEpisode({ externalId: 'a', workspaceId: 'w1', occurredAt: '2026-05-01T10:00:00Z' });
  const epC = await seedEpisode({ externalId: 'c', workspaceId: 'w2', occurredAt: '2026-05-20T10:00:00Z' });
  const epOrphan = await seedEpisode({ externalId: 'orf', workspaceId: null, occurredAt: '2026-05-05T10:00:00Z' });

  for (const ep of [epA, epB, epC, epOrphan]) {
    await seedTurns(ep, [
      { index: 0, name: 'Ana', text: 'A verba do mes que vem sobe pra 8k reais agora.' },
      { index: 1, name: 'Gustavo', text: 'Combinado, fecho com 8k entao e sigo o plano.' },
    ]);
  }

  const report = await runBootstrap({ dryRun: true });

  // Órfão não entra; 3 elegíveis.
  assert.equal(report.dryRun, true);
  assert.equal(report.episodesSeen, 3, '3 episodios elegiveis (orfao fora)');
  assert.equal(report.episodes.length, 3);

  // Ordem occurred_at ASC: A (01) -> B (10) -> C (20).
  assert.deepEqual(
    report.episodes.map((e) => e.episodeId),
    [epA, epB, epC],
    'episodios em occurred_at ASC'
  );

  // Órfão não está na lista.
  assert.ok(!report.episodes.some((e) => e.episodeId === epOrphan), 'orfao ausente');

  // Estimativa de tokens positiva e chunks contados.
  assert.ok(report.totalChunks >= 3, 'ao menos 1 chunk por episodio');
  assert.ok(report.totalTokens > 0, 'estimativa de tokens positiva');
  assert.ok(report.estEmbeddingsUsd > 0, 'custo embeddings positivo');
  assert.ok(report.estExtractionUsd > 0, 'custo extracao positivo');

  // NADA foi gravado.
  const { rows: chunkRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_chunks`
  );
  assert.equal(chunkRows[0]!.n, 0, 'dry-run nao grava chunks');
  const { rows: factRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts`
  );
  assert.equal(factRows[0]!.n, 0, 'dry-run nao grava fatos');

  // Um run kind=bootstrap foi aberto e fechado (done).
  const { rows: runRows } = await pool.query<{ kind: string; status: string }>(
    `SELECT kind, status FROM lua_runs`
  );
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]!.kind, 'bootstrap');
  assert.equal(runRows[0]!.status, 'done');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. --workspace escopa a varredura; --limit limita a contagem.
// ─────────────────────────────────────────────────────────────────────────

test('--workspace escopa por workspace e --limit limita', async () => {
  const epW1a = await seedEpisode({ externalId: 'w1a', workspaceId: 'w1', occurredAt: '2026-05-01T10:00:00Z' });
  const epW1b = await seedEpisode({ externalId: 'w1b', workspaceId: 'w1', occurredAt: '2026-05-02T10:00:00Z' });
  await seedEpisode({ externalId: 'w2a', workspaceId: 'w2', occurredAt: '2026-05-03T10:00:00Z' });
  for (const ep of [epW1a, epW1b]) {
    await seedTurns(ep, [{ index: 0, name: 'Ana', text: 'Texto qualquer para chunk.' }]);
  }

  const scoped = await runBootstrap({ dryRun: true, workspaceId: 'w1' });
  assert.equal(scoped.episodesSeen, 2, 'apenas episodios de w1');
  assert.ok(scoped.episodes.every((e) => e.workspaceId === 'w1'));

  const limited = await runBootstrap({ dryRun: true, workspaceId: 'w1', limit: 1 });
  assert.equal(limited.episodesSeen, 1, 'limit=1 cobre apenas 1 episodio');
  // occurred_at ASC => o primeiro é o mais antigo (epW1a).
  assert.equal(limited.episodes[0]!.episodeId, epW1a);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Caminho real com deps fake injetadas: grava chunks + fatos.
// ─────────────────────────────────────────────────────────────────────────

test('run real com deps fake grava chunks e fatos em occurred_at ASC', async () => {
  const fakeEmbeddingClient = {
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
  const fakeExtractor = {
    model: 'fake-extractor',
    async complete<T = unknown>(): Promise<T> {
      return {
        facts: [
          {
            fact_type: 'decisao',
            statement: `decisao ${Math.random()}`,
            attributes: {},
            turn_start: 0,
            turn_end: 0,
            confidence: 0.9,
          },
        ],
      } as unknown as T;
    },
  };
  const fakeJudge = {
    model: 'fake-judge',
    async complete<T = unknown>(): Promise<T> {
      return { verdict: 'unrelated', reasoning: 'default' } as unknown as T;
    },
  };

  const epA = await seedEpisode({ externalId: 'a', workspaceId: 'w1', occurredAt: '2026-05-01T10:00:00Z' });
  const epB = await seedEpisode({ externalId: 'b', workspaceId: 'w1', occurredAt: '2026-05-10T10:00:00Z' });
  for (const ep of [epA, epB]) {
    await seedTurns(ep, [{ index: 0, name: 'Ana', text: 'A verba sobe pra 8k reais.' }]);
  }

  const report = await runBootstrap(
    { dryRun: false },
    {
      embeddingClient: fakeEmbeddingClient,
      llmClient: fakeExtractor,
      judge: fakeJudge,
    }
  );

  assert.equal(report.dryRun, false);
  assert.equal(report.processed, 2, '2 episodios processados');
  assert.equal(report.failed, 0);

  const { rows: chunkRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_chunks`
  );
  assert.ok(chunkRows[0]!.n >= 2, 'chunks gravados no run real');
  const { rows: factRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts`
  );
  assert.equal(factRows[0]!.n, 2, 'um fato por episodio');

  const { rows: runRows } = await pool.query<{ kind: string; status: string }>(
    `SELECT kind, status FROM lua_runs`
  );
  assert.equal(runRows[0]!.kind, 'bootstrap');
  assert.equal(runRows[0]!.status, 'done');
});

// ─────────────────────────────────────────────────────────────────────────
// Falha de episódio NÃO pode ser silenciosa (observabilidade do run pago): o
// worker deve registrar o erro via failProcessing (last_error + retry/backoff),
// não engolir no catch. Antes do fix a linha ficava 'chunked' com last_error
// NULL e o erro sumia.
// ─────────────────────────────────────────────────────────────────────────

test('run real: episodio que falha registra last_error (nao silencioso)', async () => {
  const fakeEmbeddingClient = {
    model: 'fake@1024',
    async embed(inputs: string[]): Promise<number[][]> {
      return inputs.map(() => {
        const v = new Array(1024).fill(0);
        v[42] = 1;
        return v;
      });
    },
  };
  // Extrator que SEMPRE lança -> runEpisode (estágio B) propaga -> o worker do
  // bootstrap precisa registrar a falha, não engolir.
  const throwingExtractor = {
    model: 'fake-extractor',
    async complete<T = unknown>(): Promise<T> {
      throw new Error('boom-extract-187');
    },
  };
  const fakeJudge = {
    model: 'fake-judge',
    async complete<T = unknown>(): Promise<T> {
      return { verdict: 'unrelated', reasoning: 'x' } as unknown as T;
    },
  };

  const ep = await seedEpisode({ externalId: 'fail', workspaceId: 'w1', occurredAt: '2026-05-01T10:00:00Z' });
  await seedTurns(ep, [{ index: 0, name: 'Ana', text: 'A verba sobe pra 8k reais.' }]);

  const report = await runBootstrap(
    { dryRun: false },
    { embeddingClient: fakeEmbeddingClient, llmClient: throwingExtractor, judge: fakeJudge }
  );

  assert.equal(report.failed, 1, 'a falha foi contada');
  assert.equal(report.processed, 0, 'nenhum processado');

  // A linha NÃO pode ficar invisível: status failed/dead + last_error gravado.
  const { rows } = await pool.query<{ status: string; last_error: string | null; attempt_count: number }>(
    `SELECT status, last_error, attempt_count FROM lua_processing WHERE episode_id = $1`,
    [ep]
  );
  assert.ok(['failed', 'dead'].includes(rows[0]!.status), `status visível de falha, veio '${rows[0]!.status}'`);
  assert.ok(rows[0]!.last_error && rows[0]!.last_error.includes('boom-extract-187'), 'last_error gravado com a mensagem');
  assert.ok(rows[0]!.attempt_count >= 1, 'attempt_count incrementado');
});
