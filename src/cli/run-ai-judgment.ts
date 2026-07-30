import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import {
  fetchPendingConversations,
  runJudgmentForConversation,
} from '../whatsapp/ai-judgment-runner.js';
import { buildJudgmentContext } from '../whatsapp/ai-judgment-context.js';
import { buildJudgmentPrompt } from '../whatsapp/ai-judgment-prompt.js';

// ─────────────────────────────────────────────────────────────────────────────
// Disparo MANUAL do runner do julgamento IA nível 1 (Task D5, spec v3 §7).
// Roda em prod como `node dist/cli/run-ai-judgment.js --workspace=<id> [...]`
// (docker exec) — usado no Gate D pra validar no workspace teste-whatsapp.
//
//   --workspace=<id>  (obrigatório) — o único workspace alvo do disparo manual.
//   --limit=N         (default 10)  — quantas conversas pendentes processar.
//   --dry-run                        — monta contexto + prompt de cada conversa
//                                      e IMPRIME, SEM chamar o LLM nem aplicar
//                                      nada (inspeção humana do que a IA veria).
//
// Sem --dry-run: constrói o provider OpenAI real (config.OPENAI_API_KEY +
// CRM_AI_MODEL) e roda o pipeline completo por conversa (contexto → LLM →
// validação → aplicação → custo em llm_metrics), imprimindo applied/skipped/stale.
// ─────────────────────────────────────────────────────────────────────────────

export interface CliArgs {
  workspace: string | null;
  limit: number;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let workspace: string | null = null;
  let limit = 10;
  const dryRun = argv.includes('--dry-run');
  for (const a of argv) {
    if (a.startsWith('--workspace=')) workspace = a.slice('--workspace='.length) || null;
    else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    }
  }
  return { workspace, limit, dryRun };
}

/** Lê a settings row do workspace (read-only) — pipeline_since alimenta o cálculo de
 *  pendências; ausência de row = CRM não configurado pro workspace (erro). */
async function readWorkspaceSettings(
  pool: Pool,
  workspaceId: string,
): Promise<{ pipelineSince: unknown; aiEngineEnabled: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT pipeline_since, ai_engine_enabled FROM whatsapp_workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  if (!row) return null;
  return { pipelineSince: row.pipeline_since, aiEngineEnabled: row.ai_engine_enabled === true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspace) {
    console.error('uso: run-ai-judgment --workspace=<id> [--limit=N] [--dry-run]');
    process.exit(2);
  }

  const { pool } = await import('../db.js');
  const settings = await readWorkspaceSettings(pool, args.workspace);
  if (!settings) {
    console.error(`[run-ai-judgment] workspace ${args.workspace} não tem row em whatsapp_workspace_settings (CRM não configurado)`);
    await pool.end();
    process.exit(1);
  }

  const pending = await fetchPendingConversations(pool, {
    workspaceId: args.workspace,
    pipelineSince: settings.pipelineSince,
    limit: args.limit,
  });

  console.log(
    `[run-ai-judgment] workspace=${args.workspace} · ai_engine_enabled=${settings.aiEngineEnabled} · ` +
      `${pending.length} conversa(s) pendente(s) (limite ${args.limit})${args.dryRun ? ' · DRY-RUN' : ''}`,
  );

  if (args.dryRun) {
    const now = new Date().toISOString();
    for (const conv of pending) {
      const ctx = await buildJudgmentContext(pool, {
        numberId: conv.numberId,
        identifier: conv.identifier,
        workspaceId: conv.workspaceId,
        watermark: conv.watermark,
      });
      const { system, user } = buildJudgmentPrompt(ctx, now);
      console.log('\n' + '='.repeat(72));
      console.log(`conversa ${conv.numberId}:${conv.identifier} · watermark=${conv.watermark ?? '(nunca julgada)'} · lastMessageAt=${ctx.lastMessageAt}`);
      console.log('--- SYSTEM ---');
      console.log(system);
      console.log('--- USER ---');
      console.log(user);
    }
    console.log(`\n[run-ai-judgment] DRY-RUN concluído: ${pending.length} prompt(s) montado(s), nenhuma chamada LLM nem escrita.`);
    await pool.end();
    return;
  }

  // Modo real: provider OpenAI (mesma lib/env da transcrição).
  const { config } = await import('../config.js');
  if (!config.OPENAI_API_KEY) {
    console.error('[run-ai-judgment] OPENAI_API_KEY ausente — necessário fora do --dry-run');
    await pool.end();
    process.exit(1);
  }
  const { OpenAIJudgmentLlm } = await import('../whatsapp/ai-llm.js');
  const provider = new OpenAIJudgmentLlm({ apiKey: config.OPENAI_API_KEY, model: config.CRM_AI_MODEL });

  let applied = 0;
  let stale = 0;
  let errors = 0;
  for (const conv of pending) {
    try {
      const r = await runJudgmentForConversation(pool, provider, conv);
      if (r.stale) stale += 1;
      if (r.applied.length > 0) applied += 1;
      console.log(
        `conversa ${conv.numberId}:${conv.identifier} → judged=${r.judged} stale=${r.stale} ` +
          `applied=[${r.applied.join(', ')}] skipped=[${r.skipped.join(', ')}]`,
      );
    } catch (err) {
      errors += 1;
      console.warn(`conversa ${conv.numberId}:${conv.identifier} → FALHOU: ${(err as Error).message}`);
    }
  }
  console.log(`[run-ai-judgment] concluído: ${pending.length} processada(s) · ${applied} com aplicação · ${stale} stale · ${errors} erro(s)`);
  await pool.end();
  if (errors > 0) process.exitCode = 1;
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
