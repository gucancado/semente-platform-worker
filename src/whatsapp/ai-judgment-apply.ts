/**
 * src/whatsapp/ai-judgment-apply.ts
 *
 * Aplicador ATÔMICO e STALE-SAFE do julgamento IA nível 1 (spec v3 §7 + §4.11). Recebe
 * o snapshot (JudgmentContext, D3) e a decisão já validada (JudgmentDecision, D3) e as
 * aplica TODAS sob o lock do par (número, identifier) numa única transação, relendo o
 * estado dentro do lock antes de escrever. Ator = 'ai' em toda escrita/evento (cascatas
 * de sistema, ex.: não-lead, mantêm 'system').
 *
 * Contrato (spec §7 — ordem obrigatória): lock → stale-checks → CLAIM → aplicações → commit.
 *  1. LOCK do par (withConversationLock — BEGIN + advisory xact lock + COMMIT/ROLLBACK).
 *  2. STALE: relê MAX(messages.created_at) do par; se avançou desde ctx.lastMessageAt →
 *     descarta a decisão (re-julga no próximo run), SEM escrever. Relê a opp aberta; se
 *     apareceu/sumiu/mudou (updated_at) em relação ao snapshot → idem.
 *  3. CLAIM: INSERT em whatsapp_ai_judgments ON CONFLICT DO NOTHING (UNIQUE por watermark)
 *     ANTES de qualquer mutação — conflito = já julgado → retorna sem aplicar nada
 *     (idempotência: retry pós-crash não re-julga). O `applied` real é gravado no fim.
 *  4. Recomputa sticky sob o lock e re-força null nas dimensões travadas (defesa em
 *     profundidade — o parseJudgmentDecision já filtrou contra o snapshot).
 *  5. Aplica na ORDEM: triagem → patch da opp aberta → closed_action → tags.
 *
 * NUNCA chama patchOpportunityGuarded/createOpportunityV3/moveOpportunity/
 * changeOpportunityTag/setLeadStatus — todas abrem o PRÓPRIO lock (pool.connect novo =
 * outra sessão = deadlock com o lock deste aplicador). Usa só os internals que aceitam o
 * `client` da transação: applyLeadUpdate, applyOppPatchInTx, insertOpportunityInTx,
 * insertEvent, countOpenOpportunities, computeSticky, isValidLossReason.
 */
import type { Pool, PoolClient } from 'pg';
import { withConversationLock } from './conversation-lock.js';
import { computeSticky } from './ai-sticky.js';
import {
  applyOppPatchInTx,
  countOpenOpportunities,
  insertEvent,
  insertOpportunityInTx,
} from './opportunities.js';
import { applyLeadUpdate, LeadCascadeGanhoError } from './thread-meta.js';
import { OppInvariantError, type OppPatchV3, type OppStateV3, type OppStatus } from './opportunity-core.js';
import { isValidLossReason } from './loss-reasons.js';
import type { JudgmentContext, OppSnapshot } from './ai-judgment-context.js';
import type { JudgmentDecision } from './ai-judgment-prompt.js';

export interface ApplyJudgmentResult {
  /** Rótulos do que foi de fato escrito (auditoria: 'triage:lead', 'qualify:true', 'tag:12'...). */
  applied: string[];
  /** Rótulos do que foi PULADO e por quê ('triage:possui_ganho', 'tag:12:removed_by_human'...). */
  skipped: string[];
  /** true = o snapshot ficou obsoleto sob o lock → nada foi escrito; re-julga no próximo run. */
  stale: boolean;
}

/** Colaboradores injetáveis (default = as funções reais); os testes puros injetam spies
 *  para provar a orquestração sem tocar Postgres. `model` vai pra coluna de auditoria. */
export interface ApplyJudgmentDeps {
  model?: string | null;
  /**
   * Dimensões que o validador (D3) anulou por trava humana (`sticky:is_lead`,
   * `sticky:qualify`, `sticky:status`). Entram no `skipped` da row de auditoria pra que
   * "quantas vezes o humano venceu a IA" seja consultável em SQL — antes disso o sticky
   * só existia em stdout. Não afeta nenhuma escrita: quando chega aqui a decisão já veio
   * com essas dimensões em null.
   */
  stickyDiscarded?: string[];
  computeSticky?: typeof computeSticky;
  applyLeadUpdate?: typeof applyLeadUpdate;
  applyOppPatchInTx?: typeof applyOppPatchInTx;
  insertOpportunityInTx?: typeof insertOpportunityInTx;
  insertEvent?: typeof insertEvent;
  countOpenOpportunities?: typeof countOpenOpportunities;
  isValidLossReason?: typeof isValidLossReason;
}

interface ResolvedDeps {
  model: string | null;
  computeSticky: typeof computeSticky;
  applyLeadUpdate: typeof applyLeadUpdate;
  applyOppPatchInTx: typeof applyOppPatchInTx;
  insertOpportunityInTx: typeof insertOpportunityInTx;
  insertEvent: typeof insertEvent;
  countOpenOpportunities: typeof countOpenOpportunities;
  isValidLossReason: typeof isValidLossReason;
}

function resolveDeps(deps: ApplyJudgmentDeps): ResolvedDeps {
  return {
    model: deps.model ?? null,
    computeSticky: deps.computeSticky ?? computeSticky,
    applyLeadUpdate: deps.applyLeadUpdate ?? applyLeadUpdate,
    applyOppPatchInTx: deps.applyOppPatchInTx ?? applyOppPatchInTx,
    insertOpportunityInTx: deps.insertOpportunityInTx ?? insertOpportunityInTx,
    insertEvent: deps.insertEvent ?? insertEvent,
    countOpenOpportunities: deps.countOpenOpportunities ?? countOpenOpportunities,
    isValidLossReason: deps.isValidLossReason ?? isValidLossReason,
  };
}

/** timestamptz do pg vem como Date; toleramos string ISO (fakes/serialização). */
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof (v as { toISOString?: unknown })?.toISOString === 'function') return (v as Date).toISOString();
  return String(v);
}

/** Estado + metadados de uma opp relidos DENTRO do lock (id/updatedAt p/ stale; state p/ patch). */
interface FreshOpp {
  id: number;
  updatedAt: string | null;
  state: OppStateV3;
}

function rowToFreshOpp(r: any): FreshOpp {
  return {
    id: Number(r.id),
    updatedAt: toISO(r.updated_at),
    state: {
      status: r.status as OppStatus,
      isQualified: r.is_qualified == null ? null : r.is_qualified === true,
      closedAt: r.closed_at ? toISO(r.closed_at) : null,
      title: r.title ?? null,
      lossReason: r.loss_reason ?? null,
    },
  };
}

const OPP_STATE_COLS = 'id, updated_at, status, is_qualified, closed_at, title, loss_reason';

/** Opp aberta (mais recente em_andamento) do par — spec §5 "opp mais recente". */
async function readOpenOpp(client: PoolClient, ctx: JudgmentContext): Promise<FreshOpp | null> {
  const { rows } = await client.query(
    `/* apply:open_opp */ SELECT ${OPP_STATE_COLS} FROM whatsapp_opportunities
      WHERE whatsapp_number_id = $1 AND identifier = $2 AND workspace_id = $3 AND status = 'em_andamento'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx.numberId, ctx.identifier, ctx.workspaceId],
  );
  return rows[0] ? rowToFreshOpp(rows[0]) : null;
}

/** Última opp FECHADA (ganho/perdido) do par — alvo de closed_action e do sticky quando não há aberta. */
async function readLastClosedOpp(client: PoolClient, ctx: JudgmentContext): Promise<FreshOpp | null> {
  const { rows } = await client.query(
    `/* apply:last_closed */ SELECT ${OPP_STATE_COLS} FROM whatsapp_opportunities
      WHERE whatsapp_number_id = $1 AND identifier = $2 AND workspace_id = $3 AND status IN ('ganho','perdido')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx.numberId, ctx.identifier, ctx.workspaceId],
  );
  return rows[0] ? rowToFreshOpp(rows[0]) : null;
}

/**
 * Um snapshot de opp (aberta OU última fechada) ficou obsoleto sob o lock?
 * (spec §7 stale-recheck):
 *  - snapshot sem opp, mas agora existe → stale (surgiu uma);
 *  - snapshot com opp, mas sumiu / virou outra (id) / foi mutada (updated_at) → stale.
 * Usado pros DOIS alvos: a opp ABERTA (que a IA patcharia) e a última FECHADA (alvo de
 * closed_action e base do sticky quando não há aberta) — uma opp criada+fechada durante
 * a call LLM tornaria criar_nova/reabrir uma decisão sobre estado velho.
 */
function oppSnapshotStale(snap: OppSnapshot | null, fresh: FreshOpp | null): boolean {
  if (snap == null) return fresh != null;
  if (fresh == null) return true;
  if (fresh.id !== snap.id) return true;
  return fresh.updatedAt !== snap.updatedAt;
}

/** Alvo das tags: opp aberta (mais recente) se houver, senão a mais recente (fechada). */
async function resolveTagTargetOpp(client: PoolClient, ctx: JudgmentContext): Promise<number | null> {
  const { rows } = await client.query(
    `/* apply:tag_target */ SELECT id FROM whatsapp_opportunities
      WHERE whatsapp_number_id = $1 AND identifier = $2 AND workspace_id = $3
      ORDER BY (status = 'em_andamento') DESC, created_at DESC, id DESC LIMIT 1`,
    [ctx.numberId, ctx.identifier, ctx.workspaceId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function applyJudgment(
  pool: Pool,
  ctx: JudgmentContext,
  decision: JudgmentDecision,
  deps: ApplyJudgmentDeps = {},
): Promise<ApplyJudgmentResult> {
  // Sem mensagem, não há o que julgar — nem watermark pra gravar. Não abre lock nem claim.
  if (ctx.lastMessageAt == null) {
    return { applied: [], skipped: ['no_last_message'], stale: false };
  }
  const d = resolveDeps(deps);
  const ctxLastMs = new Date(ctx.lastMessageAt).getTime();

  return withConversationLock<ApplyJudgmentResult>(pool, ctx.numberId, ctx.identifier, async (client) => {
    const applied: string[] = [];
    // Semeado com o que o validador já anulou por trava humana: a auditoria tem que
    // registrar a dimensão que a IA TENTOU mexer e não pôde, não só o que ela escreveu.
    const skipped: string[] = [...(deps.stickyDiscarded ?? [])];

    // ── 1. STALE: chegou mensagem nova desde o snapshot? ──
    const wm = await client.query(
      `/* apply:watermark */ SELECT MAX(created_at) AS m FROM messages
        WHERE whatsapp_number_id = $1 AND identifier = $2 AND workspace_id = $3`,
      [ctx.numberId, ctx.identifier, ctx.workspaceId],
    );
    const freshLast = wm.rows[0]?.m ?? null;
    const freshLastMs = freshLast ? new Date(freshLast).getTime() : null;
    if (freshLastMs == null || freshLastMs > ctxLastMs) {
      return { applied, skipped, stale: true };
    }

    // ── 2. STALE: a opp aberta mudou/sumiu/apareceu? ──
    const freshOpen = await readOpenOpp(client, ctx);
    if (oppSnapshotStale(ctx.openOpp, freshOpen)) {
      return { applied, skipped, stale: true };
    }

    // ── 2b. STALE: a última opp FECHADA mudou/sumiu/apareceu? Quando o snapshot não tinha
    // aberta, checar só "segue sem aberta" não basta: uma opp criada E fechada durante a
    // call LLM faria o closed_action=criar_nova nascer sobre uma base fechada velha (3ª opp
    // indevida). Relê a última fechada e compara id+updated_at (mesmo toISO ms). Reusa
    // `freshClosed` no sticky abaixo (evita reler). ──
    const freshClosed = await readLastClosedOpp(client, ctx);
    if (oppSnapshotStale(ctx.lastClosedOpp, freshClosed)) {
      return { applied, skipped, stale: true };
    }

    // ── 3. CLAIM (idempotência) — INSERT ON CONFLICT DO NOTHING ANTES de qualquer escrita.
    // `applied` entra placeholder e é sobrescrito no fim (mesma transação).
    const claim = await client.query(
      `/* apply:claim */ INSERT INTO whatsapp_ai_judgments
         (whatsapp_number_id, identifier, workspace_id, input_last_message_at, decision, applied, rationale, model)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, '[]'::jsonb, $6, $7)
       ON CONFLICT (whatsapp_number_id, identifier, input_last_message_at) DO NOTHING
       RETURNING id`,
      [ctx.numberId, ctx.identifier, ctx.workspaceId, ctx.lastMessageAt,
        JSON.stringify(decision), decision.rationale ?? null, d.model],
    );
    if (claim.rows.length === 0) {
      return { applied: [], skipped: ['already_judged'], stale: false };
    }
    const judgmentId = Number(claim.rows[0].id);

    // ── 4. Sticky recomputado sob o lock (defesa em profundidade) — reusa freshClosed (2b) ──
    const stickyOppId = freshOpen?.id ?? freshClosed?.id ?? null;
    const sticky = await d.computeSticky(client, {
      numberId: ctx.numberId, identifier: ctx.identifier, opportunityId: stickyOppId,
    });

    // ── 5a. Triagem ──
    let triage = decision.triage;
    if (sticky.isLead && triage !== null) {
      skipped.push('triage:locked');
      triage = null;
    }
    if (triage === 'lead') {
      await d.applyLeadUpdate(client, {
        numberId: ctx.numberId, identifier: ctx.identifier, isLead: true, updatedBy: 'ai',
      });
      applied.push('triage:lead');
    } else if (triage === 'not_lead') {
      try {
        await d.applyLeadUpdate(client, {
          numberId: ctx.numberId, identifier: ctx.identifier, isLead: false, updatedBy: 'ai',
          disqualifyReason: decision.notLeadReason ?? null,
          disqualifyReasonPresent: decision.notLeadReason != null,
        });
        applied.push('triage:not_lead');
      } catch (err) {
        // Opp ganha bloqueia a cascata não-lead (§4.8) — o SELECT do ganho teve sucesso,
        // o throw é JS puro (nada escrito, transação sã) → pula só a triagem e segue.
        if (err instanceof LeadCascadeGanhoError) skipped.push('triage:possui_ganho');
        else throw err;
      }
    }

    // ── 5b. Patch da opp aberta (relê o estado FRESCO pós-triagem) ──
    if (decision.openOpp != null) {
      const cur = await readOpenOpp(client, ctx);
      if (cur == null) {
        // Sem opp aberta agora (ex.: triagem não-lead cascateou o fechamento).
        skipped.push('open_opp:no_open_opp');
      } else {
        let qualify = decision.openOpp.qualify;
        let status = decision.openOpp.status;
        let lossReason = decision.openOpp.lossReason;
        if (sticky.isQualified && qualify !== null) { skipped.push('qualify:locked'); qualify = null; }
        if (sticky.status && status !== null) { skipped.push('status:locked'); status = null; }
        if (sticky.lossReason && lossReason !== null) { skipped.push('loss_reason:locked'); lossReason = null; }
        // Coerência: motivo de perda só quando a opp vai/está perdida (qualify=false → perdido).
        const willBeLost = status === 'perdido' || qualify === false;
        if (lossReason !== null && !willBeLost) { skipped.push('loss_reason:incoherent'); lossReason = null; }
        // Re-valida o motivo contra o catálogo FRESCO (humano pode ter desativado sob o lock).
        if (lossReason !== null && !(await d.isValidLossReason(client, ctx.workspaceId, lossReason))) {
          skipped.push('loss_reason:invalid');
          lossReason = null;
        }
        const patch: OppPatchV3 = {};
        if (qualify !== null) patch.isQualified = qualify;
        if (status !== null) patch.status = status;
        if (lossReason !== null) patch.lossReason = lossReason;
        if (Object.keys(patch).length > 0) {
          try {
            const res = await d.applyOppPatchInTx(
              client, cur.id, cur.state, patch, 'ai', { numberId: ctx.numberId, identifier: ctx.identifier },
            );
            if (res.oppChanged || res.threadChanged) {
              if (patch.isQualified !== undefined) applied.push(`qualify:${patch.isQualified}`);
              if (patch.status !== undefined) applied.push(`status:${patch.status}`);
              if (patch.lossReason !== undefined) applied.push(`loss_reason:${patch.lossReason}`);
            }
          } catch (err) {
            // Invariante de kernel (pura, throw antes de qualquer SQL) → pula só o patch.
            if (err instanceof OppInvariantError) skipped.push(`open_opp:${err.code}`);
            else throw err;
          }
        }
      }
    }

    // ── 5c. closed_action (só quando não há opp aberta; parse já dropa com aberta) ──
    let createdOppId: number | null = null;
    if (decision.closedAction === 'reabrir' || decision.closedAction === 'criar_nova') {
      const openCount = await d.countOpenOpportunities(client, ctx.numberId, ctx.identifier);
      if (openCount > 0) {
        skipped.push('closed_action:open_exists');
      } else if (decision.closedAction === 'reabrir') {
        const closed = await readLastClosedOpp(client, ctx);
        if (closed == null) skipped.push('closed_action:no_closed_opp');
        else if (closed.state.status === 'ganho') skipped.push('closed_action:reabrir_ganho'); // §6: ganho nunca reabre
        else if (sticky.status) skipped.push('closed_action:reabrir_locked');
        else {
          try {
            await d.applyOppPatchInTx(
              client, closed.id, closed.state, { status: 'em_andamento' }, 'ai',
              { numberId: ctx.numberId, identifier: ctx.identifier },
            );
            applied.push('reopen');
          } catch (err) {
            if (err instanceof OppInvariantError) skipped.push(`closed_action:${err.code}`);
            else throw err;
          }
        }
      } else {
        // criar_nova: nenhuma aberta (re-checado acima) → opp nova em_andamento/indefinido, ator 'ai'.
        createdOppId = await d.insertOpportunityInTx(client, {
          numberId: ctx.numberId, workspaceId: ctx.workspaceId, identifier: ctx.identifier,
          isQualified: null, createdBy: 'ai',
        });
        applied.push('criar_nova');
      }
    }

    // ── 5d. Tags (add-only; nunca re-adiciona tag que humano removeu daquela opp) ──
    if (decision.tags.length > 0) {
      const target = createdOppId ?? (await resolveTagTargetOpp(client, ctx));
      if (target == null) {
        for (const id of decision.tags) skipped.push(`tag:${id}:no_target`);
      } else {
        // A trava só se aplica à MESMA opp cujo histórico gerou o sticky; opp nova = sem histórico.
        const removed = target === stickyOppId ? sticky.tagsRemovedByHuman : [];
        const removedSet = new Set(removed.map((s) => s.toLowerCase()));
        for (const tagId of decision.tags) {
          const tagRes = await client.query(
            `/* apply:tag_name */ SELECT name FROM whatsapp_tags WHERE id = $1 AND workspace_id = $2`,
            [tagId, ctx.workspaceId],
          );
          const name = tagRes.rows[0]?.name;
          if (name == null) { skipped.push(`tag:${tagId}:not_found`); continue; }
          if (removedSet.has(String(name).toLowerCase())) { skipped.push(`tag:${tagId}:removed_by_human`); continue; }
          const ins = await client.query(
            `/* apply:tag_insert */ INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING tag_id`,
            [target, tagId],
          );
          if ((ins.rowCount ?? 0) > 0) {
            await d.insertEvent(client, {
              opportunityId: target, field: 'tag_added', oldValue: null, newValue: String(name), changedBy: 'ai',
            });
            applied.push(`tag:${tagId}`);
          }
          // já presente na opp → no-op silencioso (sem evento).
        }
      }
    }

    // ── 6. Grava o `applied` real na row de auditoria (o claim tinha placeholder) ──
    await client.query(
      `/* apply:applied_update */ UPDATE whatsapp_ai_judgments SET applied = $2::jsonb WHERE id = $1`,
      [judgmentId, JSON.stringify({ applied, skipped })],
    );

    return { applied, skipped, stale: false };
  });
}

/** Teto do texto bruto gravado em decision.raw (evita persistir um output gigante do LLM). */
const UNAPPLIED_RAW_MAX = 2000;

export interface RecordUnappliedResult {
  /** true = row de julgamento criada (claim ganho); false = já havia julgamento p/ esse watermark. */
  recorded: boolean;
  /** true = chegou mensagem nova sob o lock → NÃO cravou o watermark velho (re-julga no próximo run). */
  stale: boolean;
}

/**
 * Grava um julgamento NÃO-APLICADO (decisão do LLM inválida/irrecuperável) na
 * whatsapp_ai_judgments — MESMO claim que o applyJudgment usa, mas SEM nenhuma escrita de
 * opp/thread. Fix de runaway de custo: sem esta gravação, o watermark do par não avança e o
 * runner re-chama o LLM a cada tick pra a mesma conversa (custo repetido, potencialmente
 * milhares de calls/janela com CRM_AI_TICK_MS curto). Com ela, o UNIQUE (número, identifier,
 * input_last_message_at) marca o input como já visto e a query de pendentes não re-seleciona
 * a conversa até chegar mensagem nova.
 *
 * Contrato: lock do par → stale MÍNIMO (só watermark: se mensagem nova chegou, o input mudou
 * e NÃO se crava o watermark velho — re-julga no próximo run) → CLAIM (decision={raw truncado,
 * invalid:true, reason}, applied='[]', rationale=reason) ON CONFLICT DO NOTHING. Nenhuma
 * mutação de opp/thread; não recomputa sticky nem relê opps.
 */
export async function recordUnappliedJudgment(
  pool: Pool,
  ctx: JudgmentContext,
  rawDecision: string,
  reason: string,
  opts: { model?: string | null } = {},
): Promise<RecordUnappliedResult> {
  if (ctx.lastMessageAt == null) {
    return { recorded: false, stale: false };
  }
  const ctxLastMs = new Date(ctx.lastMessageAt).getTime();
  return withConversationLock<RecordUnappliedResult>(pool, ctx.numberId, ctx.identifier, async (client) => {
    const wm = await client.query(
      `/* apply:watermark */ SELECT MAX(created_at) AS m FROM messages
        WHERE whatsapp_number_id = $1 AND identifier = $2 AND workspace_id = $3`,
      [ctx.numberId, ctx.identifier, ctx.workspaceId],
    );
    const freshLast = wm.rows[0]?.m ?? null;
    const freshLastMs = freshLast ? new Date(freshLast).getTime() : null;
    if (freshLastMs == null || freshLastMs > ctxLastMs) {
      return { recorded: false, stale: true };
    }
    const raw = rawDecision.length > UNAPPLIED_RAW_MAX ? rawDecision.slice(0, UNAPPLIED_RAW_MAX) : rawDecision;
    const decision = JSON.stringify({ raw, invalid: true, reason });
    const claim = await client.query(
      `/* apply:claim */ INSERT INTO whatsapp_ai_judgments
         (whatsapp_number_id, identifier, workspace_id, input_last_message_at, decision, applied, rationale, model)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, '[]'::jsonb, $6, $7)
       ON CONFLICT (whatsapp_number_id, identifier, input_last_message_at) DO NOTHING
       RETURNING id`,
      [ctx.numberId, ctx.identifier, ctx.workspaceId, ctx.lastMessageAt, decision, reason, opts.model ?? null],
    );
    return { recorded: claim.rows.length > 0, stale: false };
  });
}
