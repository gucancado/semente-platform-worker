// Testes do harness de eval da Lua (eval/lua/harness.ts) — SEM rede, SEM DB.
//
// Cobre: loadGolden (parse JSONL + erro claro de arquivo ausente), matchFacts
// (tipo/janela/judge), computeMetrics (precisão/recall/alucinação/small talk),
// evaluateGate (pass acima dos thresholds, fail por gate, gate por tipo) e
// assertDistinctModels. Tudo com golden temp + extrator/judge fakes roteirizados.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadGolden,
  matchFacts,
  computeMetrics,
  evaluateGate,
  evaluateEntry,
  assertDistinctModels,
  turnsIntersect,
  DEFAULT_THRESHOLDS,
  type GoldenEntry,
  type Trecho,
  type JudgeClient,
  type MatchVerdict,
  type GroundingVerdict,
  type EntryResult,
  type SupersedePair,
} from '../../eval/lua/harness.js';
import type { FactCandidate } from '../../src/lua/extract.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'lua-eval-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeGolden(name: string, entries: object[]): string {
  const path = join(tmp, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return path;
}

function fact(over: Partial<FactCandidate> = {}): FactCandidate {
  return {
    fact_type: 'decisao',
    statement: 'A verba mensal e R$ 8.000',
    attributes: {},
    turn_start: 30,
    turn_end: 35,
    confidence: 0.9,
    ...over,
  };
}

function trecho(over: Partial<Trecho> = {}): Trecho {
  return {
    episode_id: 57,
    turn_start: 30,
    turn_end: 72,
    workspace_id: 'wks_1',
    transcript: [{ turn_index: 30, speaker: 'Ana', text: 'verba e 8 mil' }],
    ...over,
  };
}

/**
 * Judge fake roteirizado por funções de decisão. Cada método consulta um
 * roteiro injetado; default = match positivo + grounded + ambiguous.
 */
function makeFakeJudge(opts: {
  model?: string;
  match?: (e: { expected: { gist: string }; extracted: FactCandidate }) => MatchVerdict;
  grounding?: (ext: FactCandidate) => GroundingVerdict;
  supersede?: (a: { statement: string }, b: { statement: string }) =>
    'a_supersedes_b' | 'b_supersedes_a' | 'ambiguous';
}): JudgeClient {
  return {
    model: opts.model ?? 'judge-distinto',
    async judgeMatch(args) {
      return opts.match
        ? opts.match(args)
        : { match: true, key_values_present: true };
    },
    async judgeGrounding(args) {
      return opts.grounding ? opts.grounding(args.extracted) : { grounded: true };
    },
    async judgeSupersede(args) {
      return {
        direction: opts.supersede
          ? opts.supersede(args.a, args.b)
          : 'ambiguous',
      };
    },
  };
}

// ── loadGolden ────────────────────────────────────────────────────────────────

test('loadGolden parseia JSONL com normal, small talk e injection', () => {
  const path = writeGolden('g1.jsonl', [
    {
      id: 'g-001',
      episode_id: 57,
      turn_start: 30,
      turn_end: 72,
      expected_facts: [{ fact_type: 'decisao', key_values: ['verba', '8000'], gist: 'verba 8k' }],
      forbidden: ['orcamento de 2025'],
    },
    { id: 'g-002', episode_id: 60, turn_start: 0, turn_end: 8, expected_facts: [] },
    {
      id: 'g-003',
      episode_id: 61,
      turn_start: 5,
      turn_end: 9,
      expected_facts: [],
      injection: true,
    },
  ]);
  const golden = loadGolden(path);
  assert.equal(golden.length, 3);
  assert.equal(golden[0]!.expected_facts[0]!.key_values.length, 2);
  assert.equal(golden[1]!.expected_facts.length, 0);
  assert.equal(golden[2]!.injection, true);
});

test('loadGolden lanca erro claro quando arquivo ausente', () => {
  assert.throws(
    () => loadGolden(join(tmp, 'nao-existe.jsonl')),
    /golden set nao encontrado/,
  );
});

test('loadGolden lanca em campo obrigatorio ausente', () => {
  const path = writeGolden('g-bad.jsonl', [{ id: 'x', turn_start: 0, turn_end: 1, expected_facts: [] }]);
  assert.throws(() => loadGolden(path), /episode_id/);
});

// ── turnsIntersect ───────────────────────────────────────────────────────────

test('turnsIntersect detecta sobreposicao e disjuncao', () => {
  assert.equal(turnsIntersect({ turn_start: 0, turn_end: 5 }, { turn_start: 3, turn_end: 9 }), true);
  assert.equal(turnsIntersect({ turn_start: 0, turn_end: 5 }, { turn_start: 6, turn_end: 9 }), false);
});

// ── matchFacts ────────────────────────────────────────────────────────────────

test('matchFacts: extracao correta casa o esperado', async () => {
  const judge = makeFakeJudge({});
  const expected = [{ fact_type: 'decisao' as const, key_values: ['verba'], gist: 'verba' }];
  const r = await matchFacts([fact()], expected, trecho(), { judge });
  assert.equal(r.expectedFound[0], true);
  assert.ok(r.matchedExtractedIdx.has(0));
});

test('matchFacts: tipo errado nao casa', async () => {
  const judge = makeFakeJudge({});
  const expected = [{ fact_type: 'decisao' as const, key_values: ['verba'], gist: 'verba' }];
  const r = await matchFacts([fact({ fact_type: 'preferencia' })], expected, trecho(), { judge });
  assert.equal(r.expectedFound[0], false);
  assert.equal(r.matchedExtractedIdx.size, 0);
});

test('matchFacts: janela de turnos disjunta nao casa', async () => {
  const judge = makeFakeJudge({});
  const expected = [{ fact_type: 'decisao' as const, key_values: ['verba'], gist: 'verba' }];
  // trecho 30..72; fato em 100..105 nao intersecta.
  const r = await matchFacts([fact({ turn_start: 100, turn_end: 105 })], expected, trecho(), { judge });
  assert.equal(r.expectedFound[0], false);
});

test('matchFacts: judge nega key_values -> nao casa', async () => {
  const judge = makeFakeJudge({ match: () => ({ match: true, key_values_present: false }) });
  const expected = [{ fact_type: 'decisao' as const, key_values: ['verba'], gist: 'verba' }];
  const r = await matchFacts([fact()], expected, trecho(), { judge });
  assert.equal(r.expectedFound[0], false);
});

// ── computeMetrics ────────────────────────────────────────────────────────────

test('computeMetrics: precisao e recall numericos corretos', async () => {
  const judge = makeFakeJudge({
    // casa so quando o esperado E o extraido falam de "verba" (statement casa gist)
    match: ({ expected, extracted }) => {
      const ok = expected.gist.includes('verba') && extracted.statement.includes('verba');
      return { match: ok, key_values_present: ok };
    },
  });
  // 1 trecho: 2 esperados (verba [casavel], reels [nao casavel]); 2 extraidos
  // (1 verba correto, 1 espurio que nao casa nada).
  const entry: GoldenEntry = {
    id: 'g-001',
    episode_id: 57,
    turn_start: 30,
    turn_end: 72,
    expected_facts: [
      { fact_type: 'decisao', key_values: ['verba'], gist: 'verba 8k' },
      { fact_type: 'decisao', key_values: ['reels'], gist: 'foco reels' },
    ],
  };
  const extracted = [
    fact({ statement: 'verba 8k' }),
    fact({ statement: 'fato espurio' }),
  ];
  const match = await matchFacts(extracted, entry.expected_facts, trecho(), { judge });
  const results: EntryResult[] = [{ entry, extracted, match, grounded: [true, true] }];
  const m = computeMetrics(results);
  // 1 correto de 2 extraidos => 0.5
  assert.equal(m.precision, 0.5);
  // 1 achado de 2 esperados => 0.5
  assert.equal(m.recall, 0.5);
  assert.equal(m.perType.decisao!.extractedTotal, 2);
  assert.equal(m.perType.decisao!.expectedTotal, 2);
});

test('computeMetrics: alucinacao conta extraido sem grounding', () => {
  const entry: GoldenEntry = {
    id: 'g', episode_id: 1, turn_start: 0, turn_end: 9,
    expected_facts: [{ fact_type: 'decisao', key_values: [], gist: 'x' }],
  };
  const extracted = [fact(), fact()];
  // ambos casam o unico esperado (idx 0 e 1), mas o 2o nao tem grounding.
  const results: EntryResult[] = [
    {
      entry,
      extracted,
      match: { expectedFound: [true], matchedExtractedIdx: new Set([0, 1]) },
      grounded: [true, false],
    },
  ];
  const m = computeMetrics(results);
  assert.equal(m.hallucination, 1);
});

test('computeMetrics: falso-fato em small talk conta todo extraido de trecho vazio', () => {
  const entry: GoldenEntry = {
    id: 'g', episode_id: 1, turn_start: 0, turn_end: 9, expected_facts: [],
  };
  const extracted = [fact(), fact()];
  const results: EntryResult[] = [
    { entry, extracted, match: { expectedFound: [], matchedExtractedIdx: new Set() }, grounded: [true, true] },
  ];
  const m = computeMetrics(results);
  assert.equal(m.falseFactOnSmalltalk, 2);
  // small talk => nenhum extraido e "correto" => precisao 0
  assert.equal(m.precision, 0);
});

test('computeMetrics: injection conta statement-comando sem needs_review', () => {
  const entry: GoldenEntry = {
    id: 'g', episode_id: 1, turn_start: 0, turn_end: 9, expected_facts: [], injection: true,
  };
  // fato extraido SEM needs_review => o comando escapou.
  const results: EntryResult[] = [
    {
      entry,
      extracted: [fact({ attributes: {} })],
      match: { expectedFound: [], matchedExtractedIdx: new Set() },
      grounded: [true],
    },
  ];
  const m = computeMetrics(results);
  assert.equal(m.injection, 1);

  // mesmo trecho, mas o extrator FLAGOU => nao conta.
  const flagged: EntryResult[] = [
    {
      entry,
      extracted: [fact({ attributes: { needs_review: true } })],
      match: { expectedFound: [], matchedExtractedIdx: new Set() },
      grounded: [true],
    },
  ];
  assert.equal(computeMetrics(flagged).injection, 0);
});

test('computeMetrics: supersede conta direcao correta', () => {
  const pairs: { pair: SupersedePair; got: { direction: 'a_supersedes_b' | 'b_supersedes_a' | 'ambiguous' } }[] = [
    { pair: { a: { statement: 'a', valid_at: '2026-01-01' }, b: { statement: 'b', valid_at: '2026-02-01' }, expected: 'b_supersedes_a' }, got: { direction: 'b_supersedes_a' } },
    { pair: { a: { statement: 'a', valid_at: '2026-03-01' }, b: { statement: 'b', valid_at: '2026-02-01' }, expected: 'a_supersedes_b' }, got: { direction: 'ambiguous' } },
  ];
  const m = computeMetrics([], pairs);
  assert.equal(m.supersede.correct, 1);
  assert.equal(m.supersede.total, 2);
});

// ── evaluateGate ──────────────────────────────────────────────────────────────

function metricsAbove() {
  // metricas que passam todos os gates default
  const entry: GoldenEntry = {
    id: 'g', episode_id: 1, turn_start: 0, turn_end: 9,
    expected_facts: [
      { fact_type: 'decisao', key_values: [], gist: 'x' },
      { fact_type: 'compromisso', key_values: [], gist: 'y' },
    ],
  };
  const results: EntryResult[] = [
    {
      entry,
      extracted: [fact({ fact_type: 'decisao' }), fact({ fact_type: 'compromisso' })],
      match: { expectedFound: [true, true], matchedExtractedIdx: new Set([0, 1]) },
      grounded: [true, true],
    },
  ];
  const supersede = Array.from({ length: 10 }, (_, i) => ({
    pair: { a: { statement: 'a', valid_at: '2026-01-01' }, b: { statement: 'b', valid_at: '2026-02-01' }, expected: 'b_supersedes_a' as const },
    got: { direction: (i < 10 ? 'b_supersedes_a' : 'ambiguous') as 'b_supersedes_a' },
  }));
  return computeMetrics(results, supersede);
}

test('evaluateGate: metricas acima dos thresholds => PASS', () => {
  const gate = evaluateGate(metricsAbove());
  assert.equal(gate.pass, true, JSON.stringify(gate.checks.filter((c) => !c.pass)));
});

test('evaluateGate: precisao global abaixo => FAIL no gate certo', () => {
  const m = metricsAbove();
  m.precision = 0.5; // abaixo de 0.85
  const gate = evaluateGate(m);
  assert.equal(gate.pass, false);
  const c = gate.checks.find((x) => x.name === 'precisao_global')!;
  assert.equal(c.pass, false);
});

test('evaluateGate: alucinacao > 0 reprova', () => {
  const m = metricsAbove();
  m.hallucination = 1;
  const gate = evaluateGate(m);
  assert.equal(gate.pass, false);
  assert.equal(gate.checks.find((x) => x.name === 'alucinacao')!.pass, false);
});

test('evaluateGate: precisao por tipo abaixo reprova mesmo com global ok', () => {
  const m = metricsAbove();
  // injeta um tipo com precisao 0.5 (< 0.75 por tipo) sem derrubar a global.
  m.perType.papel = {
    precision: 0.5, recall: 1, extractedCorrect: 1, extractedTotal: 2, expectedFound: 1, expectedTotal: 1,
  };
  const gate = evaluateGate(m);
  assert.equal(gate.pass, false);
  assert.equal(gate.checks.find((x) => x.name === 'precisao_tipo:papel')!.pass, false);
});

test('evaluateGate: thresholds sao ajustaveis (override afrouxa o gate)', () => {
  const m = metricsAbove();
  m.precision = 0.5;
  // com override pra 0.4, o gate global passa.
  const gate = evaluateGate(m, { precisionGlobal: 0.4 });
  assert.equal(gate.checks.find((x) => x.name === 'precisao_global')!.pass, true);
});

test('DEFAULT_THRESHOLDS espelha a tabela da spec §11.2', () => {
  assert.equal(DEFAULT_THRESHOLDS.precisionGlobal, 0.85);
  assert.equal(DEFAULT_THRESHOLDS.precisionPerType, 0.75);
  assert.equal(DEFAULT_THRESHOLDS.recallGlobal, 0.75);
  assert.equal(DEFAULT_THRESHOLDS.hallucinationMax, 0);
  assert.equal(DEFAULT_THRESHOLDS.falseSmalltalkMax, 0);
  assert.equal(DEFAULT_THRESHOLDS.supersedeMinCorrect, 9);
  assert.equal(DEFAULT_THRESHOLDS.injectionMax, 0);
});

// ── assertDistinctModels ──────────────────────────────────────────────────────

test('assertDistinctModels: mesmo modelo lanca, distintos passam', () => {
  assert.throws(() => assertDistinctModels('claude-sonnet-4-6', 'claude-sonnet-4-6'), /modelos distintos/);
  assert.doesNotThrow(() => assertDistinctModels('claude-sonnet-4-6', 'claude-opus-4-8'));
});

// ── evaluateEntry (integra extract + match + grounding via fakes) ──────────────

test('evaluateEntry: extrai, casa e marca grounding via deps injetadas', async () => {
  const entry: GoldenEntry = {
    id: 'g-001', episode_id: 57, turn_start: 30, turn_end: 72,
    expected_facts: [{ fact_type: 'decisao', key_values: ['verba'], gist: 'verba' }],
  };
  const r = await evaluateEntry(entry, {
    loadTrecho: async () => trecho(),
    extract: async () => [fact()],
    judge: makeFakeJudge({}),
  });
  assert.equal(r.extracted.length, 1);
  assert.equal(r.match.expectedFound[0], true);
  assert.deepEqual(r.grounded, [true]);
});
