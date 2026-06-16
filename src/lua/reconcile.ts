// Reconciliacao / invalidacao bi-temporal da Lua — Estagio B, passo 2 (spec §6).
//
// Recebe os CANDIDATOS de fato extraidos de UM episodio (src/lua/extract.ts) e os
// reconcilia contra a memoria semantica vigente (facts), aplicando o pipeline de
// veredictos (§6.2: duplicate/supersedes/contradicts/unrelated), a regra temporal
// do supersede (§6.3: normal/retroativo/mesmo-instante), a reconciliacao
// intra-episodio (§6.4) e os casos-limite (§6.5: confianca baixa, conduta citada).
//
// CONTRATO DE TRANSACAO: o CALLER e dono da TX (BEGIN/COMMIT fora). Todas as
// escritas usam o `client` passado — embeddings sao computados ANTES de qualquer
// write (spec §5.3-B3). Esta funcao NAO abre/fecha transacao; o pipeline (proxima
// task) embrulha insert+invalidacao numa unica TX2.
//
// Sem rede: embeddingClient e judge sao injetados (fakes nos testes).

import type { PoolClient } from 'pg';
import type { EmbeddingClient } from './embeddings.js';
import type { LlmClient } from './llm.js';
import type { FactCandidate } from './extract.js';
import {
  insertFactTx,
  supersedeFactTx,
  flagFactTx,
  searchNeighbors,
  type FactInput,
  type NeighborRow,
} from './db.js';

export type Verdict = 'duplicate' | 'supersedes' | 'contradicts' | 'unrelated';

const VERDICTS: readonly Verdict[] = ['duplicate', 'supersedes', 'contradicts', 'unrelated'];

// Limites de busca de vizinhos (spec §6.1).
const NEIGHBOR_LIMIT = 8;
const NEIGHBOR_MIN_SIM = 0.55;

// Confianca abaixo disso => fato entra com needs_review e NUNCA age como N de
// supersede automatico (spec §6.5).
const LOW_CONFIDENCE = 0.5;

export interface ReconcileArgs {
  workspaceId: string;
  episodeId: number | string;
  episodeRevision: number;
  /** episodes.occurred_at — default de valid_at (spec §6.3). */
  occurredAt: string;
  candidates: FactCandidate[];
  runId?: number;
  /** model id da extracao (vai pra facts.extracted_by). */
  extractedBy: string;
}

export interface ReconcileDeps {
  embeddingClient: EmbeddingClient;
  judge: LlmClient;
}

export interface ReconcileResult {
  inserted: number;
  superseded: number;
  flagged: number;
}

// Candidato apos embedding + resolucao de valid_at, antes de tocar o banco.
interface PreparedCandidate {
  statement: string;
  factType: string;
  attributes: Record<string, unknown>;
  confidence: number;
  turnStart: number;
  turnEnd: number;
  embedding: number[];
  /** valid_at resolvido (occurred_at, ou o hint quando aceito) como Date. */
  validAt: Date;
  /** Nota acumulada (ex.: hint descartado) a gravar no review_note ao inserir. */
  note: string | null;
  /** Marcado quando confidence < 0.5 (§6.5) ou contradicts/intra-episodio. */
  needsReview: boolean;
  /** Quando intra-episodio (§6.4) decide que este candidato nasce invalido. */
  bornInvalid?: { invalidAt: Date; reason: string };
  /** Indice no array original (para resolver supersede intra-episodio para id). */
  index: number;
}

// ── Veredicto via judge (structured output) ────────────────────────────────

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: VERDICTS as unknown as string[] },
    reasoning: { type: 'string' },
  },
  required: ['verdict'],
} as const;

const JUDGE_SYSTEM = `Voce e o juiz de reconciliacao da Lua, a memoria do ecossistema BeeAds.
Recebe DOIS fatos (A e B) do mesmo projeto e do mesmo tipo. Decida a relacao entre eles:
- duplicate: A e B afirmam a MESMA informacao (mesma materia, mesmo valor/estado).
- supersedes: A e B tratam da MESMA materia, mas com valor/estado DIFERENTE (um substitui o outro).
- contradicts: A e B sao incompativeis, sem relacao clara de sucessao no tempo.
- unrelated: A e B falam de coisas diferentes e coexistem.
A direcao temporal (qual veio antes) NAO e sua decisao — voce so classifica a relacao.
Responda chamando a ferramenta com { verdict, reasoning }.`;

/**
 * Monta o user message do judge. As linhas "A: ..." e "B: ..." sao o contrato com
 * o fake judge dos testes (que extrai os statements por regex) e tambem o que o
 * judge real le; o contexto extra (valid_at, proveniencia) vem depois.
 */
function buildJudgeUser(
  cand: PreparedCandidate,
  neighbor: NeighborRow,
  occurredAt: string
): string {
  return [
    `A: ${cand.statement}`,
    `B: ${neighbor.statement}`,
    '',
    `Contexto:`,
    `- A foi dito no episodio com data ${occurredAt} (valid_at provavel: ${cand.validAt.toISOString()}).`,
    `- B ja esta na memoria com valid_at ${new Date(neighbor.valid_at).toISOString()}.`,
  ].join('\n');
}

/** Monta o user message do judge para um par INTRA-episodio (dois candidatos). */
function buildIntraJudgeUser(a: PreparedCandidate, b: PreparedCandidate): string {
  return [
    `A: ${a.statement}`,
    `B: ${b.statement}`,
    '',
    `Contexto:`,
    `- A e B foram ditos no MESMO episodio (turnos A:${a.turnStart}-${a.turnEnd}, B:${b.turnStart}-${b.turnEnd}).`,
  ].join('\n');
}

async function judgePair(judge: LlmClient, user: string): Promise<Verdict> {
  const res = await judge.complete<{ verdict: Verdict }>({
    system: JUDGE_SYSTEM,
    user,
    schema: JUDGE_SCHEMA as unknown as object,
  });
  return res.verdict;
}

// ── valid_at: default occurred_at; aceita hint se parseavel E anterior (§6.3) ─

function resolveValidAt(occurredAt: string, hint?: string): { validAt: Date; note: string | null } {
  const occurred = new Date(occurredAt);
  if (!hint) return { validAt: occurred, note: null };
  const parsed = new Date(hint);
  if (Number.isNaN(parsed.getTime())) {
    return { validAt: occurred, note: `valid_at_hint "${hint}" ignorado: nao parseavel` };
  }
  if (parsed.getTime() < occurred.getTime()) {
    return { validAt: parsed, note: null };
  }
  // hint >= occurred_at: ignorado com nota (spec §6.3: aceito so se anterior).
  return { validAt: occurred, note: `valid_at_hint "${hint}" ignorado: nao anterior a occurred_at` };
}

// ── INSERT de um candidato preparado, montando o FactInput ──────────────────

async function insertPrepared(
  client: PoolClient,
  cand: PreparedCandidate,
  args: ReconcileArgs,
  embeddingModel: string,
  opts: {
    needsReview: boolean;
    extraNote?: string | null;
    invalidAt?: Date | null;
    invalidationReason?: string | null;
    supersededByFactId?: number | null;
  }
): Promise<number> {
  const notes = [cand.note, opts.extraNote].filter((n): n is string => !!n);
  const reviewNote = notes.length ? notes.join('\n') : null;
  const fact: FactInput = {
    workspaceId: args.workspaceId,
    factType: cand.factType,
    statement: cand.statement,
    attributes: cand.attributes,
    confidence: cand.confidence,
    validAt: cand.validAt,
    episodeId: Number(args.episodeId),
    episodeRevision: args.episodeRevision,
    turnStart: cand.turnStart,
    turnEnd: cand.turnEnd,
    embedding: cand.embedding,
    embeddingModel,
    extractedBy: args.extractedBy,
    runId: args.runId ?? null,
    needsReview: opts.needsReview,
    reviewNote,
    invalidAt: opts.invalidAt ?? null,
    invalidationReason: opts.invalidationReason ?? null,
    supersededByFactId: opts.supersededByFactId ?? null,
  };
  return insertFactTx(client, fact);
}

// ── Marca needs_review nas regras de conduta ATIVA que citam um fato (§6.5) ──

async function flagCondutaRulesCiting(client: PoolClient, factId: number): Promise<void> {
  await client.query(
    `UPDATE conduta_rules
        SET needs_review = TRUE
      WHERE id IN (
        SELECT crs.rule_id
          FROM conduta_rule_sources crs
          JOIN conduta_rules r ON r.id = crs.rule_id
          JOIN condutas c ON c.id = r.conduta_id
         WHERE crs.fact_id = $1
           AND c.status = 'active'
      )`,
    [factId]
  );
}

// ── Bump de confidence num fato existente sem setar needs_review (§14 #15) ──

async function bumpConfidenceWithNote(
  client: PoolClient,
  existingId: number,
  newConfidence: number,
  note: string
): Promise<void> {
  await client.query(
    `UPDATE facts
        SET confidence = $2,
            review_note = CASE
              WHEN review_note IS NULL OR review_note = '' THEN $3
              ELSE review_note || E'\n' || $3
            END
      WHERE id = $1`,
    [existingId, newConfidence, note]
  );
}

// ── Passo 1: reconciliacao INTRA-episodio (§6.4) ────────────────────────────
//
// Julga TODOS os pares de candidatos do mesmo episodio. Resultado:
//  - duplicate: colapsa em 1 (mantem a janela de turnos mais larga).
//  - supersedes: o de turn_start MAIOR vence; o anterior nasce invalido.
//  - contradicts: ambos mantidos, ambos needs_review.
// Retorna a lista de candidatos sobreviventes (alguns marcados bornInvalid /
// needsReview), JA preparados (embedding + valid_at resolvidos).

async function reconcileIntraEpisode(
  prepared: PreparedCandidate[],
  judge: LlmClient,
  occurredAt: string
): Promise<{ survivors: PreparedCandidate[]; supersedePairs: { earlierIdx: number; laterIdx: number }[] }> {
  const occurred = new Date(occurredAt);
  // Estrutura union-find leve para colapsar duplicates.
  const n = prepared.length;
  const alive = new Array(n).fill(true);
  // Para supersede intra-episodio guardamos (anterior, posterior); resolvemos ids
  // depois do INSERT (ambos sao inseridos).
  const supersedePairs: { earlierIdx: number; laterIdx: number }[] = [];

  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!alive[j]) continue;
      const a = prepared[i]!;
      const b = prepared[j]!;
      // So compara mesmo fact_type (vizinhanca semantica e por tipo — §6.1/§6.2).
      if (a.factType !== b.factType) continue;
      const verdict = await judgePair(judge, buildIntraJudgeUser(a, b));
      if (verdict === 'duplicate') {
        // Colapsa j em i, mantendo a janela de turnos MAIS LARGA (§6.4 #2).
        a.turnStart = Math.min(a.turnStart, b.turnStart);
        a.turnEnd = Math.max(a.turnEnd, b.turnEnd);
        a.confidence = Math.max(a.confidence, b.confidence);
        if (b.note && !a.note) a.note = b.note;
        alive[j] = false;
      } else if (verdict === 'supersedes') {
        // O de turn_start MAIOR vence; o anterior nasce invalido (§6.4 #3).
        // invalid_at = occurred_at (a ordem do discurso e a linha do tempo dentro
        // do episodio; o supersede vale a partir do momento do episodio).
        const earlier = a.turnStart <= b.turnStart ? a : b;
        const later = earlier === a ? b : a;
        // §6.5: candidato com confidence < 0.5 NUNCA age como N de supersede
        // automatico (espelha o guard inter-episodio). Rebaixa para contradicts
        // (ambos vigentes + needs_review) — conflito visivel > invalidacao silenciosa.
        if (later.confidence < LOW_CONFIDENCE) {
          a.needsReview = true;
          b.needsReview = true;
        } else {
          earlier.bornInvalid = { invalidAt: occurred, reason: 'superseded' };
          supersedePairs.push({ earlierIdx: earlier.index, laterIdx: later.index });
        }
      } else if (verdict === 'contradicts') {
        // Ambos mantidos, ambos needs_review (§6.4 #4).
        a.needsReview = true;
        b.needsReview = true;
      }
      // unrelated: nada a fazer intra-episodio.
    }
  }

  const survivors = prepared.filter((_, idx) => alive[idx]);
  return { survivors, supersedePairs };
}

// ── Reconciliacao por episodio (orquestrador) ───────────────────────────────

export async function reconcileEpisode(
  client: PoolClient,
  args: ReconcileArgs,
  deps: ReconcileDeps
): Promise<ReconcileResult> {
  const embeddingModel = deps.embeddingClient.model;

  const result: ReconcileResult = { inserted: 0, superseded: 0, flagged: 0 };
  if (args.candidates.length === 0) return result;

  // ── Passo 0: embeddings de TODOS os statements ANTES de qualquer write (§5.3-B3).
  const embeddings = await deps.embeddingClient.embed(args.candidates.map((c) => c.statement));

  const prepared: PreparedCandidate[] = args.candidates.map((c, idx) => {
    const { validAt, note } = resolveValidAt(args.occurredAt, c.valid_at_hint);
    return {
      statement: c.statement,
      factType: c.fact_type,
      attributes: c.attributes ?? {},
      confidence: c.confidence,
      turnStart: c.turn_start,
      turnEnd: c.turn_end,
      embedding: embeddings[idx]!,
      validAt,
      note,
      // confianca baixa => needs_review desde ja (§6.5).
      needsReview: c.confidence < LOW_CONFIDENCE,
      index: idx,
    };
  });

  // ── Passo 1: reconciliacao INTRA-episodio (antes da busca de vizinhos — §6.4).
  const { survivors, supersedePairs } = await reconcileIntraEpisode(prepared, deps.judge, args.occurredAt);

  // INSERT de todos os sobreviventes primeiro, registrando o id de cada um pelo
  // seu index original — assim resolvemos os supersedePairs intra-episodio.
  const idByIndex = new Map<number, number>();

  for (const cand of survivors) {
    // Para cada sobrevivente, primeiro a reconciliacao contra VIZINHOS do banco
    // (§6.2/§6.3) — exceto quando ja nasce invalido por supersede intra-episodio,
    // que ainda assim precisa ser inserido (a proveniencia das duas falas e
    // preservada) mas nao busca vizinhos como N ativo.
    const isBornInvalidIntra = !!cand.bornInvalid;

    // Busca de vizinhos vigentes do mesmo workspace+tipo (§6.1).
    const neighbors = await searchNeighbors(client, {
      workspaceId: args.workspaceId,
      factType: cand.factType,
      embedding: cand.embedding,
      limit: NEIGHBOR_LIMIT,
      minSim: NEIGHBOR_MIN_SIM,
    });

    if (neighbors.length === 0 || isBornInvalidIntra) {
      // Sem vizinho de banco (ou candidato ja resolvido intra-episodio): INSERT.
      const id = await insertWithIntraInvalidation(client, cand, args, embeddingModel, result);
      idByIndex.set(cand.index, id);
      continue;
    }

    // Julga o candidato contra cada vizinho e classifica.
    const judged: { neighbor: NeighborRow; verdict: Verdict }[] = [];
    for (const neighbor of neighbors) {
      const verdict = await judgePair(deps.judge, buildJudgeUser(cand, neighbor, args.occurredAt));
      judged.push({ neighbor, verdict });
    }

    const id = await applyNeighborVerdicts(client, cand, judged, args, embeddingModel, result);
    idByIndex.set(cand.index, id);
  }

  // ── Resolve supersedes INTRA-episodio: aponta o anterior (born invalid) para o
  // posterior agora que ambos tem id. O anterior ja foi inserido born-invalid com
  // superseded_by NULL; fazemos o UPDATE do ponteiro aqui.
  for (const pair of supersedePairs) {
    const earlierId = idByIndex.get(pair.earlierIdx);
    const laterId = idByIndex.get(pair.laterIdx);
    if (earlierId == null || laterId == null) continue;
    await client.query(
      `UPDATE facts SET superseded_by_fact_id = $2 WHERE id = $1`,
      [earlierId, laterId]
    );
    result.superseded += 1;
  }

  return result;
}

// INSERT de um candidato que nao tem reconciliacao contra vizinhos de banco.
// Cobre: zero vizinhos; candidato born-invalid por supersede intra-episodio.
async function insertWithIntraInvalidation(
  client: PoolClient,
  cand: PreparedCandidate,
  args: ReconcileArgs,
  embeddingModel: string,
  result: ReconcileResult
): Promise<number> {
  if (cand.bornInvalid) {
    // Supersede intra-episodio: o anterior nasce invalido (superseded_by resolvido
    // no segundo passo, quando o posterior ja tiver id). reason exigido pelo CHECK.
    const id = await insertPrepared(client, cand, args, embeddingModel, {
      needsReview: cand.needsReview,
      invalidAt: cand.bornInvalid.invalidAt,
      invalidationReason: cand.bornInvalid.reason,
      supersededByFactId: null,
    });
    result.inserted += 1;
    if (cand.needsReview) result.flagged += 1;
    return id;
  }
  const id = await insertPrepared(client, cand, args, embeddingModel, { needsReview: cand.needsReview });
  result.inserted += 1;
  if (cand.needsReview) result.flagged += 1;
  return id;
}

// ── Passo 2/3: aplica os veredictos contra vizinhos de banco (§6.2/§6.3) ────

async function applyNeighborVerdicts(
  client: PoolClient,
  cand: PreparedCandidate,
  judged: { neighbor: NeighborRow; verdict: Verdict }[],
  args: ReconcileArgs,
  embeddingModel: string,
  result: ReconcileResult
): Promise<number> {
  const lowConfidence = cand.confidence < LOW_CONFIDENCE;

  // duplicate tem precedencia de "nao inserir": se QUALQUER vizinho e duplicate,
  // o candidato e a mesma info ja conhecida (§6.2). Bumpa confidence se maior.
  const dup = judged.find((j) => j.verdict === 'duplicate');
  if (dup) {
    await maybeBumpConfidence(client, dup.neighbor.id, cand.confidence);
    return -1; // nao inserido
  }

  // contradicts: insere o candidato + needs_review em AMBOS (§6.2).
  const contradicts = judged.filter((j) => j.verdict === 'contradicts');

  // supersedes: aplica a regra temporal (§6.3). Confianca baixa NUNCA age como N
  // de supersede automatico (§6.5) — tratamos esses pares como contradicts (mantem
  // ambos vigentes + flag), nunca invalidando.
  const supersedesPairs = judged.filter((j) => j.verdict === 'supersedes');

  if (supersedesPairs.length > 0 && !lowConfidence) {
    return await applyTemporalRule(client, cand, supersedesPairs, contradicts, args, embeddingModel, result);
  }

  // Sem supersede efetivo (ou confianca baixa): se ha contradicts (ou supersede
  // rebaixado por confianca baixa), insere com needs_review e flaga os vizinhos.
  const flagNeighbors = [
    ...contradicts.map((j) => j.neighbor),
    ...(lowConfidence ? supersedesPairs.map((j) => j.neighbor) : []),
  ];

  const needsReview = cand.needsReview || flagNeighbors.length > 0;
  const note = flagNeighbors.length
    ? `conflito com fato(s): ${flagNeighbors.map((nb) => `#${nb.id}`).join(', ')}`
    : null;

  const id = await insertPrepared(client, cand, args, embeddingModel, {
    needsReview,
    extraNote: note,
  });
  result.inserted += 1;
  if (needsReview) result.flagged += 1;

  for (const nb of flagNeighbors) {
    await flagFactTx(client, nb.id, `conflito com fato novo #${id} ("${cand.statement}")`);
    result.flagged += 1;
  }
  return id;
}

/** Bumpa a confidence do fato existente para a do candidato SE maior, com nota (§14 #15). */
async function maybeBumpConfidence(
  client: PoolClient,
  existingId: number,
  candidateConfidence: number
): Promise<void> {
  const { rows } = await client.query<{ confidence: string }>(
    `SELECT confidence FROM facts WHERE id = $1`,
    [existingId]
  );
  const existing = rows[0] ? Number(rows[0].confidence) : 1;
  if (candidateConfidence > existing) {
    await bumpConfidenceWithNote(
      client,
      existingId,
      candidateConfidence,
      `confidence bumpada de ${existing} para ${candidateConfidence} (duplicate confirmado em episodio posterior)`
    );
  }
}

// ── Regra temporal do supersede (§6.3) ──────────────────────────────────────
//
// N = candidato; conjunto de E vigentes julgados `supersedes`. Particiona por
// E.valid_at vs N.valid_at:
//  - E.valid_at == N.valid_at: mesmo instante, valores diferentes => CONTRADICTS
//    forcado (ambos needs_review, nenhum invalidado). Nunca decide por ordem.
//  - E.valid_at < N.valid_at: N supersede E normalmente (N vigente; E invalidado
//    em N.valid_at, superseded_by=N). N invalida TODOS esses (consolidacao §6.2#3).
//  - E.valid_at > N.valid_at: N e RETROATIVO. N nasce invalido apontando o
//    SUCESSOR = o E de MENOR valid_at posterior a N.valid_at (elo adjacente).
//    Esses E (mais novos) NAO sao invalidados por N.

async function applyTemporalRule(
  client: PoolClient,
  cand: PreparedCandidate,
  supersedes: { neighbor: NeighborRow; verdict: Verdict }[],
  contradicts: { neighbor: NeighborRow; verdict: Verdict }[],
  args: ReconcileArgs,
  embeddingModel: string,
  result: ReconcileResult
): Promise<number> {
  const nValidMs = cand.validAt.getTime();

  const sameInstant: NeighborRow[] = [];
  const older: NeighborRow[] = []; // E.valid_at < N.valid_at  => N supersede E
  const newer: NeighborRow[] = []; // E.valid_at > N.valid_at  => N retroativo

  for (const { neighbor } of supersedes) {
    const eMs = new Date(neighbor.valid_at).getTime();
    if (eMs === nValidMs) sameInstant.push(neighbor);
    else if (eMs < nValidMs) older.push(neighbor);
    else newer.push(neighbor);
  }

  // O sucessor retroativo = E de MENOR valid_at dentre os `newer` (§6.3).
  let successor: NeighborRow | null = null;
  for (const e of newer) {
    if (!successor || new Date(e.valid_at).getTime() < new Date(successor.valid_at).getTime()) {
      successor = e;
    }
  }

  // needs_review do candidato: confianca baixa ja foi excluida (caller); aqui so
  // contradicts (mesmo-instante ou veredicto contradicts explicito) forca flag.
  const forcedContradicts = sameInstant.length > 0 || contradicts.length > 0;
  const needsReview = cand.needsReview || forcedContradicts;

  const noteParts: string[] = [];
  if (sameInstant.length) {
    noteParts.push(
      `mesmo valid_at, valores diferentes (contradicts forcado) com fato(s): ${sameInstant
        .map((e) => `#${e.id}`)
        .join(', ')}`
    );
  }
  if (contradicts.length) {
    noteParts.push(`conflito com fato(s): ${contradicts.map((j) => `#${j.neighbor.id}`).join(', ')}`);
  }

  const id = await insertPrepared(client, cand, args, embeddingModel, {
    needsReview,
    extraNote: noteParts.length ? noteParts.join('\n') : null,
    // RETROATIVO: N nasce invalido apontando o sucessor adjacente (§6.3).
    invalidAt: successor ? new Date(successor.valid_at) : null,
    invalidationReason: successor ? 'superseded' : null,
    supersededByFactId: successor ? successor.id : null,
  });
  result.inserted += 1;
  if (needsReview) result.flagged += 1;

  // N supersede os `older` normalmente: cada E invalidado em N.valid_at, apontando N.
  for (const e of older) {
    await supersedeFactTx(client, {
      existingId: e.id,
      newId: id,
      invalidAt: cand.validAt,
      reason: 'superseded',
    });
    result.superseded += 1;
    // Se o fato invalidado era citado por conduta ativa, flaga as regras (§6.5).
    await flagCondutaRulesCiting(client, e.id);
  }

  // mesmo-instante e contradicts: flaga os vizinhos (ambos needs_review).
  for (const e of [...sameInstant, ...contradicts.map((j) => j.neighbor)]) {
    await flagFactTx(client, e.id, `conflito com fato novo #${id} ("${cand.statement}")`);
    result.flagged += 1;
  }

  return id;
}
