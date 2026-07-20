// Cron diário do import Fireflies (coleta contínua de transcrições — Task 1).
// Espelha o padrão canônico de `src/lua/scheduler.ts`: tick de 60s via
// `setInterval` + flag `running` (não sobrepor ticks), gate por env RE-CHECADO
// a cada tick (iniciar sempre é seguro), hora LOCAL America/Sao_Paulo via
// `localTimeInSaoPaulo()` (importada de lá — não duplicada aqui), claim
// idempotente por DATA via INSERT ... ON CONFLICT DO NOTHING (a inserção É o
// claim, mesmo padrão de `claimNight`/`lua_runs`). Deps injetáveis pra teste:
// `now`, `enabled`, `hour`, `apiKey`, `runImportFn`, `log` — nenhum teste toca
// a rede real do Fireflies nem o clock do processo.

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { localTimeInSaoPaulo } from '../../lua/scheduler.js';
import { runImport, type ImportReport } from '../../cli/import-fireflies.js';
import { FirefliesClient } from './client.js';

const TZ = 'America/Sao_Paulo';

// Overlap de segurança na janela `fromDate` do import incremental: sempre
// re-olha os últimos N dias antes do último episódio fireflies conhecido. O
// dedup em `runImport`/`insertEpisodeWithTurns` torna re-ver barato (early-skip
// antes do R2 — Task 1 item 5); a margem cobre transcrições que terminaram de
// processar no Fireflies depois que o episódio mais recente já foi importado.
const SINCE_OVERLAP_DAYS = 3;

/** Deps injetáveis do tick (produção usa os defaults; testes injetam fakes). */
export interface FirefliesImportTickDeps {
  /** Relógio injetável — default `() => new Date()`. */
  now?: () => Date;
  /** Gate mestre. Default `config.FIREFLIES_IMPORT_ENABLED`. */
  enabled?: boolean;
  /** Hora local (0-23) em que o import roda. Default `config.FIREFLIES_IMPORT_HOUR`. */
  hour?: number;
  /** Chave da API Fireflies. Default `config.FIREFLIES_API_KEY`. */
  apiKey?: string;
  /**
   * Executor do import (produção constrói `FirefliesClient(apiKey)` e chama o
   * `runImport` real). Testes injetam um fake e capturam `fromDate` recebido.
   */
  runImportFn?: (opts: { fromDate?: string }) => Promise<ImportReport>;
  /** Logger opcional (Fastify/pino). */
  log?: FastifyBaseLogger;
}

/** Resultado de um tick — `ran:false` quando o tick foi no-op (gate/janela/claim). */
export type FirefliesImportTickResult =
  | { ran: false; reason: 'disabled' | 'no_api_key' | 'outside_window' | 'already_claimed' }
  | { ran: true; runId: number; report: ImportReport };

/** Reivindica o dia (a INSERÇÃO é o claim). null = já reivindicado por outra réplica/tick. */
async function claimRunDate(runDate: string): Promise<number | null> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fireflies_import_runs (run_date)
     VALUES ($1)
     ON CONFLICT (run_date) DO NOTHING
     RETURNING id`,
    [runDate]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** occurred_at mais recente entre os episódios já importados do Fireflies. null se nenhum ainda. */
async function lastFirefliesOccurredAt(): Promise<Date | null> {
  const { rows } = await pool.query<{ m: Date | null }>(
    `SELECT max(occurred_at) AS m FROM episodes WHERE external_source = 'fireflies'`
  );
  return rows[0]?.m ?? null;
}

/** Stats condensadas do report pra gravar em `fireflies_import_runs.stats` (JSONB). */
function condenseStats(report: ImportReport, durationMs: number): Record<string, unknown> {
  return {
    total_seen: report.total_seen,
    imported: report.imported,
    duplicates: report.duplicates,
    skipped_empty: report.skipped_empty,
    failed: report.failed.length,
    by_method: report.by_method,
    orphans: report.orphans.length,
    no_audio: report.no_audio,
    duration_ms: durationMs,
  };
}

async function finishImportRun(
  id: number,
  status: 'done' | 'failed',
  stats: Record<string, unknown>,
  error?: string | null
): Promise<void> {
  await pool.query(
    `UPDATE fireflies_import_runs
        SET status = $2, stats = $3, error = $4, finished_at = now()
      WHERE id = $1`,
    [id, status, JSON.stringify(stats), error ?? null]
  );
}

/** Executor de produção: constrói o client real e chama o `runImport` real. */
function productionRunImportFn(apiKey: string): (opts: { fromDate?: string }) => Promise<ImportReport> {
  const client = new FirefliesClient(apiKey);
  return (opts) =>
    runImport(client.iterateAll({ fromDate: opts.fromDate }), {
      dryRun: false,
      internalWorkspaceId: config.INTERNAL_WORKSPACE_ID,
    });
}

/**
 * UM tick do cron — toda a lógica testável, separada do wrapper de
 * `setInterval`. Idempotente por dia via claim em `fireflies_import_runs`
 * (INSERT ON CONFLICT). Falha do import é gravada como `failed` (com a
 * mensagem) e RELANÇADA — o wrapper de `setInterval` (igual à Lua) engole via
 * try/catch pra não derrubar o processo.
 */
export async function runFirefliesImportTick(
  deps: FirefliesImportTickDeps = {}
): Promise<FirefliesImportTickResult> {
  const now = deps.now ?? (() => new Date());
  const enabled = deps.enabled ?? config.FIREFLIES_IMPORT_ENABLED;
  const hour = deps.hour ?? config.FIREFLIES_IMPORT_HOUR;
  const apiKey = deps.apiKey ?? config.FIREFLIES_API_KEY;
  const log = deps.log;

  // 1. Master switch.
  if (!enabled) return { ran: false, reason: 'disabled' };

  // 2. Sem chave — nada a fazer (log.warn: startup pode subir sem a env setada).
  if (!apiKey) {
    log?.warn('fireflies-import-cron: FIREFLIES_API_KEY ausente — tick pulado');
    return { ran: false, reason: 'no_api_key' };
  }

  // 3. Hora local explícita (America/Sao_Paulo) — só roda na hora configurada.
  const local = localTimeInSaoPaulo(now());
  if (local.hour !== hour) return { ran: false, reason: 'outside_window' };

  // 4. Claim do dia (a INSERÇÃO é o claim).
  const runId = await claimRunDate(local.date);
  if (runId === null) return { ran: false, reason: 'already_claimed' };

  log?.info({ runId, date: local.date, hour: local.hour }, 'fireflies-import-cron: dia reivindicado');
  const startedMs = Date.now();

  const runImportFn = deps.runImportFn ?? productionRunImportFn(apiKey);

  try {
    // 5. fromDate: overlap de segurança sobre o último episódio fireflies já
    // importado; sem episódio prévio, undefined = histórico completo.
    const lastOccurredAt = await lastFirefliesOccurredAt();
    const fromDate = lastOccurredAt
      ? new Date(lastOccurredAt.getTime() - SINCE_OVERLAP_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    // 6. Roda o import.
    const report = await runImportFn({ fromDate });

    const stats = condenseStats(report, Date.now() - startedMs);
    await finishImportRun(runId, 'done', stats);
    log?.info(stats, 'fireflies-import-cron: dia concluído');

    return { ran: true, runId, report };
  } catch (err) {
    await finishImportRun(
      runId,
      'failed',
      { error: (err as Error).message, duration_ms: Date.now() - startedMs },
      (err as Error).message
    );
    log?.error({ runId, err: (err as Error).message }, 'fireflies-import-cron: dia falhou');
    throw err;
  }
}

/**
 * Inicia o cron: `setInterval` de 60s chamando `runFirefliesImportTick`, com
 * flag `running` pra não sobrepor ticks (um tick pode levar minutos — páginas
 * do Fireflies + upload de áudio no R2). Self-check de
 * FIREFLIES_IMPORT_ENABLED + hora a cada tick => iniciar SEMPRE é seguro
 * (no-op enquanto desligado ou fora da hora configurada). `.unref?.()` pra não
 * segurar o processo vivo só por causa do timer (padrão de
 * `reconcile-trigger.ts`).
 */
export function startFirefliesImportCron(log: FastifyBaseLogger): NodeJS.Timeout {
  log.info(
    {
      enabled: config.FIREFLIES_IMPORT_ENABLED,
      hour: config.FIREFLIES_IMPORT_HOUR,
      tz: TZ,
      hasApiKey: Boolean(config.FIREFLIES_API_KEY),
    },
    'fireflies-import-cron iniciado'
  );
  let running = false;
  const handle = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runFirefliesImportTick({ log });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'fireflies-import-cron: tick falhou');
    } finally {
      running = false;
    }
  }, 60_000);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}
