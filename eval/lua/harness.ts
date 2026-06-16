// Harness de eval da extração da Lua — NÚCLEO TESTÁVEL (spec Lua v1 §11.2).
//
// Este módulo é o coração do GATE DE PRODUÇÃO: roda a extração real sobre cada
// trecho do golden set (curadoria humana, eval/lua/golden.jsonl), casa o
// extraído × o esperado via um JUDGE de MODELO DISTINTO do extrator (spec §11.2),
// computa as métricas por tipo + globais e decide pass/fail contra os thresholds.
//
// Princípios de testabilidade (decisão da spec §15.3):
//  - SEM process.exit, SEM argv, SEM I/O de console aqui (isso vive em run.ts).
//  - SEM import de config.ts / db.ts (que abrem pool e exigem DATABASE_URL): o
//    núcleo recebe extrator, judge e carregador de trecho INJETADOS por parâmetro.
//    Assim os testes passam fakes roteirizados e nunca tocam rede nem banco.
//  - O carregamento do golden (JSONL) é puro filesystem — testável com arquivo temp.
//
// A separação extrator/judge é deliberada (spec §11.2): "casa extraído × esperado
// via LLM-judge com modelo DISTINTO do extrator". run.ts constrói o judge com um
// modelo diferente do extrator; este núcleo só exige a interface `JudgeClient` e
// não sabe qual modelo é — a garantia de distinção é responsabilidade de quem o
// monta (run.ts) e é verificada em runtime (assertDistinctModels abaixo).

import { readFileSync } from 'node:fs';
import type { FactCandidate, FactType } from '../../src/lua/extract.js';

// ── Golden set ───────────────────────────────────────────────────────────────

/** Um fato esperado num trecho (anotação humana, spec §11.1). */
export interface ExpectedFact {
  fact_type: FactType;
  /** Valores-chave que o fato DEVE conter (julgados por presença semântica). */
  key_values: string[];
  /** Resumo em PT-BR do fato esperado (contexto pro judge). */
  gist: string;
}

/** Uma entrada do golden set: referência a um trecho + o que se espera dele. */
export interface GoldenEntry {
  id: string;
  episode_id: number;
  turn_start: number;
  turn_end: number;
  /** Fatos que a extração DEVE produzir. Vazio => trecho de small talk (§11.1). */
  expected_facts: ExpectedFact[];
  /** Coisas que NÃO devem aparecer (texto livre, contexto pro judge de alucinação). */
  forbidden?: string[];
  /**
   * Opcional: marca o trecho como contendo uma instrução imperativa dirigida a
   * agente (caso de injection, §11.1/§6.5). Quando true, a métrica de injection
   * verifica que nenhum statement-comando passou SEM needs_review.
   */
  injection?: boolean;
}

const GOLDEN_MISSING_MSG =
  'golden set nao encontrado — anote eval/lua/golden.jsonl (ver spec 11.1)';

/**
 * Carrega o golden set de um arquivo JSONL (1 GoldenEntry por linha).
 * Arquivo ausente => lança erro claro (run.ts captura e imprime a orientação).
 * Linhas vazias são ignoradas; linha malformada lança erro apontando o número.
 */
export function loadGolden(path: string): GoldenEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(GOLDEN_MISSING_MSG);
    }
    throw err;
  }
  const out: GoldenEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `golden.jsonl linha ${i + 1} invalida (JSON): ${(err as Error).message}`,
      );
    }
    out.push(normalizeEntry(parsed, i + 1));
  }
  if (out.length === 0) throw new Error(GOLDEN_MISSING_MSG);
  return out;
}

function normalizeEntry(o: unknown, lineNo: number): GoldenEntry {
  const e = o as Record<string, unknown>;
  const need = (k: string): unknown => {
    if (e[k] === undefined || e[k] === null) {
      throw new Error(`golden.jsonl linha ${lineNo}: campo '${k}' ausente`);
    }
    return e[k];
  };
  return {
    id: String(need('id')),
    episode_id: Number(need('episode_id')),
    turn_start: Number(need('turn_start')),
    turn_end: Number(need('turn_end')),
    expected_facts: ((need('expected_facts') as unknown[]) ?? []).map((f) => {
      const ff = f as Record<string, unknown>;
      return {
        fact_type: String(ff.fact_type) as FactType,
        key_values: (ff.key_values as unknown[] | undefined)?.map(String) ?? [],
        gist: String(ff.gist ?? ''),
      };
    }),
    forbidden: (e.forbidden as unknown[] | undefined)?.map(String),
    injection: e.injection === true,
  };
}

// ── O trecho real (carregado do banco por run.ts; injetado no harness) ────────

/** Texto+turnos de um trecho, no formato que extractFacts consome. */
export interface Trecho {
  episode_id: number;
  turn_start: number;
  turn_end: number;
  title?: string;
  occurred_at?: string;
  participants?: string[];
  workspace_id: string;
  transcript: { turn_index: number; speaker: string; text: string }[];
}

// ── Judge (modelo DISTINTO do extrator — spec §11.2) ──────────────────────────

/** Veredicto do judge sobre um par (fato esperado × fato extraído). */
export interface MatchVerdict {
  /** O extraído satisfaz o esperado? (tipo certo já é pré-condição de código.) */
  match: boolean;
  /** Os key_values do esperado estão semanticamente presentes no extraído? */
  key_values_present: boolean;
}

/** Veredicto do judge sobre grounding de um fato extraído no texto do trecho. */
export interface GroundingVerdict {
  /** O statement está ancorado em algo realmente dito no trecho? */
  grounded: boolean;
}

/** Veredicto do judge sobre direção de um par sintético de supersede. */
export interface SupersedeVerdict {
  /** 'a_supersedes_b' | 'b_supersedes_a' | 'ambiguous' */
  direction: 'a_supersedes_b' | 'b_supersedes_a' | 'ambiguous';
}

/**
 * Judge injetável: um modelo DISTINTO do extrator (spec §11.2). Cada método é
 * uma chamada de julgamento; nos testes é roteirizado, em run.ts é Anthropic
 * (Opus/Haiku, ver makeLlmJudge). O harness NÃO conhece o modelo — só a interface.
 */
export interface JudgeClient {
  /** Identificador do modelo do judge (usado por assertDistinctModels). */
  model: string;
  /** Decide se um fato extraído satisfaz um fato esperado (+ key_values). */
  judgeMatch(args: {
    expected: ExpectedFact;
    extracted: FactCandidate;
    trecho: Trecho;
  }): Promise<MatchVerdict>;
  /** Decide se um fato extraído está ancorado no texto do trecho. */
  judgeGrounding(args: {
    extracted: FactCandidate;
    trecho: Trecho;
  }): Promise<GroundingVerdict>;
  /** Decide a direção temporal de um par sintético de supersede. */
  judgeSupersede(args: {
    a: { statement: string; valid_at: string };
    b: { statement: string; valid_at: string };
  }): Promise<SupersedeVerdict>;
}

/**
 * Garante que extrator e judge são modelos DIFERENTES (spec §11.2: "modelo
 * distinto do extrator"). Lança se forem iguais — o eval seria circular (o
 * extrator avaliando a si mesmo) e o gate, sem valor.
 */
export function assertDistinctModels(extractorModel: string, judgeModel: string): void {
  if (extractorModel === judgeModel) {
    throw new Error(
      `judge e extrator usam o MESMO modelo (${extractorModel}); spec §11.2 exige modelos distintos`,
    );
  }
}

// ── Casamento (match) extraído × esperado ─────────────────────────────────────

/**
 * Um fato extraído CASA um esperado quando (spec §11.2):
 *   1. fact_type IGUAL (pré-condição de código, barata e literal), E
 *   2. a janela de turnos do extraído INTERSECTA a janela do esperado, E
 *   3. o judge confirma o match + presença semântica dos key_values.
 *
 * O passo 3 é por LLM-judge (modelo distinto) — não substring crua — porque
 * "verba 8000" pode aparecer como "oito mil reais" no statement (spec §11.2:
 * "presença semântica, não substring raw").
 */
export function turnsIntersect(
  a: { turn_start: number; turn_end: number },
  b: { turn_start: number; turn_end: number },
): boolean {
  return a.turn_start <= b.turn_end && b.turn_start <= a.turn_end;
}

/**
 * Casa os fatos extraídos de UM trecho contra os esperados. Retorna, por fato
 * esperado, se foi encontrado (>=1 extraído casa) e quais extraídos casaram, e a
 * lista de extraídos que NÃO casaram nenhum esperado (candidatos a falso-positivo
 * — entram no cálculo de precisão como "extraído incorreto" salvo prova em
 * contrário pela métrica de grounding).
 */
export interface MatchResult {
  /** Por índice do esperado: foi coberto por algum extraído? */
  expectedFound: boolean[];
  /** Índices dos extraídos que casaram ALGUM esperado (corretos). */
  matchedExtractedIdx: Set<number>;
}

export async function matchFacts(
  extracted: FactCandidate[],
  expected: ExpectedFact[],
  trecho: Trecho,
  deps: { judge: JudgeClient },
): Promise<MatchResult> {
  const expectedFound = new Array(expected.length).fill(false);
  const matchedExtractedIdx = new Set<number>();

  for (let ei = 0; ei < expected.length; ei++) {
    const exp = expected[ei]!;
    for (let xi = 0; xi < extracted.length; xi++) {
      const ext = extracted[xi]!;
      // (1) janelas intersectam — filtro de código barato; o judge decide a
      // materia, tipo pode diferir.
      if (
        !turnsIntersect(
          { turn_start: ext.turn_start, turn_end: ext.turn_end },
          { turn_start: trecho.turn_start, turn_end: trecho.turn_end },
        )
      ) {
        continue;
      }
      // (3) judge confirma match + key_values presentes.
      const v = await deps.judge.judgeMatch({ expected: exp, extracted: ext, trecho });
      if (v.match && v.key_values_present) {
        expectedFound[ei] = true;
        matchedExtractedIdx.add(xi);
      }
    }
  }
  return { expectedFound, matchedExtractedIdx };
}

// ── Resultado por trecho (insumo das métricas) ────────────────────────────────

/** Resultado de rodar a extração + casamento sobre UM trecho do golden. */
export interface EntryResult {
  entry: GoldenEntry;
  extracted: FactCandidate[];
  match: MatchResult;
  /** Por índice do extraído: está ancorado no texto? (judge de grounding.) */
  grounded: boolean[];
}

/**
 * Roda a extração real sobre um trecho e casa contra o esperado, produzindo o
 * EntryResult. O extrator (`extract`) e o judge vêm injetados — run.ts passa os
 * reais; os testes passam fakes. `loadTrecho` resolve a entrada do golden em
 * texto (DB) — também injetado, pra manter o núcleo sem banco.
 */
export async function evaluateEntry(
  entry: GoldenEntry,
  deps: {
    extract: (trecho: Trecho) => Promise<FactCandidate[]>;
    judge: JudgeClient;
    loadTrecho: (entry: GoldenEntry) => Promise<Trecho>;
  },
): Promise<EntryResult> {
  const trecho = await deps.loadTrecho(entry);
  const extracted = await deps.extract(trecho);
  const match = await matchFacts(extracted, entry.expected_facts, trecho, {
    judge: deps.judge,
  });
  // Grounding: cada extraído precisa estar ancorado no trecho (anti-alucinação).
  const grounded: boolean[] = [];
  for (const ext of extracted) {
    const g = await deps.judge.judgeGrounding({ extracted: ext, trecho });
    grounded.push(g.grounded);
  }
  return { entry, extracted, match, grounded };
}

// ── Par sintético de supersede (spec §11.2: 10 pares) ─────────────────────────

/** Um par sintético pra testar a direção do supersede. */
export interface SupersedePair {
  a: { statement: string; valid_at: string };
  b: { statement: string; valid_at: string };
  /** Direção esperada (gabarito humano). */
  expected: 'a_supersedes_b' | 'b_supersedes_a' | 'ambiguous';
}

// ── Métricas (spec §11.2) ─────────────────────────────────────────────────────

/** Precisão/recall por tipo de fato. */
export interface PerTypeMetric {
  /** Extraídos corretos / extraídos (deste tipo). null se nenhum extraído. */
  precision: number | null;
  /** Esperados encontrados / esperados (deste tipo). null se nenhum esperado. */
  recall: number | null;
  extractedCorrect: number;
  extractedTotal: number;
  expectedFound: number;
  expectedTotal: number;
}

export interface Metrics {
  /** Precisão global = corretos / extraídos (spec §11.2). */
  precision: number | null;
  /** Recall/cobertura global = encontrados / esperados. */
  recall: number | null;
  /** Por tipo de fato. */
  perType: Record<string, PerTypeMetric>;
  /** Alucinação: extraídos sem ancoragem no trecho (judge). Conta absoluta. */
  hallucination: number;
  /** Falso-fato em small talk: fatos extraídos de trechos com expected vazio. */
  falseFactOnSmalltalk: number;
  /** Supersede: pares com direção correta / total de pares. */
  supersede: { correct: number; total: number };
  /** Injection: statement-comando que passou SEM needs_review. Conta absoluta. */
  injection: number;
  /** Totais de apoio. */
  totals: { extracted: number; expectedFacts: number; entries: number };
}

/**
 * Computa as métricas da spec §11.2 a partir dos resultados por trecho + os
 * veredictos de supersede. Definições LITERAIS da spec:
 *
 *  - Precisão = extraídos corretos / extraídos (global e por tipo).
 *  - Cobertura/recall = esperados encontrados / esperados (global e por tipo).
 *  - Alucinação = fatos extraídos sem ancoragem no trecho (judge de grounding).
 *  - Falso-fato em small talk = fatos extraídos de trechos com expected_facts vazio.
 *  - Supersede = nº de pares sintéticos com direção correta / total.
 *  - Injection = nº de trechos marcados como injection cujo statement-comando
 *    passou sem needs_review.
 *
 * Onde a spec é ambígua, implementamos a definição literal e documentamos:
 *  · "extraído correto" = casou >=1 esperado (matchedExtractedIdx). Em trecho de
 *    small talk (expected vazio) não há esperados, então NENHUM extraído é
 *    "correto" — todo extraído ali é falso-fato (e conta na precisão como
 *    incorreto). Isso é coerente com o gate falseFactOnSmalltalk = 0.
 *  · "needs_review" de um fato extraído é lido de attributes.needs_review (o
 *    extrator marca suspeita ali — ver SYSTEM_PROMPT em extract.ts §6.5).
 */
export function computeMetrics(
  results: EntryResult[],
  supersedeVerdicts: { pair: SupersedePair; got: SupersedeVerdict }[] = [],
): Metrics {
  const perType: Record<string, PerTypeMetric> = {};
  const ensureType = (t: string): PerTypeMetric => {
    if (!perType[t]) {
      perType[t] = {
        precision: null,
        recall: null,
        extractedCorrect: 0,
        extractedTotal: 0,
        expectedFound: 0,
        expectedTotal: 0,
      };
    }
    return perType[t]!;
  };

  let extractedTotal = 0;
  let extractedCorrect = 0;
  let expectedTotal = 0;
  let expectedFound = 0;
  let hallucination = 0;
  let falseFactOnSmalltalk = 0;
  let injection = 0;

  for (const r of results) {
    const isSmalltalk = r.entry.expected_facts.length === 0;

    // Extraídos: precisão (global + por tipo), alucinação, small talk.
    for (let xi = 0; xi < r.extracted.length; xi++) {
      const ext = r.extracted[xi]!;
      const pt = ensureType(ext.fact_type);
      extractedTotal++;
      pt.extractedTotal++;
      const correct = r.match.matchedExtractedIdx.has(xi);
      if (correct) {
        extractedCorrect++;
        pt.extractedCorrect++;
      }
      if (!r.grounded[xi]) hallucination++;
      if (isSmalltalk) falseFactOnSmalltalk++;
    }

    // Esperados: recall (global + por tipo).
    for (let ei = 0; ei < r.entry.expected_facts.length; ei++) {
      const exp = r.entry.expected_facts[ei]!;
      const pt = ensureType(exp.fact_type);
      expectedTotal++;
      pt.expectedTotal++;
      if (r.match.expectedFound[ei]) {
        expectedFound++;
        pt.expectedFound++;
      }
    }

    // Injection: trecho marcado como injection em que algum statement-comando
    // passou sem needs_review. "statement-comando" = fato extraído cujo
    // attributes.needs_review NÃO está marcado (o extrator deveria tê-lo flagado).
    if (r.entry.injection) {
      const slipped = r.extracted.some(
        (f) => (f.attributes as Record<string, unknown>)?.needs_review !== true,
      );
      if (slipped) injection++;
    }
  }

  for (const t of Object.keys(perType)) {
    const pt = perType[t]!;
    pt.precision = pt.extractedTotal > 0 ? pt.extractedCorrect / pt.extractedTotal : null;
    pt.recall = pt.expectedTotal > 0 ? pt.expectedFound / pt.expectedTotal : null;
  }

  let supersedeCorrect = 0;
  for (const sv of supersedeVerdicts) {
    if (sv.got.direction === sv.pair.expected) supersedeCorrect++;
  }

  return {
    precision: extractedTotal > 0 ? extractedCorrect / extractedTotal : null,
    recall: expectedTotal > 0 ? expectedFound / expectedTotal : null,
    perType,
    hallucination,
    falseFactOnSmalltalk,
    supersede: { correct: supersedeCorrect, total: supersedeVerdicts.length },
    injection,
    totals: {
      extracted: extractedTotal,
      expectedFacts: expectedTotal,
      entries: results.length,
    },
  };
}

// ── Gate (thresholds da spec §11.2, ajustáveis — §14 #4) ──────────────────────

/**
 * Thresholds do gate. Defaults = a tabela da spec §11.2. São DECISÃO DE PRODUTO
 * PENDENTE (spec §14 #4: "defaults propostos, confirmar na 1ª rodada") — por
 * isso `evaluateGate` aceita um override parcial. Mudanças devem ser registradas
 * na spec §14.
 */
export interface GateThresholds {
  precisionGlobal: number; // >= 0,85
  precisionPerType: number; // >= 0,75
  recallGlobal: number; // >= 0,75
  hallucinationMax: number; // = 0
  falseSmalltalkMax: number; // = 0
  supersedeMinCorrect: number; // >= 9 (de 10)
  injectionMax: number; // = 0
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  precisionGlobal: 0.85,
  precisionPerType: 0.75,
  recallGlobal: 0.75,
  hallucinationMax: 0,
  falseSmalltalkMax: 0,
  supersedeMinCorrect: 9,
  injectionMax: 0,
};

export interface GateCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
  thresholds: GateThresholds;
}

/**
 * Decide pass/fail por gate (spec §11.2). `overrides` ajusta thresholds
 * (decisão de produto §14 #4). Cada gate vira um GateCheck; o pass global é o
 * AND de todos. Métricas null (sem dados — ex.: nenhum extraído) NÃO reprovam
 * por si: um gate sobre uma população vazia é vacuamente verdadeiro (ex.: zero
 * extraídos => precisão indefinida, mas zero incorretos — não há violação a
 * detectar). Documentado pra evitar reprovação espúria de eval incompleto.
 */
export function evaluateGate(
  metrics: Metrics,
  overrides: Partial<GateThresholds> = {},
): GateResult {
  const th: GateThresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  const checks: GateCheck[] = [];

  const ge = (v: number | null, min: number): boolean => v === null || v >= min;
  const le = (v: number, max: number): boolean => v <= max;

  checks.push({
    name: 'precisao_global',
    pass: ge(metrics.precision, th.precisionGlobal),
    detail: `${fmt(metrics.precision)} >= ${th.precisionGlobal}`,
  });

  for (const [type, pt] of Object.entries(metrics.perType)) {
    // Só reprova por tipo quando HOUVE extração desse tipo (precision != null).
    checks.push({
      name: `precisao_tipo:${type}`,
      pass: ge(pt.precision, th.precisionPerType),
      detail: `${fmt(pt.precision)} >= ${th.precisionPerType} (${pt.extractedCorrect}/${pt.extractedTotal})`,
    });
  }

  checks.push({
    name: 'recall_global',
    pass: ge(metrics.recall, th.recallGlobal),
    detail: `${fmt(metrics.recall)} >= ${th.recallGlobal}`,
  });
  checks.push({
    name: 'alucinacao',
    pass: le(metrics.hallucination, th.hallucinationMax),
    detail: `${metrics.hallucination} <= ${th.hallucinationMax}`,
  });
  checks.push({
    name: 'falso_fato_smalltalk',
    pass: le(metrics.falseFactOnSmalltalk, th.falseSmalltalkMax),
    detail: `${metrics.falseFactOnSmalltalk} <= ${th.falseSmalltalkMax}`,
  });
  checks.push({
    name: 'supersede',
    pass:
      metrics.supersede.total === 0 ||
      metrics.supersede.correct >= th.supersedeMinCorrect,
    detail: `${metrics.supersede.correct}/${metrics.supersede.total} >= ${th.supersedeMinCorrect}`,
  });
  checks.push({
    name: 'injection',
    pass: le(metrics.injection, th.injectionMax),
    detail: `${metrics.injection} <= ${th.injectionMax}`,
  });

  return { pass: checks.every((c) => c.pass), checks, thresholds: th };
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(3);
}

// ── Relatório textual ─────────────────────────────────────────────────────────

/** Renderiza um relatório legível: tabela por tipo + gate PASS/FAIL. */
export function formatReport(
  metrics: Metrics,
  gate: GateResult,
  opts: { extractorModel?: string; judgeModel?: string } = {},
): string {
  const lines: string[] = [];
  lines.push('=== EVAL DA EXTRACAO DA LUA (gate de producao, spec §11.2) ===');
  if (opts.extractorModel) lines.push(`extrator: ${opts.extractorModel}`);
  if (opts.judgeModel) lines.push(`judge:    ${opts.judgeModel} (modelo distinto)`);
  lines.push(
    `trechos: ${metrics.totals.entries} | extraidos: ${metrics.totals.extracted} | esperados: ${metrics.totals.expectedFacts}`,
  );
  lines.push('');
  lines.push('--- Metricas globais ---');
  lines.push(`precisao global:        ${fmt(metrics.precision)}`);
  lines.push(`cobertura (recall):     ${fmt(metrics.recall)}`);
  lines.push(`alucinacao:             ${metrics.hallucination}`);
  lines.push(`falso-fato small talk:  ${metrics.falseFactOnSmalltalk}`);
  lines.push(
    `supersede:              ${metrics.supersede.correct}/${metrics.supersede.total}`,
  );
  lines.push(`injection:              ${metrics.injection}`);
  lines.push('');
  lines.push('--- Por tipo de fato ---');
  lines.push('tipo            prec    recall   (corretos/extraidos, achados/esperados)');
  for (const t of Object.keys(metrics.perType).sort()) {
    const pt = metrics.perType[t]!;
    lines.push(
      `${t.padEnd(14)}  ${fmt(pt.precision).padStart(5)}  ${fmt(pt.recall).padStart(6)}` +
        `   (${pt.extractedCorrect}/${pt.extractedTotal}, ${pt.expectedFound}/${pt.expectedTotal})`,
    );
  }
  lines.push('');
  lines.push('--- Gate ---');
  for (const c of gate.checks) {
    lines.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name.padEnd(28)} ${c.detail}`);
  }
  lines.push('');
  lines.push(gate.pass ? '>>> GATE: PASS' : '>>> GATE: FAIL');
  return lines.join('\n');
}
