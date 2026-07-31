/**
 * src/whatsapp/ai-pattern-runner.ts
 *
 * CRM WhatsApp v3 — Fase E, Task E3: RUNNER SEMANAL do motor de IA nível 2
 * (análise de padrões — spec v3 §8). Orquestra, por workspace com IA habilitada:
 *   claim da semana anterior (E1, whatsapp_ai_pattern_runs) → contexto (E2,
 *   buildPatternContext) → prompt (E2, buildPatternPrompt) → LLM (D5, JudgmentLlm.judge,
 *   prompt maior, MESMA interface) → validação (E2, parsePatternDecision) → aplicação
 *   (E3, applyPatternDecision) → finish/fail da run + custo em llm_metrics.
 *
 * SCHEDULING: setInterval HORÁRIO + gate de janela DOMINGO 04:00–05:00 BRT (pós-julgamento
 * diário, que roda 03:00–04:00). A idempotência vem do UNIQUE (workspace_id, period_start)
 * de whatsapp_ai_pattern_runs (o CLAIM, E1): rodar 2x na janela é inócuo — a 2ª tentativa
 * não re-processa a mesma semana ('running'/'done' bloqueiam; 'failed' é retomável).
 *
 * PERÍODO determinístico: a SEMANA ANTERIOR completa (segunda 00:00 → domingo 23:59 BRT),
 * calculada em BRT (previousCompleteWeek). Determinístico = a chave do claim é estável
 * (todas as réplicas/ticks da janela calculam o mesmo period_start).
 *
 * PROVIDER LLM injetado (construído na borda com CRM_AI_PATTERN_MODEL); o custo entra em
 * llm_metrics com agent='crm-ai-pattern', task='analyze'. Best-effort por workspace: a
 * falha de um não aborta os demais.
 */
import type { Pool } from 'pg';
import {
  claimPatternRun,
  finishPatternRun,
  failPatternRun,
  persistPatternDecision,
  getPatternRunOutput,
  fetchFailedPatternRuns,
  type FailedPatternRun,
} from './ai-pattern-store.js';
import { buildPatternContext } from './ai-pattern-context.js';
import { buildPatternPrompt, parsePatternDecision, type PatternDecision } from './ai-pattern-prompt.js';
import { applyPatternDecision } from './ai-pattern-apply.js';
import { judgmentCost, type JudgmentLlm } from './ai-llm.js';
import { fetchAiWorkspaces, resolveTickIntervalMs, saoPauloHour } from './ai-judgment-runner.js';

/** Default de runs 'failed' antigas retomadas por workspace num sweep (BLOQUEADOR 2). */
const DEFAULT_MAX_FAILED_RESUME = 2;

/** Matéria-prima mínima: sem ao menos N julgamentos na semana, não há padrão a extrair. */
const MIN_JUDGMENTS = 5;

// Janela de execução [04:00, 05:00) BRT no DOMINGO — depois do julgamento diário (03:00–04:00).
const WINDOW_START_HOUR = 4;
const WINDOW_END_HOUR = 5;
const DAY_MS = 86_400_000;

/** Partes da data em America/Sao_Paulo (calendário BRT) via Intl — DST-safe. */
function saoPauloYmd(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** 'YYYY-MM-DD' de um timestamp UTC (usado só sobre âncoras de meia-noite UTC). */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** Dia da semana (0=domingo..6=sábado) da data de calendário BRT de `now`. */
export function saoPauloWeekday(now: Date): number {
  const { year, month, day } = saoPauloYmd(now);
  // A data de calendário y/m/d mapeia pra um dia-da-semana fixo; getUTCDay sobre a âncora
  // de meia-noite UTC devolve esse dia sem depender do TZ do runtime.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Semana ANTERIOR completa (segunda→domingo) relativa à data BRT de `now`, como DATEs
 * ('YYYY-MM-DD'). A semana que CONTÉM `now` é [segunda desta semana, domingo]; a anterior
 * é 7 dias antes. Aritmética em ms UTC sobre a âncora de calendário (dia = 86.4M ms, sem
 * DST em UTC) — determinístico pro claim.
 */
export function previousCompleteWeek(now: Date): { periodStart: string; periodEnd: string } {
  const { year, month, day } = saoPauloYmd(now);
  const anchor = Date.UTC(year, month - 1, day);
  const weekday = new Date(anchor).getUTCDay();     // 0=dom..6=sáb
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1; // segunda desta semana
  const thisMonday = anchor - daysFromMonday * DAY_MS;
  const prevMonday = thisMonday - 7 * DAY_MS;
  const prevSunday = prevMonday + 6 * DAY_MS;
  return { periodStart: fmtDate(prevMonday), periodEnd: fmtDate(prevSunday) };
}

/** periodEnd = periodStart + 6 dias (usado pelo CLI quando o operador passa --period-start). */
export function weekFromStart(periodStart: string): { periodStart: string; periodEnd: string } {
  const parts = periodStart.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const dd = Number(parts[2]);
  const start = Date.UTC(y, m - 1, dd);
  return { periodStart, periodEnd: fmtDate(start + 6 * DAY_MS) };
}

/** true sse `now` cai em DOMINGO [04:00, 05:00) BRT. */
export function isWithinPatternWindow(now: Date): boolean {
  const h = saoPauloHour(now);
  return saoPauloWeekday(now) === 0 && h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

/** Registra o custo de UMA chamada LLM do nível 2 (agent='crm-ai-pattern', task='analyze'). */
export async function recordPatternLlmMetrics(
  pool: Pool,
  args: { provider: string; model: string; usage: { inputTokens: number; outputTokens: number }; costUsd: number },
): Promise<void> {
  await pool.query(
    `/* pat:llm_metrics */ INSERT INTO llm_metrics
       (agent, task, provider, model, tokens_in, tokens_out, cost_usd)
     VALUES ('crm-ai-pattern', 'analyze', $1, $2, $3, $4, $5)`,
    [args.provider, args.model, args.usage.inputTokens, args.usage.outputTokens, args.costUsd],
  );
}

export type PatternRunStatus = 'skipped_claim' | 'skipped_no_materia' | 'invalid' | 'applied' | 'failed';

export interface PatternRunOutcome {
  status: PatternRunStatus;
  runId?: number;
  applied?: string[];
  skipped?: string[];
}

/** Colaboradores injetáveis (default = funções reais); testes injetam spies/fakes. */
export interface RunPatternDeps {
  claimRun?: typeof claimPatternRun;
  buildContext?: typeof buildPatternContext;
  buildPrompt?: typeof buildPatternPrompt;
  parseDecision?: typeof parsePatternDecision;
  applyDecision?: typeof applyPatternDecision;
  finishRun?: typeof finishPatternRun;
  failRun?: typeof failPatternRun;
  persistDecision?: typeof persistPatternDecision;
  getRunOutput?: typeof getPatternRunOutput;
  recordMetrics?: typeof recordPatternLlmMetrics;
  /** Relógio injetável (default new Date().toISOString()) — o prompt precisa do "agora". */
  now?: () => string;
  /** Piso de julgamentos pra rodar (default MIN_JUDGMENTS) — knob de teste. */
  minJudgments?: number;
}

/**
 * Processa UM workspace numa janela fixa. Fluxo (spec §8):
 *   claim (null → skip) → contexto → (judgments < N → finish {skipped:'sem_materia'}) →
 *   prompt → LLM → custo (SEMPRE, mesmo em decisão inválida) → parse →
 *     inválida → finish {invalid:true,error} (a run ACONTECEU; sem retry infinito) ·
 *     válida  → apply → finish {decision, applied, skipped}.
 * Erro HARD (LLM down / apply throw) → fail (retomável na próxima semana via claim) + warn.
 */
export async function runPatternForWorkspace(
  pool: Pool,
  provider: JudgmentLlm,
  target: { workspaceId: string; periodStart: string; periodEnd: string },
  deps: RunPatternDeps = {},
): Promise<PatternRunOutcome> {
  const claimRun = deps.claimRun ?? claimPatternRun;
  const buildContext = deps.buildContext ?? buildPatternContext;
  const buildPrompt = deps.buildPrompt ?? buildPatternPrompt;
  const parseDecision = deps.parseDecision ?? parsePatternDecision;
  const applyDecision = deps.applyDecision ?? applyPatternDecision;
  const finishRun = deps.finishRun ?? finishPatternRun;
  const failRun = deps.failRun ?? failPatternRun;
  const persistDecision = deps.persistDecision ?? persistPatternDecision;
  const getRunOutput = deps.getRunOutput ?? getPatternRunOutput;
  const recordMetrics = deps.recordMetrics ?? recordPatternLlmMetrics;
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const minJudgments = deps.minJudgments ?? MIN_JUDGMENTS;

  const claim = await claimRun(pool, target.workspaceId, target.periodStart, target.periodEnd);
  if (claim == null) {
    // Semana já 'running' por outra réplica/tick, ou já 'done'. Nada a fazer.
    return { status: 'skipped_claim' };
  }
  const runId = claim.runId;

  try {
    // ── RETOMADA IDEMPOTENTE (BLOQUEADOR 1): se a run retomada de 'failed' já tem a
    // decisão persistida (crashou no meio do apply), RE-APLICA A MESMA decisão — os
    // upserts/guards do aplicador toleram re-execução — SEM re-chamar o LLM (que decidiria
    // diferente sobre efeitos parciais + pagaria custo de novo).
    if (claim.resumed) {
      const output = await getRunOutput(pool, runId);
      const persisted = output && typeof output === 'object'
        ? (output as { decision?: unknown }).decision : null;
      if (persisted != null) {
        const ctx = await buildContext(pool, {
          workspaceId: target.workspaceId, periodStart: target.periodStart, periodEnd: target.periodEnd,
        });
        const res = await applyDecision(pool, ctx, persisted as PatternDecision, { runId });
        await finishRun(pool, runId, { applied: res.applied, skipped: res.skipped, resumed: true });
        return { status: 'applied', runId, applied: res.applied, skipped: res.skipped };
      }
      // Sem decisão persistida → crashou ANTES do apply → segue o fluxo normal (re-LLM ok:
      // nenhum efeito parcial foi escrito).
    }

    const ctx = await buildContext(pool, {
      workspaceId: target.workspaceId, periodStart: target.periodStart, periodEnd: target.periodEnd,
    });

    // Matéria-prima insuficiente: fecha a run como done (não re-claim toda semana) sem gastar LLM.
    if (ctx.judgments.length < minJudgments) {
      await finishRun(pool, runId, { skipped: 'sem_materia', judgments: ctx.judgments.length });
      return { status: 'skipped_no_materia', runId };
    }

    const { system, user } = buildPrompt(ctx, nowIso());
    const llm = await provider.judge(system, user);

    // Custo SEMPRE registrado (a chamada já aconteceu), antes de validar/aplicar.
    await recordMetrics(pool, {
      provider: provider.provider, model: provider.model,
      usage: llm.usage, costUsd: judgmentCost(provider.model, llm.usage),
    });

    const parsed = parseDecision(llm.raw, ctx);
    if (!parsed.ok) {
      // A run aconteceu (LLM chamado, custo pago). Fecha como done+invalid (NÃO fail — não
      // queremos retry infinito de um output que o modelo não vai consertar).
      console.warn(`[ai-pattern] decisão inválida (ws=${target.workspaceId}): ${parsed.error}`);
      await finishRun(pool, runId, { invalid: true, error: parsed.error });
      return { status: 'invalid', runId };
    }

    // Persiste a decisão VALIDADA ANTES do apply (status segue running): se crashar no meio
    // do apply, a retomada re-aplica ESTA decisão (acima), não uma nova (BLOQUEADOR 1).
    await persistDecision(pool, runId, parsed.decision);

    const res = await applyDecision(pool, ctx, parsed.decision, { runId });
    // finishRun faz MERGE do output → { decision (persistida), applied, skipped }.
    await finishRun(pool, runId, { applied: res.applied, skipped: res.skipped });
    return { status: 'applied', runId, applied: res.applied, skipped: res.skipped };
  } catch (err) {
    // Erro transitório (LLM down, DB hiccup): marca failed → a próxima semana retoma a MESMA
    // row via claim resumed (E1). Não relança: best-effort por workspace.
    console.warn(`[ai-pattern] run falhou (ws=${target.workspaceId}): ${(err as Error).message}`);
    await failRun(pool, runId).catch(() => {});
    return { status: 'failed', runId };
  }
}

export interface PatternSweepResult {
  workspaces: number;
  applied: number;
  invalid: number;
  skippedNoMateria: number;
  skippedClaim: number;
  failed: number;
  /** Nº de runs 'failed' de semanas passadas re-tentadas neste ciclo (BLOQUEADOR 2). */
  resumedFailed: number;
}

export interface RunPatternSweepDeps extends RunPatternDeps {
  provider: JudgmentLlm;
  fetchWorkspaces?: typeof fetchAiWorkspaces;
  fetchFailedRuns?: typeof fetchFailedPatternRuns;
  /** Relógio (Date) pro cálculo da semana anterior; default new Date(). */
  clock?: () => Date;
  /** Cap de runs 'failed' antigas retomadas por workspace (default 2). */
  maxFailedResume?: number;
}

/**
 * 1 ciclo do runner semanal. Por workspace com IA habilitada:
 *  1. RETOMA runs 'failed' de semanas passadas (cap `maxFailedResume`) — sem isto o sweep,
 *     que só calcula a semana corrente, abandonaria pra sempre uma run que falhou numa
 *     semana já superada (BLOQUEADOR 2). A do PERÍODO CORRENTE é pulada aqui (o passo 2 a
 *     retoma via claim). Cada retomada re-aplica a decisão persistida (ou re-roda o LLM se
 *     crashou antes de persistir).
 *  2. Processa a SEMANA CORRENTE (calculada uma vez do relógio → determinístico).
 * Best-effort: erro ao coletar workspaces aborta; erro por workspace/run é isolado (o
 * runPatternForWorkspace marca fail e não relança; o try/catch aqui pega falha do claim).
 */
export async function runPatternSweep(pool: Pool, deps: RunPatternSweepDeps): Promise<PatternSweepResult> {
  const fetchWorkspaces = deps.fetchWorkspaces ?? fetchAiWorkspaces;
  const fetchFailedRuns = deps.fetchFailedRuns ?? fetchFailedPatternRuns;
  const clock = deps.clock ?? (() => new Date());
  const maxFailedResume = deps.maxFailedResume ?? DEFAULT_MAX_FAILED_RESUME;
  const { periodStart, periodEnd } = previousCompleteWeek(clock());

  const workspaces = await fetchWorkspaces(pool);
  const result: PatternSweepResult = {
    workspaces: workspaces.length, applied: 0, invalid: 0, skippedNoMateria: 0, skippedClaim: 0, failed: 0, resumedFailed: 0,
  };

  const tally = (outcome: PatternRunOutcome): void => {
    switch (outcome.status) {
      case 'applied': result.applied += 1; break;
      case 'invalid': result.invalid += 1; break;
      case 'skipped_no_materia': result.skippedNoMateria += 1; break;
      case 'skipped_claim': result.skippedClaim += 1; break;
      case 'failed': result.failed += 1; break;
    }
  };
  const runOne = async (target: { workspaceId: string; periodStart: string; periodEnd: string }): Promise<void> => {
    try {
      tally(await runPatternForWorkspace(pool, deps.provider, target, deps));
    } catch (err) {
      // runPatternForWorkspace já isola erros pós-claim; isto só pega falha do próprio claim.
      console.warn(`[ai-pattern] workspace ${target.workspaceId} (${target.periodStart}) falhou no claim: ${(err as Error).message}`);
      result.failed += 1;
    }
  };

  for (const ws of workspaces) {
    // 1. Retomar runs 'failed' de semanas passadas.
    let failed: FailedPatternRun[] = [];
    try {
      failed = await fetchFailedRuns(pool, ws.workspaceId, maxFailedResume);
    } catch (err) {
      console.warn(`[ai-pattern] coleta de runs failed falhou (ws=${ws.workspaceId}): ${(err as Error).message}`);
    }
    for (const f of failed) {
      if (f.periodStart === periodStart) continue; // corrente → tratada no passo 2
      result.resumedFailed += 1;
      console.info(`[ai-pattern] retomando run failed ws=${ws.workspaceId} período=${f.periodStart}..${f.periodEnd}`);
      await runOne({ workspaceId: ws.workspaceId, periodStart: f.periodStart, periodEnd: f.periodEnd });
    }
    // 2. Semana corrente.
    await runOne({ workspaceId: ws.workspaceId, periodStart, periodEnd });
  }
  return result;
}

export interface StartPatternOpts {
  intervalMs?: number;
  now?: () => Date;
  log?: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

/**
 * Poller do runner semanal (setInterval + gate de janela domingo 04:00–05:00 BRT + flag
 * in-flight). Tick horário (resolveTickIntervalMs, reusado do nível 1 — mesmo clamp
 * anti-runaway de 15min); só roda a sweep se `now` cai na janela; um ciclo em andamento
 * bloqueia o tick seguinte. `now` injetável pra teste.
 */
export function startPatternPoller(pool: Pool, provider: JudgmentLlm, opts: StartPatternOpts = {}): NodeJS.Timeout {
  const ms = resolveTickIntervalMs(opts.intervalMs);
  const nowFn = opts.now ?? (() => new Date());
  let running = false;
  return setInterval(async () => {
    if (running) return;
    if (!isWithinPatternWindow(nowFn())) return;
    running = true;
    try {
      const r = await runPatternSweep(pool, { provider, clock: nowFn });
      opts.log?.info({ ...r }, 'ai-pattern: run semanal concluído');
    } catch (err) {
      (opts.log?.error ?? ((o: any) => console.error('[ai-pattern] run falhou:', o)))(
        { err: (err as Error).message },
        'ai-pattern: run falhou',
      );
    } finally {
      running = false;
    }
  }, ms);
}
