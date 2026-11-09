/**
 * src/whatsapp/ai-pattern-apply.ts
 *
 * Aplicador do motor de IA nível 2 (análise semanal de padrões — spec v3 §8). Recebe o
 * PatternContext (E2) e a PatternDecision JÁ VALIDADA (E2, parsePatternDecision) e escreve
 * o caminho AUTÔNOMO da IA no vocabulário do funil, ator = 'ai':
 *   (a) motivos de perda novos (INSERT ON CONFLICT por lower(code) derivado do label);
 *   (b) motivos editados (guard humano);
 *   (c) BACKFILL de loss_reason em opps perdidas sem motivo (§8): sob o lock do par, via
 *       kernel (applyOppPatchInTx {lossReason}), só onde loss_reason IS NULL e sem evento
 *       humano de motivo (sticky) — as perdidas migradas da v1 vêm sem motivo esperando isto;
 *   (d) sugestões de tag nova (kind='tag_new') e de guidance → whatsapp_ai_suggestions
 *       (humano decide; nunca automático);
 *   (e) insight semanal → whatsapp_ai_insights.
 *
 * O catálogo de tags é do painel (espelho somente leitura): este módulo nunca escreve em
 * whatsapp_tags nem etiqueta oportunidades.
 *
 * Diferente do aplicador do nível 1 (D4, por-conversa sob um único lock), este é
 * WORKSPACE-LEVEL: catálogos/sugestões/insight escrevem direto no `pool`; APENAS o backfill
 * de motivo entra no lock por par. Sticky de catálogo (dono humano) é checado no SQL (guard).
 */
import type { Pool, PoolClient } from 'pg';
import { slugifyLossCode } from './loss-reasons.js';
import { computeSticky, humanActorSql } from './ai-sticky.js';
import { applyOppPatchInTx } from './opportunities.js';
import { isValidLossReason } from './loss-reasons.js';
import { OppInvariantError, type OppStateV3 } from './opportunity-core.js';
import { withConversationLock } from './conversation-lock.js';
import { insertSuggestion, insertInsight } from './ai-pattern-store.js';
import type { PatternContext } from './ai-pattern-context.js';
import type { PatternDecision } from './ai-pattern-prompt.js';

export interface ApplyPatternResult {
  /** Rótulos do que foi ESCRITO (auditoria): 'loss_created:7', 'suggestion:tag_new:Telhado', 'insight:9'... */
  applied: string[];
  /** Rótulos do que foi PULADO e por quê: 'tag_edit:12:human_owned', 'suggestion:guidance_lead:dedupe'... */
  skipped: string[];
}

/** Colaboradores injetáveis (default = funções reais); os testes puros injetam spies. */
export interface ApplyPatternDeps {
  /** run_id da whatsapp_ai_pattern_runs — vai pro insight (1 por run). */
  runId?: number | null;
  computeSticky?: typeof computeSticky;
  withConversationLock?: typeof withConversationLock;
  applyOppPatchInTx?: typeof applyOppPatchInTx;
  isValidLossReason?: typeof isValidLossReason;
  insertSuggestion?: typeof insertSuggestion;
  insertInsight?: typeof insertInsight;
}

interface ResolvedDeps {
  runId: number | null;
  computeSticky: typeof computeSticky;
  withConversationLock: typeof withConversationLock;
  applyOppPatchInTx: typeof applyOppPatchInTx;
  isValidLossReason: typeof isValidLossReason;
  insertSuggestion: typeof insertSuggestion;
  insertInsight: typeof insertInsight;
}

function resolveDeps(deps: ApplyPatternDeps): ResolvedDeps {
  return {
    runId: deps.runId ?? null,
    computeSticky: deps.computeSticky ?? computeSticky,
    withConversationLock: deps.withConversationLock ?? withConversationLock,
    applyOppPatchInTx: deps.applyOppPatchInTx ?? applyOppPatchInTx,
    isValidLossReason: deps.isValidLossReason ?? isValidLossReason,
    insertSuggestion: deps.insertSuggestion ?? insertSuggestion,
    insertInsight: deps.insertInsight ?? insertInsight,
  };
}

/** timestamptz do pg vem como Date; toleramos string ISO (fakes/serialização). */
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof (v as { toISOString?: unknown })?.toISOString === 'function') return (v as Date).toISOString();
  return String(v);
}

// Guard IN-SQL das edições de catálogo: só permite editar quando `updated_by` NÃO é humano
// (NULL/'ai'/'system'/'system:*' passam). 0 rows = um humano tomou a entrada entre a
// montagem do contexto e a aplicação (race) → skip, sem sobrescrever a curadoria humana.
const TAG_EDIT_GUARD = `NOT (${humanActorSql('updated_by')})`;

export async function applyPatternDecision(
  pool: Pool,
  ctx: PatternContext,
  decision: PatternDecision,
  deps: ApplyPatternDeps = {},
): Promise<ApplyPatternResult> {
  const d = resolveDeps(deps);
  const applied: string[] = [];
  const skipped: string[] = [];
  const ws = ctx.workspaceId;

  // ── (a) motivos de perda novos ────────────────────────────────────────────────
  for (const lr of decision.newLossReasons) {
    const code = slugifyLossCode(lr.label);
    const ins = await pool.query(
      `/* pat_apply:loss_insert */
       INSERT INTO whatsapp_loss_reasons (workspace_id, code, label, description, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'ai', 'ai')
       ON CONFLICT (workspace_id, lower(code)) DO NOTHING
       RETURNING id`,
      [ws, code, lr.label, lr.description],
    );
    if (ins.rows.length > 0) {
      applied.push(`loss_created:${Number(ins.rows[0].id)}`);
    } else if (lr.description != null) {
      // Colisão de aplicação (humano criou o mesmo código no intervalo). Re-lê o id e
      // tenta editar a description sob o guard humano (nunca reescreve dono humano).
      const re = await pool.query(
        `/* pat_apply:loss_reread */ SELECT id FROM whatsapp_loss_reasons
          WHERE workspace_id = $1 AND lower(code) = lower($2)`,
        [ws, code],
      );
      const id = re.rows[0] ? Number(re.rows[0].id) : null;
      if (id == null) {
        skipped.push(`loss_conflict:${code}:vanished`);
      } else {
        const upd = await pool.query(
          `/* pat_apply:loss_update */ UPDATE whatsapp_loss_reasons
              SET description = $3, updated_by = 'ai', updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND ${TAG_EDIT_GUARD}
            RETURNING id`,
          [id, ws, lr.description],
        );
        if ((upd.rowCount ?? 0) > 0) applied.push(`loss_edited:${id}`);
        else skipped.push(`loss_conflict:${code}:human_owned`);
      }
    } else {
      skipped.push(`loss_conflict:${code}:no_desc`);
    }
  }

  // ── (b) motivos de perda editados (explícitos do parser) ──────────────────────
  for (const e of decision.editLossReasons) {
    const upd = await pool.query(
      `/* pat_apply:loss_update */ UPDATE whatsapp_loss_reasons
          SET description = $3, updated_by = 'ai', updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND ${TAG_EDIT_GUARD}
        RETURNING id`,
      [e.id, ws, e.description],
    );
    if ((upd.rowCount ?? 0) > 0) applied.push(`loss_edited:${e.id}`);
    else skipped.push(`loss_edit:${e.id}:human_owned`);
  }

  // ── (c) backfill de loss_reason (spec §8): opps perdidas sem motivo → patch via kernel ──
  // Sob o lock do par, RE-LÊ o estado fresco (humano pode ter reaberto/preenchido no
  // intervalo) e o sticky (evento humano de loss_reason trava). Aplica {lossReason:code} via
  // applyOppPatchInTx: opp `perdido` + lossReason novo → evento loss_reason 'ai', closed_at
  // intacto (kernel regra 7). Só onde loss_reason IS NULL e sem evento humano de motivo.
  for (const bf of decision.backfillLossReasons) {
    const pairRes = await pool.query(
      `/* pat_apply:opp_pair */ SELECT whatsapp_number_id, identifier, workspace_id
         FROM whatsapp_opportunities WHERE id = $1`,
      [bf.opportunityId],
    );
    const pair = pairRes.rows[0];
    if (!pair || pair.workspace_id !== ws) {
      skipped.push(`backfill_loss:${bf.opportunityId}:not_found`);
      continue;
    }
    const numberId = Number(pair.whatsapp_number_id);
    const identifier = String(pair.identifier);

    await d.withConversationLock(pool, numberId, identifier, async (client: PoolClient) => {
      const st = await client.query(
        `/* pat_apply:backfill_state */ SELECT status, is_qualified, closed_at, title, loss_reason
           FROM whatsapp_opportunities WHERE id = $1`,
        [bf.opportunityId],
      );
      const row = st.rows[0];
      if (!row) { skipped.push(`backfill_loss:${bf.opportunityId}:not_found`); return; }
      if (row.status !== 'perdido') { skipped.push(`backfill_loss:${bf.opportunityId}:not_perdido`); return; }
      if (row.loss_reason != null) { skipped.push(`backfill_loss:${bf.opportunityId}:already_set`); return; }
      // Sticky: humano já escreveu o motivo desta opp (mesmo que depois limpo) → não toca.
      const sticky = await d.computeSticky(client, { numberId, identifier, opportunityId: bf.opportunityId });
      if (sticky.lossReason) { skipped.push(`backfill_loss:${bf.opportunityId}:human_owned`); return; }
      // Re-valida o código contra o catálogo FRESCO (humano pode ter desativado sob o lock).
      if (!(await d.isValidLossReason(client, ws, bf.code))) {
        skipped.push(`backfill_loss:${bf.opportunityId}:invalid_code`);
        return;
      }
      const cur: OppStateV3 = {
        status: 'perdido',
        isQualified: row.is_qualified == null ? null : row.is_qualified === true,
        closedAt: toISO(row.closed_at),
        title: row.title ?? null,
        lossReason: null,
      };
      try {
        const res = await d.applyOppPatchInTx(
          client, bf.opportunityId, cur, { lossReason: bf.code }, 'ai', { numberId, identifier },
        );
        if (res.oppChanged) applied.push(`backfill_loss:${bf.opportunityId}:${bf.code}`);
        else skipped.push(`backfill_loss:${bf.opportunityId}:noop`);
      } catch (err) {
        // Invariante de kernel (pura, throw antes de qualquer SQL) → pula só este backfill.
        if (err instanceof OppInvariantError) skipped.push(`backfill_loss:${bf.opportunityId}:${err.code}`);
        else throw err;
      }
    });
  }

  // ── sugestões de tag nova (humano decide no painel; dedupe por nome pendente) ──
  for (const ts of decision.tagSuggestions ?? []) {
    const id = await d.insertSuggestion(pool, ws, 'tag_new', {
      name: ts.name, description: ts.description, reason: ts.reason,
    });
    if (id != null) applied.push(`suggestion:tag_new:${ts.name}`);
    else skipped.push(`suggestion:tag_new:${ts.name}:dedupe`);
  }

  // ── sugestões de guidance (humano aplica; dedupe por kind pending) ────────
  for (const gs of decision.guidanceSuggestions) {
    const current = gs.kind === 'guidance_lead' ? ctx.guidances.lead : ctx.guidances.qualified;
    const id = await d.insertSuggestion(pool, ws, gs.kind, {
      current: current ?? null, suggested: gs.suggested, reason: gs.reason,
    });
    if (id != null) applied.push(`suggestion:${gs.kind}`);
    else skipped.push(`suggestion:${gs.kind}:dedupe`);
  }

  // ── insight semanal (1 por run — UNIQUE(run_id), mig 056) ─────────────────
  // Numa RETOMADA que re-aplica a mesma decisão, o insight já existe → insertInsight
  // devolve null (ON CONFLICT DO NOTHING). Não é erro: registra como dedupe.
  const insightId = await d.insertInsight(pool, ws, d.runId, decision.insightSummary, {
    applied: [...applied], skipped: [...skipped],
  });
  if (insightId != null) applied.push(`insight:${insightId}`);
  else skipped.push('insight:dedupe');

  return { applied, skipped };
}
