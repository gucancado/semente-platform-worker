import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import {
  previousCompleteWeek,
  weekFromStart,
  runPatternForWorkspace,
} from '../whatsapp/ai-pattern-runner.js';
import { buildPatternContext } from '../whatsapp/ai-pattern-context.js';
import { buildPatternPrompt } from '../whatsapp/ai-pattern-prompt.js';

// ─────────────────────────────────────────────────────────────────────────────
// Disparo MANUAL do runner do motor de PADRÕES IA nível 2 (Task E3, spec v3 §8).
// Roda em prod como `node dist/cli/run-ai-pattern.js --workspace=<id> [...]`
// (docker exec) — usado no Gate E pra validar no workspace teste-whatsapp.
//
//   --workspace=<id>          (obrigatório) — único workspace alvo do disparo.
//   --period-start=YYYY-MM-DD  (opcional)    — segunda da semana analisada; o fim é
//                                              +6 dias (domingo). Default = semana
//                                              ANTERIOR completa (previousCompleteWeek).
//   --dry-run                                — monta contexto + prompt e IMPRIME, SEM
//                                              claim, LLM ou aplicação (inspeção humana).
//
// Sem --dry-run: constrói o provider OpenAI real (CRM_AI_PATTERN_MODEL, fallback
// CRM_AI_MODEL) e roda o ciclo de UM workspace (claim → contexto → LLM → validação →
// aplicação → finish/fail), imprimindo o desfecho.
// ─────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CliArgs {
  workspace: string | null;
  periodStart: string | null;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let workspace: string | null = null;
  let periodStart: string | null = null;
  const dryRun = argv.includes('--dry-run');
  for (const a of argv) {
    if (a.startsWith('--workspace=')) workspace = a.slice('--workspace='.length) || null;
    else if (a.startsWith('--period-start=')) {
      const v = a.slice('--period-start='.length);
      periodStart = DATE_RE.test(v) ? v : null;
    }
  }
  return { workspace, periodStart, dryRun };
}

/** Resolve a janela: --period-start (segunda→+6d) ou a semana anterior completa. */
export function resolvePeriod(periodStart: string | null, now: Date = new Date()): { periodStart: string; periodEnd: string } {
  return periodStart ? weekFromStart(periodStart) : previousCompleteWeek(now);
}

/** Pré-flight: CRM configurado pro workspace? (row em whatsapp_workspace_settings). */
async function readWorkspaceSettings(
  pool: Pool,
  workspaceId: string,
): Promise<{ aiEngineEnabled: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT ai_engine_enabled FROM whatsapp_workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  if (!row) return null;
  return { aiEngineEnabled: row.ai_engine_enabled === true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspace) {
    console.error('uso: run-ai-pattern --workspace=<id> [--period-start=YYYY-MM-DD] [--dry-run]');
    process.exit(2);
  }

  const { pool } = await import('../db.js');
  const settings = await readWorkspaceSettings(pool, args.workspace);
  if (!settings) {
    console.error(`[run-ai-pattern] workspace ${args.workspace} não tem row em whatsapp_workspace_settings (CRM não configurado)`);
    await pool.end();
    process.exit(1);
  }

  const { periodStart, periodEnd } = resolvePeriod(args.periodStart);
  console.log(
    `[run-ai-pattern] workspace=${args.workspace} · período=${periodStart}..${periodEnd} · ` +
      `ai_engine_enabled=${settings.aiEngineEnabled}${args.dryRun ? ' · DRY-RUN' : ''}`,
  );

  if (args.dryRun) {
    // SEM claim/LLM/aplicação: monta contexto + prompt e imprime o que a IA veria.
    const ctx = await buildPatternContext(pool, { workspaceId: args.workspace, periodStart, periodEnd });
    const { system, user } = buildPatternPrompt(ctx, new Date().toISOString());
    console.log(`\njulgamentos coletados: ${ctx.judgments.length} · tags: ${ctx.tags.length} · motivos: ${ctx.lossReasons.length} · opps citáveis: ${ctx.opportunityIds.length}`);
    console.log('--- SYSTEM ---');
    console.log(system);
    console.log('--- USER ---');
    console.log(user);
    console.log('\n[run-ai-pattern] DRY-RUN concluído: prompt montado, nenhum claim/LLM/escrita.');
    await pool.end();
    return;
  }

  // Modo real: provider OpenAI (mesma lib/env da transcrição; modelo do nível 2).
  const { config } = await import('../config.js');
  if (!config.OPENAI_API_KEY) {
    console.error('[run-ai-pattern] OPENAI_API_KEY ausente — necessário fora do --dry-run');
    await pool.end();
    process.exit(1);
  }
  const { OpenAIJudgmentLlm } = await import('../whatsapp/ai-llm.js');
  const model = config.CRM_AI_PATTERN_MODEL ?? config.CRM_AI_MODEL;
  const provider = new OpenAIJudgmentLlm({ apiKey: config.OPENAI_API_KEY, model });

  const outcome = await runPatternForWorkspace(pool, provider, {
    workspaceId: args.workspace, periodStart, periodEnd,
  });
  console.log(
    `[run-ai-pattern] desfecho=${outcome.status}` +
      (outcome.runId != null ? ` runId=${outcome.runId}` : '') +
      (outcome.applied ? ` applied=[${outcome.applied.join(', ')}]` : '') +
      (outcome.skipped ? ` skipped=[${outcome.skipped.join(', ')}]` : ''),
  );
  await pool.end();
  if (outcome.status === 'failed') process.exitCode = 1;
}

// Só dispara quando executado como script (não quando importado por um teste).
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
