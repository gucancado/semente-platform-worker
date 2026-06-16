import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { pool } from '../../src/db.js';
import { runNightlyTick, localTimeInSaoPaulo } from '../../src/lua/scheduler.js';
import type { EmbeddingClient } from '../../src/lua/embeddings.js';
import type { LlmClient, LlmCompletionArgs } from '../../src/lua/llm.js';
import type { FactCandidate } from '../../src/lua/extract.js';
import type { StageBDeps } from '../../src/lua/pipeline.js';
import type { CreateApprovalTask } from '../../src/lua/condutas.js';

// ─────────────────────────────────────────────────────────────────────────
// Scheduler noturno da Lua (Task 17 / spec §5.1, §5.3-C, §12). Tudo com clock
// e deps INJETADOS — nenhum teste toca a rede. DB real (test DB com pgvector).
//
// Fixtures de relogio (SP = UTC-3, sem DST):
//   UTC 06:00 -> 03:00 SP (DENTRO da janela 02-05)
//   UTC 15:00 -> 12:00 SP (FORA da janela)
//   2026-06-15 = segunda; 2026-06-16 = terca.
// ─────────────────────────────────────────────────────────────────────────

const TUE_IN = '2026-06-16T06:00:00Z'; // terca 03:00 SP (dentro)
const TUE_OUT = '2026-06-16T15:00:00Z'; // terca 12:00 SP (fora)
const MON_IN = '2026-06-15T06:00:00Z'; // segunda 03:00 SP (dentro)

// ── Fakes (espelham pipeline-b.test) ────────────────────────────────────────

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

function makeFakeExtractor(facts: FactCandidate[]): LlmClient {
  return {
    model: 'fake-extractor',
    async complete<T = unknown>(_args: LlmCompletionArgs): Promise<T> {
      return { facts } as unknown as T;
    },
  };
}

const fakeJudge: LlmClient = {
  model: 'fake-judge',
  async complete<T = unknown>(_args: LlmCompletionArgs): Promise<T> {
    return { verdict: 'unrelated', reasoning: 'default' } as unknown as T;
  },
};

function candidate(o: Partial<FactCandidate> & { statement: string }): FactCandidate {
  return {
    fact_type: o.fact_type ?? 'decisao',
    statement: o.statement,
    attributes: o.attributes ?? {},
    turn_start: o.turn_start ?? 0,
    turn_end: o.turn_end ?? 1,
    confidence: o.confidence ?? 0.9,
    ...(o.valid_at_hint ? { valid_at_hint: o.valid_at_hint } : {}),
  };
}

/** Stage deps com um extrator que devolve 1 fato (decisao) por episodio. */
function stageDeps(facts: FactCandidate[] = [candidate({ statement: 'verba mensal e 8000' })]): StageBDeps {
  return { llmClient: makeFakeExtractor(facts), embeddingClient: fakeEmbeddingClient, judge: fakeJudge };
}

/** Narradora fake: registra calls (prova de invocacao no estagio C). */
function fakeNarrator(): LlmClient & { calls: number } {
  const obj = {
    model: 'fake-narrator',
    calls: 0,
    async complete<T = unknown>(_args: LlmCompletionArgs): Promise<T> {
      obj.calls++;
      return { content_md: 'texto', rules: [] } as unknown as T;
    },
  };
  return obj;
}

/** Portao fake: conta chamadas e devolve um id (proveniencia da conduta). */
function fakeGate(): CreateApprovalTask & { calls: number } {
  const fn = (async (_args) => {
    (fn as { calls: number }).calls++;
    return { id: 'task-1' };
  }) as CreateApprovalTask & { calls: number };
  fn.calls = 0;
  return fn;
}

// ── Seed helpers ────────────────────────────────────────────────────────────

async function seedEpisode(args: {
  externalId: string;
  workspaceId: string | null;
  occurredAt?: string;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, $3, $4, 1)
     RETURNING id`,
    [args.externalId, `ep ${args.externalId}`, args.occurredAt ?? '2026-06-16T10:00:00Z', args.workspaceId]
  );
  return Number(rows[0]!.id);
}

async function seedTurns(episodeId: number): Promise<void> {
  await pool.query(
    `INSERT INTO episode_turns (episode_id, turn_index, speaker_name, speaker_label, text)
     VALUES ($1, 0, 'Ana', NULL, 'A verba do mes que vem sobe pra 8k reais.'),
            ($1, 1, 'Gustavo', NULL, 'Combinado, fecho com 8k entao.')`,
    [episodeId]
  );
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE lua_processing, lua_runs, episode_chunks, facts,
              condutas, conduta_rules, conduta_rule_sources,
              recaps, recap_sources, project_status, project_status_sources,
              episodes, episode_turns
     RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

async function countRuns(kind = 'nightly'): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM lua_runs WHERE kind = $1`,
    [kind]
  );
  return Number(rows[0]!.n);
}

// ── LUA_ENABLED parse estrito (safety-critical) ─────────────────────────────

test('LUA_ENABLED: parse estrito — string "false" vira boolean false', () => {
  const schema = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
  assert.equal(schema.parse('false'), false, '"false" DEVE virar false (z.coerce.boolean coagiria para true)');
  assert.equal(schema.parse('true'), true);
  assert.equal(schema.parse(undefined), false, 'ausente => false (default)');
});

// ── Gate desligado ──────────────────────────────────────────────────────────

test('tick com enabled:false e no-op (nenhum run criado)', async () => {
  await seedEpisode({ externalId: 'e1', workspaceId: 'w1' });
  const r = await runNightlyTick({ enabled: false, now: () => new Date(TUE_IN), stage: stageDeps() });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(await countRuns(), 0);
});

// ── Janela ──────────────────────────────────────────────────────────────────

test('fora da janela (12:00 local) => no-op, sem run', async () => {
  await seedEpisode({ externalId: 'e1', workspaceId: 'w1' });
  const r = await runNightlyTick({ enabled: true, now: () => new Date(TUE_OUT), stage: stageDeps() });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'outside_window');
  assert.equal(await countRuns(), 0);
});

test('dentro da janela (03:00 local) => reivindica a noite e processa episodios', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1' });
  await seedTurns(ep);
  const narrator = fakeNarrator();

  const r = await runNightlyTick({
    enabled: true,
    now: () => new Date(TUE_IN),
    stage: stageDeps(),
    recapLlm: narrator,
    createApprovalTask: fakeGate(),
  });

  assert.equal(r.ran, true);
  assert.ok(typeof r.runId === 'number');
  assert.equal(r.processed, 1, '1 episodio processado');
  assert.equal(await countRuns(), 1, '1 run nightly criado');

  // episodio concluido como done; fato inserido
  const { rows: proc } = await pool.query(`SELECT status FROM lua_processing`);
  assert.equal(proc.length, 1);
  assert.equal(proc[0]!.status, 'done');
  const { rows: facts } = await pool.query(`SELECT count(*)::int AS n FROM facts WHERE workspace_id='w1'`);
  assert.ok(facts[0]!.n >= 1, 'pelo menos 1 fato extraido');

  // run finalizado com stats
  const { rows: run } = await pool.query<{ status: string; stats: Record<string, unknown> }>(
    `SELECT status, stats FROM lua_runs WHERE id = $1`,
    [r.runId]
  );
  assert.equal(run[0]!.status, 'done');
  assert.equal(run[0]!.stats.episodes_processed, 1);
  assert.equal(run[0]!.stats.backlog, 0, 'sem backlog ao fim');
  assert.ok('duration_ms' in run[0]!.stats);
});

// ── claimNight idempotente (INSERT ON CONFLICT) ─────────────────────────────

test('dois ticks na mesma noite => apenas 1 run nightly (claim por INSERT ON CONFLICT)', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1' });
  await seedTurns(ep);

  const first = await runNightlyTick({ enabled: true, now: () => new Date(TUE_IN), stage: stageDeps(), recapLlm: fakeNarrator(), createApprovalTask: fakeGate() });
  assert.equal(first.ran, true);

  const second = await runNightlyTick({ enabled: true, now: () => new Date(TUE_IN), stage: stageDeps(), recapLlm: fakeNarrator(), createApprovalTask: fakeGate() });
  assert.equal(second.ran, false, '2o tick na mesma noite nao roda');
  assert.equal(second.reason, 'already_claimed');
  assert.equal(await countRuns(), 1, 'continua 1 run nightly');
});

// ── Hard stop no fim da janela ──────────────────────────────────────────────

test('hard stop: relogio passa do fim da janela apos o 1o episodio => restante fica pending', async () => {
  // 3 episodios elegiveis. O clock fica DENTRO da janela ate o 1o drainQueue
  // check, depois "salta" para FORA — o worker para e os demais ficam pending.
  for (const id of ['a', 'b', 'c']) {
    const ep = await seedEpisode({ externalId: id, workspaceId: 'w1', occurredAt: `2026-06-1${id === 'a' ? 4 : id === 'b' ? 5 : 6}T10:00:00Z` });
    await seedTurns(ep);
  }

  // Clock: as 2 primeiras leituras (claim da noite + 1a checagem do worker) dentro;
  // a partir da 3a leitura, fora da janela => worker para antes do 2o claim.
  let calls = 0;
  const now = (): Date => {
    calls++;
    return new Date(calls <= 2 ? TUE_IN : TUE_OUT);
  };

  const r = await runNightlyTick({
    enabled: true,
    now,
    stage: stageDeps(),
    recapLlm: fakeNarrator(),
    createApprovalTask: fakeGate(),
  });

  assert.equal(r.ran, true);
  assert.ok((r.processed ?? 0) >= 1, 'ao menos 1 processado antes do hard stop');
  assert.ok((r.processed ?? 0) < 3, 'NEM TODOS processados (hard stop)');
  assert.ok((r.backlog ?? 0) > 0, 'backlog remanescente (tripwire §12)');

  const { rows } = await pool.query<{ status: string; n: string }>(
    `SELECT status, count(*) AS n FROM lua_processing GROUP BY status`
  );
  const pending = rows.find((x) => x.status === 'pending');
  assert.ok(pending && Number(pending.n) >= 1, 'pelo menos 1 episodio ficou pending pra proxima noite');
});

// ── Estagio C: status nightly ───────────────────────────────────────────────

test('estagio C: gera status nightly para workspace com mudanca de memoria', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1' });
  await seedTurns(ep);
  const narrator = fakeNarrator();

  const r = await runNightlyTick({
    enabled: true,
    now: () => new Date(TUE_IN), // terca: status sim, recap/conduta NAO
    stage: stageDeps(),
    recapLlm: narrator,
    createApprovalTask: fakeGate(),
  });

  assert.equal(r.ran, true);
  assert.ok((r.statuses ?? 0) >= 1, 'status gerado para w1');

  const { rows } = await pool.query(`SELECT workspace_id FROM project_status WHERE workspace_id = 'w1'`);
  assert.equal(rows.length, 1, 'uma linha de project_status para w1');
  assert.ok(narrator.calls >= 1, 'narradora chamada para o status');
});

// ── Estagio C: domingo->segunda (recap + conduta) ───────────────────────────

test('estagio C numa noite de segunda: recap + proposta de conduta sao invocados', async () => {
  // Episodio dentro da semana ISO anterior a 2026-06-15 (segunda). A semana
  // anterior e 2026-06-08..2026-06-14. Episodio em 09/06 conta como atividade.
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', occurredAt: '2026-06-09T10:00:00Z' });
  await seedTurns(ep);
  const narrator = fakeNarrator();
  const gate = fakeGate();

  const r = await runNightlyTick({
    enabled: true,
    now: () => new Date(MON_IN), // SEGUNDA 03:00 SP => dispara recap + conduta
    stage: stageDeps([candidate({ fact_type: 'preferencia', statement: 'cliente prefere Reels' })]),
    recapLlm: narrator,
    createApprovalTask: gate,
  });

  assert.equal(r.ran, true);
  assert.ok((r.recaps ?? 0) >= 1, 'recap gerado na noite de segunda');
  assert.ok((r.condutas ?? 0) >= 1, 'proposta de conduta gerada na noite de segunda');

  const { rows: recap } = await pool.query(`SELECT count(*)::int AS n FROM recaps WHERE workspace_id='w1'`);
  assert.equal(recap[0]!.n, 1);
  const { rows: cond } = await pool.query(`SELECT count(*)::int AS n FROM condutas WHERE workspace_id='w1' AND status='proposed'`);
  assert.equal(cond[0]!.n, 1);
  assert.ok(gate.calls >= 1, 'portao Bloquim chamado para a conduta');
});

test('estagio C numa noite de terca: NAO gera recap nem conduta', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', occurredAt: '2026-06-16T10:00:00Z' });
  await seedTurns(ep);

  const r = await runNightlyTick({
    enabled: true,
    now: () => new Date(TUE_IN), // terca
    stage: stageDeps([candidate({ fact_type: 'preferencia', statement: 'cliente prefere Reels' })]),
    recapLlm: fakeNarrator(),
    createApprovalTask: fakeGate(),
  });

  assert.equal(r.recaps ?? 0, 0, 'sem recap fora da noite de segunda');
  assert.equal(r.condutas ?? 0, 0, 'sem conduta fora da noite de segunda');
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM recaps`);
  assert.equal(rows[0]!.n, 0);
});

// ── localTimeInSaoPaulo (helper de fuso explicito) ──────────────────────────

test('localTimeInSaoPaulo: converte UTC para hora/dia/data SP sem depender da TZ do processo', () => {
  const t = localTimeInSaoPaulo(new Date(MON_IN));
  assert.equal(t.hour, 3, '06:00 UTC => 03:00 SP');
  assert.equal(t.isoWeekday, 1, 'segunda');
  assert.equal(t.date, '2026-06-15');

  const out = localTimeInSaoPaulo(new Date(TUE_OUT));
  assert.equal(out.hour, 12);
  assert.equal(out.isoWeekday, 2, 'terca');
});
