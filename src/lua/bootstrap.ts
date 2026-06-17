// Bootstrap da Lua (spec §5.5, Task 13). Núcleo testável do CLI `lua:bootstrap`.
//
// `runBootstrap(opts, deps?)`:
//  - abre um run kind='bootstrap';
//  - enfileira os episódios elegíveis (varredura §5.2), opcionalmente escopados
//    por --workspace e limitados por --limit;
//  - --dry-run: para cada elegível (em occurred_at ASC) carrega turnos +
//    chunkTurns + estimateTokens; NÃO chama embeddings/LLM e NÃO grava nada;
//    acumula tokens e imprime/retorna uma estimativa de custo (§5.4);
//  - real: processa as linhas reivindicadas em occurred_at ASC (claimProcessing
//    já ordena), ignorando a janela noturna, com concorrência = LUA_CONCURRENCY
//    (pool simples de N workers puxando claims até a fila drenar), via runEpisode.
//
// A camada de I/O (process.exit, console, getEmbeddingClient/...) vive no CLI
// (`src/cli/lua-bootstrap.ts`); aqui só lógica + DB, para ser testável sem rede.

import { pool } from '../db.js';
import { config } from '../config.js';
import { chunkTurns, estimateTokens, type Turn } from './chunking.js';
import {
  claimProcessing,
  failProcessing,
  startRun,
  finishRun,
  type ProcessingRow,
} from './db.js';
import { runEpisode, type StageBDeps } from './pipeline.js';
import { resetLlmUsage, readLlmUsage, type LlmUsageTotals } from './llm.js';

// ── Tarifas (spec §5.4) — constantes nomeadas. ─────────────────────────────
// Embeddings text-embedding-3-large@1024: $0,13 por 1M tokens (spec §5.4).
const EMBEDDING_USD_PER_M = 0.13;
// Extração Sonnet: $3/1M tokens de entrada, $15/1M de saída (spec §5.4).
const EXTRACTION_IN_USD_PER_M = 3;
const EXTRACTION_OUT_USD_PER_M = 15;
// Heurística documentada: a estimativa de dry-run modela a saída da extração
// como ~10% dos tokens de entrada (a spec §5.4 estima ~150k out p/ ~1,3M in ≈ 11%).
const EXTRACTION_OUTPUT_RATIO = 0.1;

export type BootstrapOpts = {
  dryRun?: boolean;
  limit?: number;
  workspaceId?: string;
};

export type BootstrapEpisodeStat = {
  episodeId: number;
  workspaceId: string | null;
  occurredAt: string;
  chunks: number;
  tokens: number;
};

export type BootstrapReport = {
  dryRun: boolean;
  runId: number | null;
  enqueued: number;
  episodesSeen: number;
  episodes: BootstrapEpisodeStat[];
  totalChunks: number;
  totalTokens: number;
  // Custos estimados em USD (preenchidos no --dry-run; 0 no real, que usa stats reais).
  estEmbeddingsUsd: number;
  estExtractionUsd: number;
  // Caminho real:
  processed: number;
  failed: number;
  factsNew: number;
  factsSuperseded: number;
  factsFlagged: number;
  // Custo REAL medido (Anthropic) no caminho real — undefined no --dry-run.
  usage?: LlmUsageTotals;
};

type EligibleRow = {
  episode_id: number;
  workspace_id: string | null;
  occurred_at: Date;
};

/** Nome do falante: nome humano > label > `Falante <turn_index>` (espelha pipeline.ts). */
function speakerOf(r: { speaker_name: string | null; speaker_label: string | null; turn_index: number }): string {
  const name = r.speaker_name?.trim();
  if (name) return name;
  const label = r.speaker_label?.trim();
  if (label) return label;
  return `Falante ${r.turn_index}`;
}

/**
 * Enfileira os episódios elegíveis (varredura §5.2), opcionalmente escopados por
 * workspace e/ou limitados — espelha `enqueueEligibleEpisodes` mas com os filtros
 * do bootstrap. Escopar no ENQUEUE (e não no claim) mantém o pool simples: nenhum
 * episódio fora do escopo entra na fila, então o claim global nunca pega um
 * estranho. ON CONFLICT DO NOTHING absorve corrida/re-run. Retorna a contagem
 * inserida. Sem filtros, é equivalente a `enqueueEligibleEpisodes()`.
 */
async function enqueueScoped(opts: BootstrapOpts): Promise<number> {
  const params: unknown[] = [];
  const conds: string[] = ['e.workspace_id IS NOT NULL', 'p.id IS NULL'];
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    conds.push(`e.workspace_id = $${params.length}`);
  }
  let limitSql = '';
  if (opts.limit != null) {
    params.push(opts.limit);
    limitSql = `LIMIT $${params.length}`;
  }
  // Subquery com LIMIT + occurred_at ASC para o --limit pegar os mais antigos.
  const { rowCount } = await pool.query(
    `INSERT INTO lua_processing (episode_id, episode_revision)
     SELECT episode_id, revision FROM (
       SELECT e.id AS episode_id, e.revision
         FROM episodes e
         LEFT JOIN lua_processing p
           ON p.episode_id = e.id AND p.episode_revision = e.revision
        WHERE ${conds.join(' AND ')}
        ORDER BY e.occurred_at ASC, e.id ASC
        ${limitSql}
     ) sel
     ON CONFLICT DO NOTHING`,
    params
  );
  return rowCount ?? 0;
}

/**
 * Episódios elegíveis (workspace_id NÃO nulo) na revision corrente, em
 * occurred_at ASC (spec §5.3). Escopa por workspace e aplica limit quando dados.
 * Usado no --dry-run para varrer sem reivindicar/gravar.
 */
async function listEligible(opts: BootstrapOpts): Promise<EligibleRow[]> {
  const params: unknown[] = [];
  const conds: string[] = ['e.workspace_id IS NOT NULL'];
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    conds.push(`e.workspace_id = $${params.length}`);
  }
  let limitSql = '';
  if (opts.limit != null) {
    params.push(opts.limit);
    limitSql = `LIMIT $${params.length}`;
  }
  const { rows } = await pool.query<{ id: string; workspace_id: string | null; occurred_at: Date }>(
    `SELECT e.id, e.workspace_id, e.occurred_at
       FROM episodes e
      WHERE ${conds.join(' AND ')}
      ORDER BY e.occurred_at ASC, e.id ASC
      ${limitSql}`,
    params
  );
  return rows.map((r) => ({
    episode_id: Number(r.id),
    workspace_id: r.workspace_id,
    occurred_at: r.occurred_at,
  }));
}

/** Carrega turnos de um episódio em ordem turn_index ASC (mapeados p/ o chunker). */
async function loadTurns(episodeId: number): Promise<Turn[]> {
  const { rows } = await pool.query<{
    turn_index: number;
    speaker_name: string | null;
    speaker_label: string | null;
    text: string;
  }>(
    `SELECT turn_index, speaker_name, speaker_label, text
       FROM episode_turns
      WHERE episode_id = $1
      ORDER BY turn_index ASC`,
    [episodeId]
  );
  return rows.map((r) => ({ turn_index: r.turn_index, speaker: speakerOf(r), text: r.text }));
}

function emptyReport(dryRun: boolean): BootstrapReport {
  return {
    dryRun,
    runId: null,
    enqueued: 0,
    episodesSeen: 0,
    episodes: [],
    totalChunks: 0,
    totalTokens: 0,
    estEmbeddingsUsd: 0,
    estExtractionUsd: 0,
    processed: 0,
    failed: 0,
    factsNew: 0,
    factsSuperseded: 0,
    factsFlagged: 0,
  };
}

/**
 * Núcleo do bootstrap. `deps` (clientes injetáveis) só é exigido no caminho real;
 * o --dry-run nunca os toca. Sempre abre e fecha um run kind='bootstrap' (com a
 * data de hoje) — mesmo em dry-run, para deixar rastro do que foi varrido.
 */
export async function runBootstrap(
  opts: BootstrapOpts,
  deps?: StageBDeps
): Promise<BootstrapReport> {
  const dryRun = opts.dryRun ?? false;
  const report = emptyReport(dryRun);
  const today = new Date().toISOString().slice(0, 10);
  const runId = await startRun('bootstrap', today);
  report.runId = runId;

  try {
    if (dryRun) {
      // Varredura sem reivindicar nem gravar: só dimensiona custo (§5.4).
      const eligible = await listEligible(opts);
      report.episodesSeen = eligible.length;
      for (const ep of eligible) {
        const turns = await loadTurns(ep.episode_id);
        const chunks = chunkTurns(turns);
        const tokens = chunks.reduce((acc, c) => acc + c.tokenCount, 0);
        report.totalChunks += chunks.length;
        report.totalTokens += tokens;
        report.episodes.push({
          episodeId: ep.episode_id,
          workspaceId: ep.workspace_id,
          occurredAt: ep.occurred_at.toISOString(),
          chunks: chunks.length,
          tokens,
        });
      }
      // Estimativa de custo (§5.4). Entrada da extração ≈ tokens dos chunks
      // (transcrição); saída modelada como EXTRACTION_OUTPUT_RATIO da entrada.
      report.estEmbeddingsUsd = (report.totalTokens / 1_000_000) * EMBEDDING_USD_PER_M;
      const extInUsd = (report.totalTokens / 1_000_000) * EXTRACTION_IN_USD_PER_M;
      const extOutUsd =
        ((report.totalTokens * EXTRACTION_OUTPUT_RATIO) / 1_000_000) * EXTRACTION_OUT_USD_PER_M;
      report.estExtractionUsd = extInUsd + extOutUsd;

      await finishRun(runId!, 'done', {
        mode: 'dry_run',
        episodes: report.episodesSeen,
        chunks: report.totalChunks,
        tokens: report.totalTokens,
        est_embeddings_usd: report.estEmbeddingsUsd,
        est_extraction_usd: report.estExtractionUsd,
      });
      return report;
    }

    // ── Caminho real ────────────────────────────────────────────────────────
    if (!deps) throw new Error('runBootstrap real exige deps (embeddingClient/llmClient/judge)');

    // Escopo (--workspace/--limit) é aplicado no ENQUEUE: só os episódios certos
    // entram na fila, então o claim global nunca pega um estranho.
    report.enqueued = await enqueueScoped(opts);

    // Zera o meter de custo antes do run (mede só este bootstrap).
    resetLlmUsage();

    // Pool de N workers (default LUA_CONCURRENCY) puxando claims de 1 em 1 até a
    // fila drenar. claimProcessing já ordena por occurred_at ASC (§5.3); com
    // batch=1 cada worker pega sempre o episódio devido mais antigo disponível,
    // ignorando a janela noturna (o bootstrap roda fora dela por design).
    const concurrency = Math.max(1, config.LUA_CONCURRENCY);
    let processed = 0;
    let failed = 0;

    const worker = async (workerId: string): Promise<void> => {
      for (;;) {
        const claimed = await claimProcessing(workerId, 1);
        if (claimed.length === 0) return; // fila drenou
        const row: ProcessingRow = claimed[0]!;
        try {
          const res = await runEpisode(row, deps);
          report.factsNew += res.inserted;
          report.factsSuperseded += res.superseded;
          report.factsFlagged += res.flagged;
          processed++;
          report.episodes.push({
            episodeId: row.episode_id,
            workspaceId: opts.workspaceId ?? null,
            occurredAt: '',
            chunks: res.chunks,
            tokens: 0,
          });
        } catch (err) {
          // Falha NÃO pode ser silenciosa (run pago): registra erro + agenda
          // retry com backoff (failProcessing → last_error / attempt_count / dead
          // no teto). Sem isto a linha ficava 'chunked' com claimed_at preso e o
          // erro sumia (descoberto no sample de 10, ep187).
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          try {
            const { dead } = await failProcessing(row.id, msg);
            console.error(`[bootstrap] episódio ${row.episode_id} falhou${dead ? ' (DEAD)' : ''}: ${msg}`);
          } catch (markErr) {
            console.error(
              `[bootstrap] episódio ${row.episode_id} falhou e o registro da falha também falhou: ${msg} / ${
                markErr instanceof Error ? markErr.message : String(markErr)
              }`
            );
          }
        }
      }
    };

    const workers = Array.from({ length: concurrency }, (_, i) => worker(`bootstrap-${i}`));
    await Promise.all(workers);

    report.processed = processed;
    report.failed = failed;
    report.episodesSeen = processed + failed;
    report.usage = readLlmUsage();

    await finishRun(runId!, failed > 0 ? 'failed' : 'done', {
      mode: 'real',
      enqueued: report.enqueued,
      processed,
      failed,
      facts_new: report.factsNew,
      facts_superseded: report.factsSuperseded,
      facts_flagged: report.factsFlagged,
    });
    return report;
  } catch (err) {
    if (runId != null) {
      await finishRun(runId, 'failed', { error: (err as Error).message }, (err as Error).message);
    }
    throw err;
  }
}
