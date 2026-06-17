// Pipeline da Lua — Estágio A (spec Lua v1 §5.3, TX1 `pending` → `chunked`).
//
// runStageA carrega os turnos de um episódio reivindicado, chunka de forma
// determinística (chunking.ts), embeda os chunks por um cliente injetável
// (embeddings.ts — fake nos testes, OpenAI em prod) e grava tudo numa única
// transação idempotente (insertChunksTx faz delete-insert), concluída sob
// fencing do lease (finishProcessingTx). Lease perdido ⇒ ROLLBACK silencioso e
// {chunks:0} — o novo dono do claim refaz do zero.

import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { chunkTurns, type Turn } from './chunking.js';
import { embedBatched, type EmbeddingClient } from './embeddings.js';
import { extractFacts, type ExtractInput } from './extract.js';
import { prepareReconcile, applyReconcile, type ReconcileResult } from './reconcile.js';
import type { LlmClient } from './llm.js';
import {
  insertChunksTx,
  finishProcessingTx,
  type ProcessingRow,
  type ChunkInput,
} from './db.js';

/** Linha bruta de episode_turns + workspace_id do episódio (JOIN). */
type TurnRow = {
  turn_index: number;
  speaker_name: string | null;
  speaker_label: string | null;
  text: string;
};

/**
 * Carrega os turnos do episódio (ordem turn_index ASC) e o workspace_id CORRENTE
 * do episódio numa só ida ao banco. Mapeia cada turno para o shape `Turn` que o
 * chunker espera, escolhendo o falante: nome humano > label > `Falante N`.
 */
async function loadTurnsAndWorkspace(
  episodeId: number | string
): Promise<{ workspaceId: string | null; turns: Turn[] }> {
  const wsRes = await pool.query<{ workspace_id: string | null }>(
    `SELECT workspace_id FROM episodes WHERE id = $1`,
    [episodeId]
  );
  const workspaceId = wsRes.rows[0]?.workspace_id ?? null;

  const { rows } = await pool.query<TurnRow>(
    `SELECT turn_index, speaker_name, speaker_label, text
       FROM episode_turns
      WHERE episode_id = $1
      ORDER BY turn_index ASC`,
    [episodeId]
  );

  const turns: Turn[] = rows.map((r) => ({
    turn_index: r.turn_index,
    speaker: speakerOf(r),
    text: r.text,
  }));

  return { workspaceId, turns };
}

/** Metadados do episódio necessários à extração (spec §5.3-B1). */
type EpisodeMeta = {
  workspaceId: string | null;
  title: string | null;
  occurredAt: Date;
  participants: string[];
  turns: Turn[];
};

/**
 * Carrega metadados + transcrição do episódio para o estágio B numa só ida ao
 * banco para os campos do episódio (título, data, workspace) + uma para turnos.
 * `participants` é derivado dos nomes de falante distintos (humanos) dos turnos —
 * a tabela episodes não materializa participantes em V1; o extrator só usa como
 * dica de cabeçalho. Reusa `speakerOf` para o shape `Turn` (igual ao estágio A).
 */
async function loadEpisodeForExtraction(
  episodeId: number | string
): Promise<EpisodeMeta> {
  const epRes = await pool.query<{
    workspace_id: string | null;
    title: string | null;
    occurred_at: Date;
  }>(
    `SELECT workspace_id, title, occurred_at FROM episodes WHERE id = $1`,
    [episodeId]
  );
  const ep = epRes.rows[0];

  const { rows } = await pool.query<TurnRow>(
    `SELECT turn_index, speaker_name, speaker_label, text
       FROM episode_turns
      WHERE episode_id = $1
      ORDER BY turn_index ASC`,
    [episodeId]
  );
  const turns: Turn[] = rows.map((r) => ({
    turn_index: r.turn_index,
    speaker: speakerOf(r),
    text: r.text,
  }));

  // Participantes = nomes humanos distintos (preserva ordem de aparição). Falantes
  // genéricos ("Falante N") são ruído de cabeçalho; ficam de fora.
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const r of rows) {
    const name = r.speaker_name?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      participants.push(name);
    }
  }

  return {
    workspaceId: ep?.workspace_id ?? null,
    title: ep?.title ?? null,
    occurredAt: ep?.occurred_at ?? new Date(0),
    participants,
    turns,
  };
}

/** Nome do falante: nome humano > label > `Falante <turn_index>` (fallback genérico). */
function speakerOf(r: TurnRow): string {
  const name = r.speaker_name?.trim();
  if (name) return name;
  const label = r.speaker_label?.trim();
  if (label) return label;
  return `Falante ${r.turn_index}`;
}

/**
 * Estágio A do pipeline (spec §5.3-A). Carrega turnos → chunka → embeda → grava
 * chunks + conclui o claim como `chunked`, tudo em TX1.
 *
 * Fencing: `finishProcessingTx` é condicionado ao claim vigente (id + claimed_by
 * + claimed_at). Se retornar false (lease perdido), faz ROLLBACK e devolve
 * {chunks:0} — descarta em silêncio; o novo dono refaz. Caso contrário, COMMIT.
 *
 * O `workspace_id` gravado nos chunks é o CORRENTE do episódio (lido junto com os
 * turnos). `embedding_model` vem de `deps.embeddingClient.model`.
 */
export async function runStageA(
  row: ProcessingRow,
  deps: { embeddingClient: EmbeddingClient }
): Promise<{ chunks: number }> {
  const { workspaceId, turns } = await loadTurnsAndWorkspace(row.episode_id);

  // Chunking determinístico (sem DB/rede/LLM).
  const chunkMetas = chunkTurns(turns);

  // Embeddings em lote (cliente injetável). Um vetor por chunk, ordem preservada.
  const vectors = await embedBatched(
    deps.embeddingClient,
    chunkMetas.map((c) => c.text)
  );

  const model = deps.embeddingClient.model;
  const chunks: ChunkInput[] = chunkMetas.map((c, i) => ({
    chunkIndex: c.chunkIndex,
    turnStart: c.turnStart,
    turnEnd: c.turnEnd,
    charStart: c.charStart,
    charEnd: c.charEnd,
    text: c.text,
    tokenCount: c.tokenCount,
    embedding: vectors[i]!,
    embeddingModel: model,
  }));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertChunksTx(client, {
      episodeId: row.episode_id,
      episodeRevision: row.episode_revision,
      // workspace_id é NOT NULL em episode_chunks; um episódio elegível sempre tem
      // workspace (a varredura §5.2 só enfileira workspace_id NÃO nulo). Fallback
      // defensivo para string vazia nunca deve ocorrer no caminho real.
      workspaceId: workspaceId ?? '',
      chunks,
    });
    const ok = await finishProcessingTx(client, {
      id: row.id,
      claimedBy: row.claimed_by!,
      claimedAt: row.claimed_at!,
      status: 'chunked',
      stats: { chunks: chunks.length },
    });
    if (!ok) {
      // Lease perdido (fencing): descarta o trabalho. O novo dono do claim refaz.
      await client.query('ROLLBACK');
      return { chunks: 0 };
    }
    await client.query('COMMIT');
    return { chunks: chunks.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Invalidação dos fatos da revision ANTERIOR num reprocessamento (spec §4.6,
 * achado Codex #4: roda DENTRO da TX2, junto com os inserts da revision nova —
 * NUNCA antes da extração estar pronta, senão uma falha de extração apagaria a
 * memória vigente até o retry). Regra determinística, em DUAS queries:
 *
 *  1. Fato vigente (invalid_at IS NULL) de `episode_id` com `episode_revision`
 *     MENOR que a corrente, e CITADO por regra de conduta ATIVA → needs_review
 *     = TRUE (não invalida; a conduta aprovada não muda sozinha).
 *  2. Os demais fatos vigentes da revision anterior (não citados) → invalid_at
 *     = NOW(), invalidation_reason = 'revision_reprocessed'. O CHECK
 *     facts_invalidation_chk exige os dois juntos.
 *
 * A query (1) roda PRIMEIRO para que (2) os exclua via a mesma condição de
 * citação (subquery), evitando invalidar um fato que deveria só ser flagado.
 * Fatos já inválidos ficam intocados (filtro invalid_at IS NULL nas duas).
 */
async function invalidatePriorRevisionFactsTx(
  client: PoolClient,
  args: { episodeId: number; episodeRevision: number }
): Promise<{ invalidated: number; flagged: number }> {
  // Subquery reutilizável: fato vigente da revision anterior citado por conduta ATIVA.
  const citedByActiveConduta = `
    SELECT 1
      FROM conduta_rule_sources crs
      JOIN conduta_rules r ON r.id = crs.rule_id
      JOIN condutas c ON c.id = r.conduta_id
     WHERE crs.fact_id = f.id
       AND c.status = 'active'`;

  // (1) citado por conduta ativa → needs_review (não invalida).
  const flaggedRes = await client.query(
    `UPDATE facts f
        SET needs_review = TRUE
      WHERE f.episode_id = $1
        AND f.episode_revision < $2
        AND f.invalid_at IS NULL
        AND EXISTS (${citedByActiveConduta})`,
    [args.episodeId, args.episodeRevision]
  );

  // (2) não citado por conduta ativa → invalida com reason 'revision_reprocessed'.
  const invalidatedRes = await client.query(
    `UPDATE facts f
        SET invalid_at = NOW(),
            invalidation_reason = 'revision_reprocessed'
      WHERE f.episode_id = $1
        AND f.episode_revision < $2
        AND f.invalid_at IS NULL
        AND NOT EXISTS (${citedByActiveConduta})`,
    [args.episodeId, args.episodeRevision]
  );

  return {
    invalidated: invalidatedRes.rowCount ?? 0,
    flagged: flaggedRes.rowCount ?? 0,
  };
}

/** Dependências injetáveis do estágio B (LLM de extração, judge e embeddings). */
export type StageBDeps = {
  llmClient: LlmClient;
  embeddingClient: EmbeddingClient;
  judge: LlmClient;
};

/**
 * Estágio B do pipeline (spec §5.3-B). Para uma linha em status `chunked`:
 *
 * 1. Carrega transcrição + metadados do episódio e EXTRAI os candidatos de fato
 *    via LLM — FORA de qualquer transação (sem DB; só rede LLM, que pode ser lenta).
 * 2. Abre a TX2 (única, condicionada ao claim) e, em ordem:
 *    a. §4.6 — invalida os fatos da revision ANTERIOR (reprocessamento), só DEPOIS
 *       da extração estar pronta (Codex #4);
 *    b. reconcileEpisode — insere os fatos novos + supersede/flag dos vizinhos
 *       (o caller é dono da TX, por contrato de reconcile.ts);
 *    c. finishProcessingTx — conclui como `done` com stats, sob fencing do lease.
 *
 * Fencing: se finishProcessingTx retornar false (lease perdido), ROLLBACK e
 * devolve resultado zerado — o novo dono do claim refaz. Caso contrário, COMMIT.
 *
 * Os fatos da revision anterior só são invalidados quando há de fato uma revision
 * anterior com fatos vigentes (a query não afeta nada no caminho de 1ª passada).
 */
export async function runStageB(
  row: ProcessingRow,
  deps: StageBDeps
): Promise<ReconcileResult & { chunks?: number }> {
  const meta = await loadEpisodeForExtraction(row.episode_id);
  const workspaceId = meta.workspaceId ?? '';

  // ── Passo 1: extração (LLM, SEM DB) — fora da TX (§5.3-B1).
  const extractInput: ExtractInput = {
    transcript: meta.turns.map((t) => ({
      turn_index: t.turn_index,
      speaker: t.speaker,
      text: t.text,
    })),
    metadata: {
      title: meta.title ?? undefined,
      occurred_at: meta.occurredAt.toISOString(),
      participants: meta.participants,
      workspace_id: workspaceId,
    },
  };
  const candidates = await extractFacts(deps.llmClient, extractInput);

  // ── Passo 2: PREPARO do reconcile (embeddings + judging intra-episodio) — LLM,
  // SEM banco, FORA da TX2. Fix idle-in-transaction (spec 2026-06-17): este bloco
  // (antes O(n²) judges dentro da TX) é o que segurava a transação ociosa >60s e
  // fazia o Postgres derrubar a sessão (25P03).
  const reconcileArgs = {
    workspaceId,
    episodeId: Number(row.episode_id),
    episodeRevision: row.episode_revision,
    occurredAt: meta.occurredAt.toISOString(),
    candidates,
    extractedBy: deps.llmClient.model,
  };
  const reconcileDeps = { embeddingClient: deps.embeddingClient, judge: deps.judge };
  const prepared = await prepareReconcile(reconcileArgs, reconcileDeps);

  // ── Passo 3: TX2 única (§5.3-B3) — invalidação §4.6 → escritas do reconcile →
  // finish. Só writes + a busca de vizinhos (read) + ≤8 judges/survivor (vazio em
  // memória fria). `SET LOCAL` dá margem ao tail de judges de vizinho sem mexer no
  // default global do pool (60s, proteção do poller).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '180000'`);

    // §4.6: invalida fatos da revision anterior DENTRO da TX, após a extração pronta.
    await invalidatePriorRevisionFactsTx(client, {
      episodeId: Number(row.episode_id),
      episodeRevision: row.episode_revision,
    });

    const reconcileResult = await applyReconcile(client, prepared, reconcileArgs, reconcileDeps);

    const ok = await finishProcessingTx(client, {
      id: row.id,
      claimedBy: row.claimed_by!,
      claimedAt: row.claimed_at!,
      status: 'done',
      stats: {
        facts_new: reconcileResult.inserted,
        facts_superseded: reconcileResult.superseded,
        facts_flagged: reconcileResult.flagged,
      },
    });
    if (!ok) {
      // Lease perdido (fencing): descarta TUDO (incluindo a invalidação §4.6 e os
      // inserts). O novo dono do claim re-extrai e refaz a TX2 do zero.
      await client.query('ROLLBACK');
      return { inserted: 0, superseded: 0, flagged: 0 };
    }
    await client.query('COMMIT');
    return reconcileResult;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Orquestrador de episódio (spec §5.3): encadeia estágio A (TX1) e estágio B
 * (TX2) — duas transações separadas por design (a memória fresca dos chunks não
 * deve ficar refém da chamada de extração lenta). Re-lê a linha entre estágios
 * para herdar o status `chunked` e o claim vigente.
 *
 * Se o estágio A devolver 0 chunks (lease perdido no fim da TX1), aborta sem
 * tocar o estágio B — não há claim vigente a concluir.
 */
export async function runEpisode(
  row: ProcessingRow,
  deps: StageBDeps
): Promise<ReconcileResult & { chunks: number }> {
  const a = await runStageA(row, { embeddingClient: deps.embeddingClient });
  if (a.chunks === 0) {
    // Estágio A perdeu o lease (ROLLBACK) — nada a concluir no estágio B.
    return { chunks: 0, inserted: 0, superseded: 0, flagged: 0 };
  }

  // Re-lê a linha: status agora `chunked`, claim renovado por runStageA? Não — o
  // estágio A NÃO altera claimed_at (finishProcessingTx zera para NULL ao concluir).
  // Por isso reivindicamos de novo a MESMA linha (chunked é reivindicável) para
  // obter um claim vigente para o estágio B.
  const reclaimed = await pool.query<ProcessingRow>(
    `UPDATE lua_processing
        SET claimed_at = NOW(), claimed_by = $2
      WHERE id = $1 AND status = 'chunked'
      RETURNING *`,
    [row.id, row.claimed_by]
  );
  const chunkedRow = reclaimed.rows[0];
  if (!chunkedRow) {
    // Outro worker já assumiu / status mudou — aborta sem tocar o estágio B.
    return { chunks: a.chunks, inserted: 0, superseded: 0, flagged: 0 };
  }

  const b = await runStageB(chunkedRow, deps);
  return {
    chunks: a.chunks,
    inserted: b.inserted,
    superseded: b.superseded,
    flagged: b.flagged,
  };
}
