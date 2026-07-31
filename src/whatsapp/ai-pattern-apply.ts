/**
 * src/whatsapp/ai-pattern-apply.ts
 *
 * Aplicador do motor de IA nível 2 (análise semanal de padrões — spec v3 §8). Recebe o
 * PatternContext (E2) e a PatternDecision JÁ VALIDADA (E2, parsePatternDecision) e escreve
 * o caminho AUTÔNOMO da IA no vocabulário do funil, ator = 'ai':
 *   (a) tags novas (INSERT ON CONFLICT por lower(name), cor do ciclo TAG_COLORS);
 *   (b) tags editadas (só a description, guard IN-SQL contra dono humano);
 *   (c) motivos de perda novos (INSERT ON CONFLICT por lower(code) derivado do label);
 *   (d) motivos editados (guard humano);
 *   (e) retro-etiquetagem das opps recentes que exibem o padrão, sob o lock do PAR
 *       (§4.11), add-only e respeitando o sticky de tags removidas por humano DAQUELA opp;
 *   (f) BACKFILL de loss_reason em opps perdidas sem motivo (§8): sob o lock do par, via
 *       kernel (applyOppPatchInTx {lossReason}), só onde loss_reason IS NULL e sem evento
 *       humano de motivo (sticky) — as perdidas migradas da v1 vêm sem motivo esperando isto;
 *   (g) sugestões de guidance → whatsapp_ai_suggestions (humano aplica; nunca automático);
 *   (h) insight semanal → whatsapp_ai_insights.
 *
 * Diferente do aplicador do nível 1 (D4, por-conversa sob um único lock), este é
 * WORKSPACE-LEVEL: catálogos/sugestões/insight escrevem direto no `pool`; APENAS a
 * retro-etiquetagem entra no lock por par — cada opp tem seu par próprio, e as escritas de
 * tag/motivo não pertencem a nenhuma conversa. Sticky de catálogo (dono humano) é checado
 * no SQL (guard); sticky de tag por opp é checado via computeSticky sob o lock da opp.
 */
import type { Pool, PoolClient } from 'pg';
import { TAG_COLORS } from './tags.js';
import { slugifyLossCode } from './loss-reasons.js';
import { computeSticky, humanActorSql } from './ai-sticky.js';
import { insertEvent, applyOppPatchInTx } from './opportunities.js';
import { isValidLossReason } from './loss-reasons.js';
import { OppInvariantError, type OppStateV3 } from './opportunity-core.js';
import { withConversationLock } from './conversation-lock.js';
import { insertSuggestion, insertInsight } from './ai-pattern-store.js';
import type { PatternContext } from './ai-pattern-context.js';
import type { PatternDecision } from './ai-pattern-prompt.js';

export interface ApplyPatternResult {
  /** Rótulos do que foi ESCRITO (auditoria): 'tag_created:12', 'retro_tag:41:12', 'insight:9'... */
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
  insertEvent?: typeof insertEvent;
  applyOppPatchInTx?: typeof applyOppPatchInTx;
  isValidLossReason?: typeof isValidLossReason;
  insertSuggestion?: typeof insertSuggestion;
  insertInsight?: typeof insertInsight;
}

interface ResolvedDeps {
  runId: number | null;
  computeSticky: typeof computeSticky;
  withConversationLock: typeof withConversationLock;
  insertEvent: typeof insertEvent;
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
    insertEvent: deps.insertEvent ?? insertEvent,
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

/** Alvo da retro-etiquetagem: uma tag id + nome (pro sticky de tag-removida-por-humano). */
interface RetroTag {
  tagId: number;
  tagName: string;
}

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

  // ── (a) tags novas + resolução do id pra retro-etiquetagem ────────────────────
  // retroByOpp: opp id → tags a aplicar. Agrupado por opp pra travar o par UMA vez.
  const retroByOpp = new Map<number, RetroTag[]>();

  if (decision.newTags.length > 0) {
    // Cor do ciclo: índice = nº de tags já existentes % paleta. Só avança em INSERT real
    // (colisão não consome slot de cor).
    const countRes = await pool.query(
      `/* pat_apply:tag_count */ SELECT count(*)::int AS n FROM whatsapp_tags WHERE workspace_id = $1`,
      [ws],
    );
    let colorSlot = Number(countRes.rows[0]?.n ?? 0);

    for (const t of decision.newTags) {
      const color = TAG_COLORS[colorSlot % TAG_COLORS.length];
      const ins = await pool.query(
        `/* pat_apply:tag_insert */
         INSERT INTO whatsapp_tags (workspace_id, name, color, description, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'ai', 'ai')
         ON CONFLICT (workspace_id, lower(name)) DO NOTHING
         RETURNING id`,
        [ws, t.name, color, t.description],
      );
      let tagId: number | null = null;
      if (ins.rows.length > 0) {
        tagId = Number(ins.rows[0].id);
        colorSlot += 1;
        applied.push(`tag_created:${tagId}`);
      } else {
        // Colisão de APLICAÇÃO (o parser já converteu colisões de snapshot em editTags;
        // aqui só cai um nome que um humano criou entre o contexto e agora). Re-lê pra
        // saber se pode editar a description e pra pegar o id (retro segue valendo).
        const re = await pool.query(
          `/* pat_apply:tag_reread */ SELECT id, updated_by FROM whatsapp_tags
            WHERE workspace_id = $1 AND lower(name) = lower($2)`,
          [ws, t.name],
        );
        const row = re.rows[0];
        if (!row) {
          // Sumiu entre o INSERT e o SELECT (delete raro) — nada a fazer com esta tag.
          skipped.push(`tag_conflict:${t.name}:vanished`);
          continue;
        }
        tagId = Number(row.id);
        if (t.description != null) {
          const upd = await pool.query(
            `/* pat_apply:tag_update */ UPDATE whatsapp_tags SET description = $3, updated_by = 'ai'
              WHERE id = $1 AND workspace_id = $2 AND ${TAG_EDIT_GUARD}
              RETURNING id`,
            [tagId, ws, t.description],
          );
          if ((upd.rowCount ?? 0) > 0) applied.push(`tag_edited:${tagId}`);
          else skipped.push(`tag_conflict:${t.name}:human_owned`);
        } else {
          skipped.push(`tag_conflict:${t.name}:no_desc`);
        }
      }
      // Retro-etiquetagem (add-only) vale mesmo pra tag pré-existente (humana ou não): a
      // IA USA tags humanas, só não as reescreve. tagId resolvido acima em qualquer ramo.
      if (tagId != null) {
        for (const oppId of t.retroOpportunityIds) {
          const list = retroByOpp.get(oppId) ?? [];
          list.push({ tagId, tagName: t.name });
          retroByOpp.set(oppId, list);
        }
      }
    }
  }

  // ── (b) tags editadas (explícitas do parser) ──────────────────────────────────
  for (const e of decision.editTags) {
    const upd = await pool.query(
      `/* pat_apply:tag_update */ UPDATE whatsapp_tags SET description = $3, updated_by = 'ai'
        WHERE id = $1 AND workspace_id = $2 AND ${TAG_EDIT_GUARD}
        RETURNING id`,
      [e.id, ws, e.description],
    );
    if ((upd.rowCount ?? 0) > 0) applied.push(`tag_edited:${e.id}`);
    else skipped.push(`tag_edit:${e.id}:human_owned`);
  }

  // ── (c) motivos de perda novos ────────────────────────────────────────────────
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

  // ── (d) motivos de perda editados (explícitos do parser) ──────────────────────
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

  // ── (e) retro-etiquetagem (add-only, por opp, sob o lock do par) ──────────────
  for (const [oppId, tags] of retroByOpp) {
    // Lê o par (número, identifier) da opp ANTES do lock — a chave do lock é o par, não o id.
    const pairRes = await pool.query(
      `/* pat_apply:opp_pair */ SELECT whatsapp_number_id, identifier, workspace_id
         FROM whatsapp_opportunities WHERE id = $1`,
      [oppId],
    );
    const pair = pairRes.rows[0];
    if (!pair || pair.workspace_id !== ws) {
      // Opp sumiu ou é de outro workspace (defesa; o parser já limita a ctx.opportunityIds).
      for (const t of tags) skipped.push(`retro_tag:${oppId}:${t.tagId}:not_found`);
      continue;
    }
    const numberId = Number(pair.whatsapp_number_id);
    const identifier = String(pair.identifier);

    await d.withConversationLock(pool, numberId, identifier, async (client: PoolClient) => {
      // Sticky da opp: nomes de tags que um humano REMOVEU dela — a IA não re-adiciona.
      const sticky = await d.computeSticky(client, { numberId, identifier, opportunityId: oppId });
      const removed = new Set(sticky.tagsRemovedByHuman.map((s) => s.toLowerCase()));
      for (const t of tags) {
        if (removed.has(t.tagName.toLowerCase())) {
          skipped.push(`retro_tag:${oppId}:${t.tagId}:removed_by_human`);
          continue;
        }
        const ins = await client.query(
          `/* pat_apply:retro_tag_insert */ INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING tag_id`,
          [oppId, t.tagId],
        );
        if ((ins.rowCount ?? 0) > 0) {
          await d.insertEvent(client, {
            opportunityId: oppId, field: 'tag_added', oldValue: null, newValue: t.tagName, changedBy: 'ai',
          });
          applied.push(`retro_tag:${oppId}:${t.tagId}`);
        }
        // já presente na opp → no-op silencioso (sem evento).
      }
    });
  }

  // ── (f) backfill de loss_reason (spec §8): opps perdidas sem motivo → patch via kernel ──
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

  // ── (g) sugestões de guidance (humano aplica; dedupe por kind pending) ────────
  for (const gs of decision.guidanceSuggestions) {
    const current = gs.kind === 'guidance_lead' ? ctx.guidances.lead : ctx.guidances.qualified;
    const id = await d.insertSuggestion(pool, ws, gs.kind, {
      current: current ?? null, suggested: gs.suggested, reason: gs.reason,
    });
    if (id != null) applied.push(`suggestion:${gs.kind}`);
    else skipped.push(`suggestion:${gs.kind}:dedupe`);
  }

  // ── (h) insight semanal (1 por run) ───────────────────────────────────────────
  const insightId = await d.insertInsight(pool, ws, d.runId, decision.insightSummary, {
    applied: [...applied], skipped: [...skipped],
  });
  applied.push(`insight:${insightId}`);

  return { applied, skipped };
}
