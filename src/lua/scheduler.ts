// Scheduler noturno da Lua (spec Lua v1 §5.1, §5.3-C, §12). Espelha o padrao
// dos pollers do worker (`src/events/dispatcher.ts`): `setInterval` com flag
// `running` para nao sobrepor ticks. NAO usa lib de cron — o worker nao tem uma.
//
// Cada tick (runNightlyTick):
//  1. master switch LUA_ENABLED off -> no-op (nada roda sem o gate de eval + OK).
//  2. hora LOCAL America/Sao_Paulo computada EXPLICITAMENTE (o container pode
//     estar em UTC) via Intl.DateTimeFormat — nunca a TZ do processo.
//  3. fora da janela [LUA_WINDOW_START, LUA_WINDOW_END) -> no-op.
//  4. claimNight(data local): INSERT ... ON CONFLICT (a insercao E o claim da
//     noite). null => ja reivindicada por outra replica/tick -> no-op.
//  5. drena a fila de episodios (markStaleRevisions -> enqueueEligibleEpisodes ->
//     pool de LUA_CONCURRENCY workers via claimProcessing+runEpisode), com
//     HARD STOP no fim da janela (re-checa a hora local a cada claim; o que sobra
//     fica `pending` pra proxima noite — backlog e metrica de tripwire §12).
//  6. estagio C: status nightly (workspaces com mudanca) + (seg local) recap +
//     proposta de conduta dom->seg.
//  7. finishRun com stats (processed/failed/facts_*/recaps/condutas/backlog/dur).
//
// Clock e deps sao INJETAVEIS: testes passam `now` fixo e fakes de pipeline/
// narrativa/conduta — nunca tocam a rede. Em producao usa os clientes reais.

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import {
  claimNight,
  markStaleRevisions,
  enqueueEligibleEpisodes,
  claimProcessing,
  failProcessing,
  finishRun,
  getWorkspacesChangedInRun,
  type ProcessingRow,
} from './db.js';
import { runEpisode, type StageBDeps } from './pipeline.js';
import { generateStatus, generateRecap } from './narrativa.js';
import { proposeConduta, type CreateApprovalTask } from './condutas.js';
import type { LlmClient } from './llm.js';
import type { EmbeddingClient } from './embeddings.js';
import { getEmbeddingClient } from './embedding-provider.js';
import { getExtractionClient, getJudgeClient, getRecapClient } from './llm-provider.js';
import { createApprovalTask as realCreateApprovalTask } from '../bloquim/approval.js';

const TZ = 'America/Sao_Paulo';

/** Hora local + dia-da-semana + data local (YYYY-MM-DD) em America/Sao_Paulo. */
export type LocalTime = {
  /** Hora 0-23 no fuso America/Sao_Paulo. */
  hour: number;
  /** 1=segunda ... 7=domingo (ISO), no fuso America/Sao_Paulo. */
  isoWeekday: number;
  /** Data local YYYY-MM-DD no fuso America/Sao_Paulo. */
  date: string;
};

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

/**
 * Converte um instante (Date UTC) para a hora/dia/data LOCAIS em
 * America/Sao_Paulo, SEM depender da TZ do processo (o container roda UTC). Usa
 * Intl.DateTimeFormat com timeZone explicito; lê os `parts` (mais robusto que
 * parsear uma string formatada). `hour: '2-digit', hour12: false` produz '00'..'23'
 * (o '24' de meia-noite e normalizado para 0).
 */
export function localTimeInSaoPaulo(now: Date): LocalTime {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // Intl pode emitir '24' para meia-noite
  const weekday = get('weekday'); // 'Mon'..'Sun'
  return {
    hour,
    isoWeekday: WEEKDAY_TO_ISO[weekday] ?? 0,
    date: `${year}-${month}-${day}`, // en-CA => YYYY-MM-DD
  };
}

/** Dependencias injetaveis do tick (clientes reais em prod, fakes nos testes). */
export interface NightlyTickDeps {
  /** Relogio injetavel — default `() => new Date()`. */
  now?: () => Date;
  /** Deps do pipeline por episodio (embeddings/extracao/judge). */
  stage?: StageBDeps;
  /** LLM da narradora (status + recap). */
  recapLlm?: LlmClient;
  /** Portao Bloquim para a proposta de conduta. */
  createApprovalTask?: CreateApprovalTask;
  /**
   * Gate mestre. Default `config.LUA_ENABLED`. Parametrizavel para o teste poder
   * exercer o caminho desligado sem reparsear a config (que e eager).
   */
  enabled?: boolean;
  /** Logger opcional (Fastify/pino). */
  log?: FastifyBaseLogger;
}

/** Resultado de um tick — `ran:false` quando o tick foi no-op (gate/janela/claim). */
export type NightlyTickResult = {
  ran: boolean;
  reason?: 'disabled' | 'outside_window' | 'already_claimed';
  runId?: number;
  processed?: number;
  failed?: number;
  factsNew?: number;
  factsSuperseded?: number;
  factsFlagged?: number;
  statuses?: number;
  recaps?: number;
  condutas?: number;
  /** Episodios que sobraram `pending` ao bater o hard stop (tripwire §12). */
  backlog?: number;
};

/**
 * Resolve as deps reais para o tick de PRODUCAO (sem `now`/`enabled` — esses
 * usam os defaults). Construir os clientes NAO faz chamada de rede.
 */
function productionDeps(log?: FastifyBaseLogger): Required<Pick<NightlyTickDeps, 'stage' | 'recapLlm' | 'createApprovalTask'>> & { log?: FastifyBaseLogger } {
  const embeddingClient: EmbeddingClient = getEmbeddingClient();
  return {
    stage: {
      llmClient: getExtractionClient(),
      embeddingClient,
      judge: getJudgeClient(),
    },
    recapLlm: getRecapClient(),
    createApprovalTask: realCreateApprovalTask,
    log,
  };
}

/**
 * Conta episodios ainda pendentes (nao terminados) na fila — o backlog ao fim da
 * janela (spec §12: >0 em duas noites seguidas = tripwire). `pending`/`chunked`/
 * `failed` ainda podem rodar; `done`/`dead`/`skipped` sao terminais.
 */
async function countBacklog(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM lua_processing
      WHERE status IN ('pending', 'chunked', 'failed')`
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Drena a fila de episodios com um pool de N workers (default LUA_CONCURRENCY),
 * espelhando o bootstrap — porem com HARD STOP na janela: antes de CADA claim o
 * worker re-checa a hora local; se ja saiu da janela, para (o claim devolvido
 * fica `pending` pra proxima noite). Falha de runEpisode -> failProcessing
 * (backoff/dead, §5.2). Retorna stats agregadas.
 */
async function drainQueue(
  deps: StageBDeps,
  now: () => Date,
  windowEnd: number,
  log?: FastifyBaseLogger
): Promise<{ processed: number; failed: number; factsNew: number; factsSuperseded: number; factsFlagged: number }> {
  const concurrency = Math.max(1, config.LUA_CONCURRENCY);
  let processed = 0;
  let failed = 0;
  let factsNew = 0;
  let factsSuperseded = 0;
  let factsFlagged = 0;

  const inWindow = (): boolean => localTimeInSaoPaulo(now()).hour < windowEnd;

  const worker = async (workerId: string): Promise<void> => {
    for (;;) {
      // HARD STOP: re-checa a janela ANTES de reivindicar o proximo episodio.
      if (!inWindow()) return;
      const claimed = await claimProcessing(workerId, 1);
      if (claimed.length === 0) return; // fila drenou
      const row: ProcessingRow = claimed[0]!;
      try {
        const res = await runEpisode(row, deps);
        factsNew += res.inserted;
        factsSuperseded += res.superseded;
        factsFlagged += res.flagged;
        processed++;
      } catch (err) {
        failed++;
        // Backoff/dead (libera o lease) — a noite seguinte drena o que falhar.
        await failProcessing(row.id, (err as Error).message).catch(() => undefined);
        log?.warn({ episode: row.episode_id, err: (err as Error).message }, 'lua: episodio falhou');
      }
    }
  };

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(`nightly-${i}`))
  );

  return { processed, failed, factsNew, factsSuperseded, factsFlagged };
}

/**
 * Estagio C (spec §5.3-C / §10): derivados DEPOIS da fila de episodios (memoria
 * fresca primeiro).
 *  - TODA noite: status nightly para cada workspace com mudanca de memoria.
 *  - Noite de DOMINGO->SEGUNDA (segunda local): recap semanal + proposta de
 *    conduta para cada workspace com atividade na semana ISO anterior.
 * Erros por-workspace nao abortam o estagio (allSettled) — um workspace ruim
 * nao pode derrubar os demais derivados da noite.
 */
async function runStageC(
  runId: number,
  local: LocalTime,
  deps: { recapLlm: LlmClient; createApprovalTask: CreateApprovalTask },
  log?: FastifyBaseLogger
): Promise<{ statuses: number; recaps: number; condutas: number }> {
  let statuses = 0;
  let recaps = 0;
  let condutas = 0;

  // Status nightly — workspaces tocados nesta noite.
  const changed = await getWorkspacesChangedInRun(runId);
  const statusResults = await Promise.allSettled(
    changed.map((ws) => generateStatus(ws, { llm: deps.recapLlm, runId }))
  );
  for (const r of statusResults) {
    if (r.status === 'fulfilled' && r.value !== null) statuses++;
    else if (r.status === 'rejected') log?.warn({ err: String(r.reason) }, 'lua: status nightly falhou');
  }

  // Recap + conduta: so na noite dom->seg (segunda LOCAL = isoWeekday 1).
  if (local.isoWeekday === 1) {
    // Semana ISO ANTERIOR (a que fechou no domingo): a noite dom->seg roda na
    // madrugada de segunda LOCAL, entao a semana a narrar termina no domingo
    // anterior. Derivado da DATA LOCAL (local.date), nunca de `new Date()` —
    // o clock e injetado e o container roda UTC.
    const { start, end } = prevWeekFromLocalMonday(local.date);
    // Universo de workspaces ativos = os tocados na semana (reusa o gate de
    // atividade interno de generateRecap/proposeConduta: cada um decide se gera
    // ou retorna null). Para escolher os candidatos, varremos os workspaces com
    // episodio ou fato na janela.
    const candidates = await workspacesActiveInWeek(start, end);

    const recapResults = await Promise.allSettled(
      candidates.map((ws) => generateRecap(ws, { start, end }, { llm: deps.recapLlm, runId }))
    );
    for (const r of recapResults) {
      if (r.status === 'fulfilled' && r.value !== null) recaps++;
      else if (r.status === 'rejected') log?.warn({ err: String(r.reason) }, 'lua: recap falhou');
    }

    const condutaResults = await Promise.allSettled(
      candidates.map((ws) =>
        proposeConduta(ws, { llm: deps.recapLlm, createApprovalTask: deps.createApprovalTask, runId })
      )
    );
    for (const r of condutaResults) {
      if (r.status === 'fulfilled' && r.value !== null) condutas++;
      else if (r.status === 'rejected') log?.warn({ err: String(r.reason) }, 'lua: proposta de conduta falhou');
    }
  }

  return { statuses, recaps, condutas };
}

/** Soma N dias a uma data YYYY-MM-DD (UTC, sem horario). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Janela [segunda, domingo] da semana ISO ANTERIOR a uma segunda-feira local
 * (a noite dom->seg roda na madrugada de segunda; a semana a narrar e a que
 * acabou de fechar no domingo). `localMonday` = YYYY-MM-DD de uma segunda.
 * Retorna start = localMonday - 7 dias (segunda anterior), end = localMonday - 1
 * (domingo anterior).
 */
function prevWeekFromLocalMonday(localMonday: string): { start: string; end: string } {
  return { start: addDays(localMonday, -7), end: addDays(localMonday, -1) };
}

/**
 * Workspaces com atividade na janela [start, end] (episodio na semana OU fato
 * novo/invalidado) — universo de candidatos para recap + conduta dominicais.
 * O gate fino (sem ruido) vive em generateRecap/proposeConduta; aqui so a lista.
 */
async function workspacesActiveInWeek(start: string, end: string): Promise<string[]> {
  const { rows } = await pool.query<{ ws: string }>(
    `SELECT DISTINCT ws FROM (
       SELECT workspace_id AS ws FROM episodes
        WHERE workspace_id IS NOT NULL
          AND occurred_at >= $1::date
          AND occurred_at < ($2::date + INTERVAL '1 day')
       UNION
       SELECT workspace_id AS ws FROM facts
        WHERE (valid_at >= $1::date AND valid_at < ($2::date + INTERVAL '1 day'))
           OR (invalid_at >= $1::date AND invalid_at < ($2::date + INTERVAL '1 day'))
     ) t
      WHERE ws IS NOT NULL
      ORDER BY ws`,
    [start, end]
  );
  return rows.map((r) => r.ws);
}

/**
 * UM tick do scheduler — toda a logica testavel, separada do wrapper de
 * `setInterval`. Idempotente por noite via claimNight (INSERT ON CONFLICT).
 */
export async function runNightlyTick(
  deps: NightlyTickDeps = {}
): Promise<NightlyTickResult> {
  const now = deps.now ?? (() => new Date());
  const enabled = deps.enabled ?? config.LUA_ENABLED;
  const log = deps.log;

  // 1. Master switch.
  if (!enabled) return { ran: false, reason: 'disabled' };

  // 2. Hora local explicita (America/Sao_Paulo).
  const local = localTimeInSaoPaulo(now());

  // 3. Janela [start, end).
  if (local.hour < config.LUA_WINDOW_START || local.hour >= config.LUA_WINDOW_END) {
    return { ran: false, reason: 'outside_window' };
  }

  // 4. Claim da noite (a INSERCAO e o claim).
  const runId = await claimNight(local.date);
  if (runId === null) return { ran: false, reason: 'already_claimed' };

  log?.info({ runId, date: local.date, hour: local.hour }, 'lua: noite reivindicada');
  const startedMs = Date.now();

  try {
    // Resolve deps reais se nao injetadas (caminho de producao) — uma so vez.
    const needsRealDeps = !deps.stage || !deps.recapLlm || !deps.createApprovalTask;
    const real = needsRealDeps ? productionDeps(log) : null;
    const stage = deps.stage ?? real!.stage;
    const recapLlm = deps.recapLlm ?? real!.recapLlm;
    const createApprovalTask = deps.createApprovalTask ?? real!.createApprovalTask;

    // 5. Fila de episodios — manutencao + enqueue + drain com hard stop.
    await markStaleRevisions();
    await enqueueEligibleEpisodes();
    const drained = await drainQueue(stage, now, config.LUA_WINDOW_END, log);

    // 6. Estagio C — derivados (status nightly; dom->seg recap + conduta).
    const c = await runStageC(runId, local, { recapLlm, createApprovalTask }, log);

    // Backlog ao fim da janela (tripwire §12).
    const backlog = await countBacklog();

    const stats = {
      episodes_processed: drained.processed,
      episodes_failed: drained.failed,
      facts_new: drained.factsNew,
      facts_superseded: drained.factsSuperseded,
      facts_flagged: drained.factsFlagged,
      statuses: c.statuses,
      recaps: c.recaps,
      condutas_proposed: c.condutas,
      backlog,
      duration_ms: Date.now() - startedMs,
    };
    await finishRun(runId, drained.failed > 0 ? 'failed' : 'done', stats);
    log?.info(stats, 'lua: noite concluida');

    return {
      ran: true,
      runId,
      processed: drained.processed,
      failed: drained.failed,
      factsNew: drained.factsNew,
      factsSuperseded: drained.factsSuperseded,
      factsFlagged: drained.factsFlagged,
      statuses: c.statuses,
      recaps: c.recaps,
      condutas: c.condutas,
      backlog,
    };
  } catch (err) {
    await finishRun(runId, 'failed', { error: (err as Error).message, duration_ms: Date.now() - startedMs }, (err as Error).message);
    log?.error({ runId, err: (err as Error).message }, 'lua: noite falhou');
    throw err;
  }
}

/**
 * Inicia o scheduler noturno: `setInterval` de 60s chamando `runNightlyTick`,
 * com flag `running` para nao sobrepor ticks (um tick pode durar a janela
 * inteira). Self-check do gate/janela a cada tick => iniciar SEMPRE e seguro
 * (no-op enquanto LUA_ENABLED=false ou fora da janela). Retorna o handle do
 * timer (igual aos demais pollers, ex.: dispatcher).
 */
export function startLuaScheduler(log: FastifyBaseLogger): NodeJS.Timeout {
  log.info(
    { enabled: config.LUA_ENABLED, window: [config.LUA_WINDOW_START, config.LUA_WINDOW_END], tz: TZ },
    'lua scheduler iniciado'
  );
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runNightlyTick({ log });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'lua: tick falhou');
    } finally {
      running = false;
    }
  }, 60_000);
}
