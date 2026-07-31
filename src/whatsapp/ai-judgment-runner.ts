/**
 * src/whatsapp/ai-judgment-runner.ts
 *
 * CRM WhatsApp v3 — Fase D, Task D5: RUNNER diário do julgamento IA nível 1
 * (spec v3 §7). Orquestra, por conversa pendente:
 *   contexto (D3, buildJudgmentContext) → prompt (D3, buildJudgmentPrompt) →
 *   LLM (D5, JudgmentLlm.judge) → validação (D3, parseJudgmentDecision) →
 *   aplicação atômica (D4, applyJudgment) → custo em llm_metrics.
 *
 * SCHEDULING (decisão fechada, task-d5-brief §D5): setInterval HORÁRIO + gate de
 * janela 03:00–04:00 BRT (America/Sao_Paulo via Intl) + best-effort SEM claim table.
 * A idempotência vem do UNIQUE (número, identifier, input_last_message_at) de
 * whatsapp_ai_judgments (o CLAIM do aplicador, D4): rodar 2x na janela é inócuo — o
 * 2º run não re-julga o mesmo input. `CRM_AI_TICK_MS` (default 1h) encurta o tick só
 * pra teste; com 1h de tick e 1h de janela, exatamente um tick/dia cai na janela.
 *
 * CAP por run (`CRM_AI_MAX_CONVERSATIONS_PER_RUN`, default 200): proteção de custo. As
 * conversas são ordenadas por MAX(created_at) DESC (mais QUENTES primeiro) e as
 * excedentes ficam de fora deste run (log do que foi cortado) — voltam no próximo.
 *
 * PURO no sentido de env: lê `CRM_AI_TICK_MS`/`CRM_AI_MAX_CONVERSATIONS_PER_RUN`
 * direto de process.env (molde de auto-loss.ts / opportunity-pipeline.ts — SEM
 * config.js), e a cadeia D3/D4 que importa por default é config-free. O provider LLM
 * é INJETADO (construído na borda com config). Assim tests/ai-judgment-runner.test.ts
 * roda local sem DATABASE_URL nem env de servidor.
 */
import type { Pool } from 'pg';
import {
  buildJudgmentContext,
  type JudgmentContext,
} from './ai-judgment-context.js';
import { buildJudgmentPrompt, parseJudgmentDecision } from './ai-judgment-prompt.js';
import { applyJudgment, recordUnappliedJudgment, type ApplyJudgmentResult } from './ai-judgment-apply.js';
import { judgmentCost, type JudgmentLlm } from './ai-llm.js';

const DEFAULT_TICK_MS = 60 * 60_000; // 1h
const MIN_TICK_MS = 15 * 60_000; // clamp de segurança: env abaixo disso vira 15min (anti-runaway de custo)
const DEFAULT_MAX_PER_RUN = 200;

// Janela de execução [03:00, 04:00) horário de São Paulo (spec: coleta diária ~03:00 BRT).
const WINDOW_START_HOUR = 3;
const WINDOW_END_HOUR = 4;

/**
 * Resolve o intervalo do tick: param explícito (`intervalMs`) vence SEM clamp (knob
 * interno/teste); senão lê `CRM_AI_TICK_MS` de process.env; ausente/vazio/inválido
 * (não-numérico, <=0) → 1h. **Clamp anti-runaway**: um `CRM_AI_TICK_MS` válido porém <15min
 * é forçado a 15min com warn no boot — env mal configurada (ex.: 1min) faria o runner varrer
 * 200 conversas ~toda hora dentro da janela e queimar custo de LLM em loop.
 */
export function resolveTickIntervalMs(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.CRM_AI_TICK_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TICK_MS;
  const n = Number(raw);
  if (!(Number.isFinite(n) && n > 0)) return DEFAULT_TICK_MS;
  if (n < MIN_TICK_MS) {
    console.warn(`[ai-judgment] CRM_AI_TICK_MS=${n}ms abaixo do mínimo ${MIN_TICK_MS}ms — usando ${MIN_TICK_MS}ms (proteção anti-runaway de custo)`);
    return MIN_TICK_MS;
  }
  return n;
}

/**
 * Resolve o cap de conversas por run: param explícito vence; senão `CRM_AI_MAX_CONVERSATIONS_PER_RUN`
 * de process.env; ausente/vazio/inválido → 200.
 */
export function resolveMaxConversationsPerRun(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.CRM_AI_MAX_CONVERSATIONS_PER_RUN;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PER_RUN;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PER_RUN;
}

/** Hora local (0-23) em America/Sao_Paulo via Intl — DST-safe (Brasil sem DST desde 2019). */
export function saoPauloHour(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const raw = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const n = Number(raw);
  return n === 24 ? 0 : n; // ICU pode devolver '24' à meia-noite com hour12:false
}

/** true sse `now` cai na janela [03:00, 04:00) BRT. */
export function isWithinJudgmentWindow(now: Date): boolean {
  const h = saoPauloHour(now);
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

export interface AiWorkspace {
  workspaceId: string;
  pipelineSince: unknown; // timestamptz cru do pg — passado adiante como parâmetro
}

/** Workspaces com o motor de IA habilitado (SELECT direto em settings — spec §7). */
export async function fetchAiWorkspaces(pool: Pool): Promise<AiWorkspace[]> {
  const { rows } = await pool.query(
    `/* ai:workspaces */ SELECT workspace_id, pipeline_since
       FROM whatsapp_workspace_settings WHERE ai_engine_enabled = TRUE`,
  );
  return rows.map((r: any) => ({ workspaceId: String(r.workspace_id), pipelineSince: r.pipeline_since }));
}

export interface PendingConversation {
  numberId: number;
  identifier: string;
  workspaceId: string;
  /** MAX(messages.created_at) do par (ISO) — novo watermark do input + chave de ordenação. */
  lastMessageAt: string;
  /** MAX(input_last_message_at) do julgamento anterior (null = nunca julgado). */
  watermark: string | null;
}

/** timestamptz do pg vem como Date; toleramos string ISO (fakes). */
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof (v as { toISOString?: unknown })?.toISOString === 'function') return (v as Date).toISOString();
  return String(v);
}

// Conversas pendentes de um workspace: pares DM (não-grupo: canônico = sem row em
// whatsapp_groups E sem message com author), is_lead ≠ FALSE, cuja mensagem mais nova
// passou do watermark do julgamento anterior (COALESCE com pipeline_since — não retroage
// sobre histórico pré-pipeline nem re-julga input já visto). Ordenadas mais QUENTES
// primeiro (MAX(created_at) DESC) e limitadas ao cap. $1 = workspace_id,
// $2 = pipeline_since, $3 = limite.
const PENDING_SQL = `/* ai:pending */
  SELECT m.whatsapp_number_id, m.identifier, m.workspace_id,
         MAX(m.created_at) AS last_message_at,
         j.watermark AS watermark
    FROM messages m
    LEFT JOIN whatsapp_thread_meta tm
      ON tm.whatsapp_number_id = m.whatsapp_number_id AND tm.identifier = m.identifier
    LEFT JOIN LATERAL (
      SELECT MAX(jj.input_last_message_at) AS watermark
        FROM whatsapp_ai_judgments jj
       WHERE jj.whatsapp_number_id = m.whatsapp_number_id AND jj.identifier = m.identifier
    ) j ON TRUE
   WHERE m.workspace_id = $1
     AND (tm.is_lead IS DISTINCT FROM FALSE)
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_groups g
        WHERE g.whatsapp_number_id = m.whatsapp_number_id AND g.jid = m.identifier
     )
     AND NOT EXISTS (
       SELECT 1 FROM messages m2
        WHERE m2.whatsapp_number_id = m.whatsapp_number_id AND m2.identifier = m.identifier
          AND m2.author IS NOT NULL
     )
   GROUP BY m.whatsapp_number_id, m.identifier, m.workspace_id, j.watermark
  HAVING MAX(m.created_at) > COALESCE(j.watermark, $2::timestamptz)
   ORDER BY MAX(m.created_at) DESC
   LIMIT $3`;

export async function fetchPendingConversations(
  pool: Pool,
  args: { workspaceId: string; pipelineSince: unknown; limit: number },
): Promise<PendingConversation[]> {
  const { rows } = await pool.query(PENDING_SQL, [args.workspaceId, args.pipelineSince, args.limit]);
  return rows.map((r: any) => ({
    numberId: Number(r.whatsapp_number_id),
    identifier: String(r.identifier),
    workspaceId: String(r.workspace_id),
    lastMessageAt: toISO(r.last_message_at) ?? '',
    watermark: toISO(r.watermark),
  }));
}

/** Registra o custo de UMA chamada LLM em llm_metrics (molde do insert da transcrição). */
export async function recordLlmMetrics(
  pool: Pool,
  args: { provider: string; model: string; usage: { inputTokens: number; outputTokens: number }; costUsd: number },
): Promise<void> {
  await pool.query(
    `/* ai:llm_metrics */ INSERT INTO llm_metrics
       (agent, task, provider, model, tokens_in, tokens_out, cost_usd)
     VALUES ('crm-ai-judgment', 'judge', $1, $2, $3, $4, $5)`,
    [args.provider, args.model, args.usage.inputTokens, args.usage.outputTokens, args.costUsd],
  );
}

/** Colaboradores injetáveis (default = funções reais); testes injetam spies/fakes. */
export interface RunJudgmentDeps {
  buildContext?: typeof buildJudgmentContext;
  buildPrompt?: typeof buildJudgmentPrompt;
  parseDecision?: typeof parseJudgmentDecision;
  applyFn?: typeof applyJudgment;
  recordUnapplied?: typeof recordUnappliedJudgment;
  recordMetrics?: typeof recordLlmMetrics;
  /** Relógio injetável (default new Date().toISOString()) — o prompt precisa do "agora". */
  now?: () => string;
}

export interface RunConversationResult extends ApplyJudgmentResult {
  /** true quando o LLM foi de fato chamado (houve custo registrado). */
  judged: boolean;
}

/**
 * Julga UMA conversa. Fluxo: contexto → (sem mensagem → sai sem LLM/custo) → prompt →
 * LLM → REGISTRA CUSTO (sempre, mesmo se a decisão for inválida — o custo já aconteceu)
 * → valida → aplica. Erro do LLM propaga pro caller (a sweep isola por conversa).
 */
export async function runJudgmentForConversation(
  pool: Pool,
  provider: JudgmentLlm,
  conv: { numberId: number; identifier: string; workspaceId: string; watermark: string | null },
  deps: RunJudgmentDeps = {},
): Promise<RunConversationResult> {
  const buildContext = deps.buildContext ?? buildJudgmentContext;
  const buildPrompt = deps.buildPrompt ?? buildJudgmentPrompt;
  const parseDecision = deps.parseDecision ?? parseJudgmentDecision;
  const applyFn = deps.applyFn ?? applyJudgment;
  const recordUnapplied = deps.recordUnapplied ?? recordUnappliedJudgment;
  const recordMetrics = deps.recordMetrics ?? recordLlmMetrics;
  const nowIso = deps.now ?? (() => new Date().toISOString());

  const ctx: JudgmentContext = await buildContext(pool, {
    numberId: conv.numberId,
    identifier: conv.identifier,
    workspaceId: conv.workspaceId,
    watermark: conv.watermark,
  });

  // Sem mensagem no contexto: nada a julgar, sem gastar LLM (defensivo — a query de
  // pendentes já garante MAX(created_at) > watermark, mas a corrida com um delete raro
  // deixaria o contexto vazio).
  if (ctx.lastMessageAt == null) {
    return { applied: [], skipped: ['no_last_message'], stale: false, judged: false };
  }

  const { system, user } = buildPrompt(ctx, nowIso());
  const llm = await provider.judge(system, user);

  // Custo SEMPRE registrado (o custo aconteceu na chamada acima), antes de validar/aplicar
  // — se o parse/apply lançar, o custo já está contabilizado.
  await recordMetrics(pool, {
    provider: provider.provider,
    model: provider.model,
    usage: llm.usage,
    costUsd: judgmentCost(provider.model, llm.usage),
  });

  const parsed = parseDecision(llm.raw, ctx);
  if (!parsed.ok) {
    console.warn(`[ai-judgment] decisão inválida (${conv.numberId}:${conv.identifier}): ${parsed.error}`);
    // Grava o julgamento NÃO-APLICADO (mesmo claim, sem escrita de opp/thread): avança o
    // watermark do par pra que o LLM não seja re-chamado a cada tick pra a mesma conversa
    // (anti-runaway de custo). Se mensagem nova chegou sob o lock, recordUnapplied devolve
    // stale=true e NÃO crava — a conversa volta como pendente com o input novo.
    const rec = await recordUnapplied(pool, ctx, llm.raw, parsed.error, { model: provider.model });
    return { applied: [], skipped: ['invalid_decision'], stale: rec.stale, judged: true };
  }

  const result = await applyFn(pool, ctx, parsed.decision, { model: provider.model });
  return { ...result, judged: true };
}

export interface JudgmentSweepResult {
  processed: number;
  applied: number;
  stale: number;
  errors: number;
  skippedByCap: number;
}

export interface RunSweepDeps extends RunJudgmentDeps {
  maxConversations?: number;
  fetchWorkspaces?: typeof fetchAiWorkspaces;
  fetchPending?: typeof fetchPendingConversations;
}

function cmpLastMessageDesc(a: PendingConversation, b: PendingConversation): number {
  if (a.lastMessageAt === b.lastMessageAt) return 0;
  return a.lastMessageAt > b.lastMessageAt ? -1 : 1;
}

/**
 * 1 ciclo do runner. Varre os workspaces com IA habilitada, coleta as conversas
 * pendentes de cada um, ordena GLOBALMENTE por hotness (mais recentes primeiro),
 * corta no cap e julga uma a uma. Best-effort: falha ao coletar pendentes de um
 * workspace, ou ao julgar uma conversa, loga warn e segue — nunca aborta o run.
 */
export async function runJudgmentSweep(
  pool: Pool,
  provider: JudgmentLlm,
  deps: RunSweepDeps = {},
): Promise<JudgmentSweepResult> {
  const cap = resolveMaxConversationsPerRun(deps.maxConversations);
  const fetchWorkspaces = deps.fetchWorkspaces ?? fetchAiWorkspaces;
  const fetchPending = deps.fetchPending ?? fetchPendingConversations;

  const workspaces = await fetchWorkspaces(pool);
  let all: PendingConversation[] = [];
  for (const ws of workspaces) {
    try {
      const pending = await fetchPending(pool, {
        workspaceId: ws.workspaceId,
        pipelineSince: ws.pipelineSince,
        limit: cap,
      });
      all.push(...pending);
    } catch (err) {
      console.warn(`[ai-judgment] coleta de pendentes falhou pro workspace ${ws.workspaceId}: ${(err as Error).message}`);
    }
  }

  all.sort(cmpLastMessageDesc);
  let skippedByCap = 0;
  if (all.length > cap) {
    skippedByCap = all.length - cap;
    console.info(`[ai-judgment] cap ${cap} atingido: ${skippedByCap} conversa(s) mais fria(s) fora deste run`);
    all = all.slice(0, cap);
  }

  let applied = 0;
  let stale = 0;
  let errors = 0;
  for (const conv of all) {
    try {
      const r = await runJudgmentForConversation(pool, provider, conv, deps);
      if (r.stale) stale += 1;
      if (r.applied.length > 0) applied += 1;
    } catch (err) {
      errors += 1;
      console.warn(`[ai-judgment] julgamento falhou (${conv.numberId}:${conv.identifier}): ${(err as Error).message}`);
    }
  }

  return { processed: all.length, applied, stale, errors, skippedByCap };
}

export interface StartRunnerOpts {
  intervalMs?: number;
  now?: () => Date;
  log?: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

/**
 * Poller do runner (setInterval + gate de janela BRT + flag in-flight). Cada tick só
 * roda a sweep se `now` cai em [03:00, 04:00) BRT; um ciclo em andamento bloqueia o tick
 * seguinte (nunca 2 sweeps concorrentes). `now` injetável pra teste.
 */
export function startJudgmentRunner(pool: Pool, provider: JudgmentLlm, opts: StartRunnerOpts = {}): NodeJS.Timeout {
  const ms = resolveTickIntervalMs(opts.intervalMs);
  const nowFn = opts.now ?? (() => new Date());
  let running = false;
  return setInterval(async () => {
    if (running) return;
    if (!isWithinJudgmentWindow(nowFn())) return;
    running = true;
    try {
      const r = await runJudgmentSweep(pool, provider);
      opts.log?.info({ ...r }, 'ai-judgment: run concluído');
    } catch (err) {
      (opts.log?.error ?? ((o: any) => console.error('[ai-judgment] run falhou:', o)))(
        { err: (err as Error).message },
        'ai-judgment: run falhou',
      );
    } finally {
      running = false;
    }
  }, ms);
}
