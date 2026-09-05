/**
 * src/meetings-summary/service.ts
 *
 * Processa um job da fila de digest: carrega o episódio, chama o LLM, valida e
 * persiste. Molde: src/transcription/service.ts.
 *
 * A DECISÃO de retry mora em `nextJobOutcome`, que é PURA e testável sem banco —
 * é onde ficam os dois achados que a revisão do Codex levantou (JSON truncado
 * confundido com reunião vazia; erro de ambiente confundido com erro de item),
 * e não dá para cobri-los com teste se a decisão estiver diluída no meio do I/O.
 */
import type { SummaryLlm } from './provider.js';
import { summaryCost } from './provider.js';
import { buildSummaryPrompt, parseDigest } from './prompt.js';
import type { DigestParse } from './prompt.js';
import { classifySummaryError } from './error-class.js';
import type { SummaryErrorClass } from './error-class.js';
import {
  loadEpisodeForSummary, finishSummaryJob, closeSummaryJobEmpty,
  rescheduleSummaryJob, failSummaryJob,
} from './db.js';
import { nextJobOutcome } from './retry-policy.js';
export { nextJobOutcome } from './retry-policy.js';
export type { JobOutcome } from './retry-policy.js';
import type { SummaryJob } from './db.js';
import { insertLlmMetric } from '../db.js';

export type SummaryLogger = {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error?: (o: unknown, m?: string) => void;
};

export type ProcessSummaryDeps = {
  llm: SummaryLlm;
  log?: SummaryLogger;
  now?: () => Date;
};

function hoursSince(d: Date, now: Date): number {
  return (now.getTime() - d.getTime()) / 3_600_000;
}

export async function processSummaryJob(deps: ProcessSummaryDeps, job: SummaryJob): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const ageHours = hoursSince(job.created_at, now());

  const ep = await loadEpisodeForSummary(job.episode_id);
  if (!ep) {
    // Episódio sumiu (delete cascata deveria ter levado o job junto). Encerra em
    // vez de girar: não há o que resumir e retentar não traz o episódio de volta.
    await closeSummaryJobEmpty(job.id, 'episódio inexistente');
    return;
  }

  // Revisão mudou entre o claim e agora: um `force` reimportou. A execução atual
  // já nasceu obsoleta — o `force` reenfileirou o job com a revisão nova, então
  // sair aqui sem escrever nada é o correto (e economiza a chamada de LLM).
  if (ep.revision !== job.episode_revision) {
    deps.log?.info(
      { job: job.id, episode: job.episode_id, claimed: job.episode_revision, atual: ep.revision },
      'meeting-summary: revisão mudou desde o claim; descartando execução obsoleta',
    );
    return;
  }

  if (ep.turns.length === 0) {
    await closeSummaryJobEmpty(job.id, 'sem turnos');
    return;
  }

  const { system, user } = buildSummaryPrompt({
    title: ep.title,
    durationSeconds: ep.duration_seconds,
    participants: ep.participants,
    turns: ep.turns,
  });

  const startedAt = Date.now();
  let parse: DigestParse | undefined;
  let finishReason: string | null | undefined;
  let errorClass: SummaryErrorClass | undefined;
  let errorMessage: string | undefined;
  let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;

  try {
    const r = await deps.llm.summarize(system, user);
    parse = parseDigest(r.raw);
    finishReason = r.finishReason;
    usage = r.usage;
  } catch (err) {
    errorMessage = (err as Error).message ?? String(err);
    errorClass = classifySummaryError(err);
  }

  const latencyMs = Date.now() - startedAt;
  const outcome = nextJobOutcome({
    parse, finishReason, errorClass, errorMessage,
    attempts: job.attempts, ageHours, hasTurns: true,
  });

  // Métrica é best-effort e FORA da transação de escrita: perder uma linha de
  // telemetria é aceitável, perder o digest não. Registra inclusive a tentativa
  // que falhou — é justamente ela que interessa num incidente.
  if (usage || errorMessage) {
    insertLlmMetric({
      agent: 'meetings',
      task: 'meeting_summary',
      provider: deps.llm.provider,
      model: deps.llm.model,
      tokens_in: usage?.inputTokens ?? null,
      tokens_out: usage?.outputTokens ?? null,
      cache_read_tokens: usage?.cachedInputTokens ?? null,
      cost_usd: usage ? summaryCost(deps.llm.model, usage) : null,
      latency_ms: latencyMs,
      error: errorMessage ?? null,
    }).catch(() => {});
  }

  switch (outcome.action) {
    case 'save': {
      const saved = await finishSummaryJob({
        jobId: job.id, episodeId: ep.id, revision: job.episode_revision,
        digest: parse!.digest, model: deps.llm.model,
      });
      if (!saved) {
        deps.log?.info(
          { job: job.id, episode: ep.id },
          'meeting-summary: revisão mudou durante a escrita; digest descartado (o job novo assume)',
        );
        return;
      }
      deps.log?.info(
        {
          job: job.id, episode: ep.id, pontos: parse!.digest.points.length,
          tokens: usage?.outputTokens, ms: latencyMs,
        },
        'meeting-summary: digest gerado',
      );
      return;
    }
    case 'close_empty':
      await closeSummaryJobEmpty(job.id, outcome.reason);
      deps.log?.info({ job: job.id, episode: ep.id, motivo: outcome.reason }, 'meeting-summary: encerrado sem digest');
      return;
    case 'retry':
      await rescheduleSummaryJob(job.id, outcome.backoffSec, outcome.reason, outcome.consumeAttempt);
      deps.log?.warn(
        { job: job.id, episode: ep.id, motivo: outcome.reason, backoffSec: outcome.backoffSec, consumiu: outcome.consumeAttempt },
        'meeting-summary: reagendado',
      );
      return;
    case 'fail':
      await failSummaryJob(job.id, outcome.reason);
      deps.log?.warn({ job: job.id, episode: ep.id, motivo: outcome.reason }, 'meeting-summary: desistiu');
      return;
  }
}
