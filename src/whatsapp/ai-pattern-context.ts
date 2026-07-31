/**
 * src/whatsapp/ai-pattern-context.ts
 *
 * Montagem DETERMINÍSTICA e READ-ONLY da matéria-prima do motor de IA nível 2 — a
 * análise SEMANAL de padrões (spec v3 §8). Só faz SELECTs; nenhuma escrita, nenhuma
 * chamada LLM. O PatternContext resultante alimenta `buildPatternPrompt`
 * (ai-pattern-prompt.ts) e, junto da decisão validada, o aplicador da Task E3.
 *
 * Matéria-prima (spec §8): os RATIONALES dos julgamentos da semana (sem reler conversas
 * cruas) + catálogos de tags/motivos (com autoria pra saber o que a IA pode reescrever)
 * + agregados do funil na janela. Os rationales são derivados, mas podem ECOAR texto de
 * cliente — recebem o MESMO sanitizador anti-injeção do nível 1 (‹›), aplicado aqui.
 *
 * `periodStart`/`periodEnd` são DATEs (as colunas de whatsapp_ai_pattern_runs). A janela
 * é meia-aberta `[periodStart, periodEnd + 1 dia)` para incluir o dia inteiro de
 * periodEnd (comparar `created_at <= periodEnd::date` cairia à meia-noite e cortaria o
 * último dia). Todos os agregados EXCLUEM `loss_reason='nao_lead'` (cascata não-lead fora
 * de relatórios — spec §5/§10), espelhando stats.ts.
 */
import type { Pool } from 'pg';
import { sanitizeMessageText } from './ai-judgment-prompt.js';
import { isHumanActor } from './ai-sticky.js';
import { SYSTEM_LOSS_REASONS } from './loss-reasons.js';

/** Teto de julgamentos coletados (mais recentes primeiro — spec §8). */
const MAX_JUDGMENTS = 200;
/** Teto de ids de oportunidades citáveis pra retro-etiquetagem (evita prompt gigante). */
const MAX_OPPORTUNITY_IDS = 300;
/** Teto de opps perdidas sem motivo candidatas a backfill de loss_reason (spec §8). */
const MAX_LOSS_BACKFILL_CANDIDATES = 20;

export interface PatternJudgment {
  identifier: string;
  /** rationale do julgamento, já sanitizado (anti-injeção ‹›). */
  rationale: string;
  /** rótulos do que a IA nível 1 de fato aplicou ('triage:lead', 'tag:12', 'status:perdido'...). */
  applied: string[];
  decidedAt: string;
}

export interface PatternTag {
  id: number;
  name: string;
  description: string | null;
  /** true = updated_by humano → a IA pode USAR mas NÃO renomear/re-descrever (sticky §8). */
  humanOwned: boolean;
}

export interface PatternLossReason {
  /** ausente nos motivos de SISTEMA (não têm row); presente nos custom do catálogo. */
  id?: number;
  code: string;
  label: string;
  description: string | null;
  active: boolean;
  /** true = motivo de sistema (lead/atendente não respondeu) — nunca editável. */
  system: boolean;
  humanOwned: boolean;
}

export interface PatternAggregates {
  byOpportunityTag: Record<string, number>;
  byLossReason: Record<string, number>;
  byOpportunityStatus: Record<string, number>;
}

export interface PatternGuidances {
  lead: string | null;
  qualified: string | null;
}

export interface PatternTriageCounts {
  judged: number;
  toLead: number;
  toNotLead: number;
}

/**
 * Candidata a backfill de loss_reason (spec §8): opp `perdido` com loss_reason NULL, criada
 * na janela OU migrada da v1 (created_by='migration'), sem evento humano de motivo (o sticky
 * é re-checado no aplicador sob o lock — aqui a lista é só sugestiva pro prompt). `rationale`
 * = do julgamento nível 1 que fechou a opp como perdida (quando houver), sanitizado (‹›): é a
 * evidência textual que o nível 2 usa pra escolher o código — na ausência, a IA deve omitir.
 */
export interface PatternLossBackfillCandidate {
  opportunityId: number;
  rationale: string | null;
}

export interface PatternContext {
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  judgments: PatternJudgment[];
  tags: PatternTag[];
  lossReasons: PatternLossReason[];
  aggregates: PatternAggregates;
  guidances: PatternGuidances;
  /** Derivadas dos julgamentos coletados (cap MAX_JUDGMENTS) — spec §8. */
  triageCounts: PatternTriageCounts;
  /** Opps da janela (excl. nao_lead) citáveis pra retro-etiquetagem — whitelist do validador. */
  opportunityIds: number[];
  /** Opps perdidas sem motivo (janela OU migração) candidatas a backfill — whitelist do validador. */
  lossBackfillCandidates: PatternLossBackfillCandidate[];
}

/** timestamptz do pg vem como Date; toleramos string ISO (fakes/serialização). */
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof (v as { toISOString?: unknown })?.toISOString === 'function') return (v as Date).toISOString();
  return String(v);
}

/**
 * `applied` da whatsapp_ai_judgments é jsonb: `{applied:[...],skipped:[...]}` (aplicado)
 * ou `[]` (placeholder/unapplied). node-pg já entrega parseado. Extrai a lista de rótulos
 * dos DOIS formatos, filtrando não-strings.
 */
function extractApplied(v: unknown): string[] {
  const arr = Array.isArray(v)
    ? v
    : v && typeof v === 'object' && Array.isArray((v as { applied?: unknown }).applied)
      ? (v as { applied: unknown[] }).applied
      : [];
  return arr.filter((x): x is string => typeof x === 'string');
}

// Janela meia-aberta [periodStart, periodEnd+1dia): inclui o dia inteiro de periodEnd.
const WINDOW = `o.created_at >= $2::date AND o.created_at < ($3::date + INTERVAL '1 day')`;
// Cascata não-lead fica FORA de todos os agregados de relatório (spec §5/§10).
const NOT_NAO_LEAD = `(o.loss_reason IS DISTINCT FROM 'nao_lead')`;

async function fetchJudgments(pool: Pool, workspaceId: string, periodStart: string, periodEnd: string): Promise<PatternJudgment[]> {
  // Exclui julgamentos INVÁLIDOS (recordUnappliedJudgment grava decision={invalid:true,...}):
  // o rationale deles é a mensagem de erro do parser, não um padrão de negócio.
  const { rows } = await pool.query(
    `/* pat:judgments */
     SELECT identifier, rationale, applied, decided_at
       FROM whatsapp_ai_judgments
      WHERE workspace_id = $1
        AND decided_at >= $2::date AND decided_at < ($3::date + INTERVAL '1 day')
        AND (decision->>'invalid') IS DISTINCT FROM 'true'
      ORDER BY decided_at DESC, id DESC
      LIMIT $4`,
    [workspaceId, periodStart, periodEnd, MAX_JUDGMENTS],
  );
  return rows.map((r: any) => ({
    identifier: String(r.identifier),
    rationale: sanitizeMessageText(r.rationale == null ? '' : String(r.rationale)),
    applied: extractApplied(r.applied),
    decidedAt: toISO(r.decided_at) ?? '',
  }));
}

async function fetchTags(pool: Pool, workspaceId: string): Promise<PatternTag[]> {
  const { rows } = await pool.query(
    `/* pat:tags */ SELECT id, name, description, updated_by FROM whatsapp_tags
      WHERE workspace_id = $1 ORDER BY lower(name), id`,
    [workspaceId],
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    name: r.name,
    description: r.description ?? null,
    humanOwned: isHumanActor(r.updated_by),
  }));
}

async function fetchLossReasons(pool: Pool, workspaceId: string): Promise<PatternLossReason[]> {
  const { rows } = await pool.query(
    `/* pat:loss_reasons */ SELECT id, code, label, description, active, updated_by
       FROM whatsapp_loss_reasons WHERE workspace_id = $1 ORDER BY lower(label), id`,
    [workspaceId],
  );
  const custom: PatternLossReason[] = rows.map((r: any) => ({
    id: Number(r.id),
    code: r.code,
    label: r.label,
    description: r.description ?? null,
    active: r.active === true,
    system: false,
    humanOwned: isHumanActor(r.updated_by),
  }));
  // Motivos de sistema (sem row) sempre presentes — a IA os conhece pra não recriar.
  const system: PatternLossReason[] = SYSTEM_LOSS_REASONS.map((r) => ({
    code: r.code,
    label: r.label,
    description: null,
    active: true,
    system: true,
    humanOwned: false,
  }));
  return [...system, ...custom];
}

async function fetchAggregate(
  pool: Pool,
  marker: string,
  sql: string,
  workspaceId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Record<string, number>> {
  const { rows } = await pool.query(`${marker}\n${sql}`, [workspaceId, periodStart, periodEnd]);
  const out: Record<string, number> = {};
  for (const r of rows as any[]) out[String(r.key)] = Number(r.cnt);
  return out;
}

async function fetchGuidances(pool: Pool, workspaceId: string): Promise<PatternGuidances> {
  const { rows } = await pool.query(
    `/* pat:settings */ SELECT ai_lead_guidance, ai_qualified_guidance
       FROM whatsapp_workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  // READ-ONLY: nunca cria a row aqui (getOrCreateSettings faria INSERT). Sem row → ambos null.
  if (!row) return { lead: null, qualified: null };
  return { lead: row.ai_lead_guidance ?? null, qualified: row.ai_qualified_guidance ?? null };
}

async function fetchOpportunityIds(pool: Pool, workspaceId: string, periodStart: string, periodEnd: string): Promise<number[]> {
  const { rows } = await pool.query(
    `/* pat:opp_ids */ SELECT o.id FROM whatsapp_opportunities o
      WHERE o.workspace_id = $1 AND ${NOT_NAO_LEAD} AND ${WINDOW}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $4`,
    [workspaceId, periodStart, periodEnd, MAX_OPPORTUNITY_IDS],
  );
  return rows.map((r: any) => Number(r.id));
}

/**
 * Candidatas a backfill de loss_reason: opps `perdido` com loss_reason NULL, na janela OU
 * migradas da v1 (`created_by='migration'` — a migração deixou as perdidas históricas sem
 * motivo, exatamente o que o nível 2 preenche). LEFT JOIN LATERAL pro rationale do julgamento
 * que aplicou `status:perdido` no par (mais recente), sanitizado (‹›). O guard-final (sticky
 * sem evento humano de loss_reason + status ainda 'perdido') é re-checado no aplicador sob o
 * lock — aqui só listamos a matéria pro prompt. `nao_lead` já está fora (loss_reason NULL).
 */
async function fetchLossBackfillCandidates(
  pool: Pool, workspaceId: string, periodStart: string, periodEnd: string,
): Promise<PatternLossBackfillCandidate[]> {
  const { rows } = await pool.query(
    `/* pat:loss_backfill */
     SELECT o.id AS opportunity_id, j.rationale
       FROM whatsapp_opportunities o
       LEFT JOIN LATERAL (
         SELECT jj.rationale
           FROM whatsapp_ai_judgments jj
          WHERE jj.whatsapp_number_id = o.whatsapp_number_id AND jj.identifier = o.identifier
            AND jsonb_typeof(jj.applied -> 'applied') = 'array'
            AND (jj.applied -> 'applied') ? 'status:perdido'
          ORDER BY jj.decided_at DESC, jj.id DESC
          LIMIT 1
       ) j ON TRUE
      WHERE o.workspace_id = $1
        AND o.status = 'perdido'
        AND o.loss_reason IS NULL
        AND ( ${WINDOW} OR o.created_by = 'migration' )
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $4`,
    [workspaceId, periodStart, periodEnd, MAX_LOSS_BACKFILL_CANDIDATES],
  );
  return rows.map((r: any) => ({
    opportunityId: Number(r.opportunity_id),
    rationale: r.rationale == null ? null : sanitizeMessageText(String(r.rationale)),
  }));
}

export async function buildPatternContext(
  pool: Pool,
  { workspaceId, periodStart, periodEnd }: { workspaceId: string; periodStart: string; periodEnd: string },
): Promise<PatternContext> {
  const [judgments, tags, lossReasons, byOpportunityStatus, byLossReason, byOpportunityTag, guidances, opportunityIds, lossBackfillCandidates] =
    await Promise.all([
      fetchJudgments(pool, workspaceId, periodStart, periodEnd),
      fetchTags(pool, workspaceId),
      fetchLossReasons(pool, workspaceId),
      fetchAggregate(
        pool,
        '/* pat:agg:status */',
        `SELECT o.status AS key, COUNT(*)::int AS cnt
           FROM whatsapp_opportunities o
          WHERE o.workspace_id = $1 AND ${NOT_NAO_LEAD} AND ${WINDOW}
          GROUP BY o.status`,
        workspaceId,
        periodStart,
        periodEnd,
      ),
      fetchAggregate(
        pool,
        '/* pat:agg:loss */',
        `SELECT COALESCE(o.loss_reason, 'null') AS key, COUNT(*)::int AS cnt
           FROM whatsapp_opportunities o
          WHERE o.workspace_id = $1 AND o.status = 'perdido' AND ${NOT_NAO_LEAD} AND ${WINDOW}
          GROUP BY 1`,
        workspaceId,
        periodStart,
        periodEnd,
      ),
      fetchAggregate(
        pool,
        '/* pat:agg:tag */',
        `SELECT t.name AS key, COUNT(DISTINCT o.id)::int AS cnt
           FROM whatsapp_opportunities o
           JOIN whatsapp_opportunity_tags ot ON ot.opportunity_id = o.id
           JOIN whatsapp_tags t ON t.id = ot.tag_id AND t.workspace_id = $1
          WHERE o.workspace_id = $1 AND ${NOT_NAO_LEAD} AND ${WINDOW}
          GROUP BY t.id, t.name`,
        workspaceId,
        periodStart,
        periodEnd,
      ),
      fetchGuidances(pool, workspaceId),
      fetchOpportunityIds(pool, workspaceId, periodStart, periodEnd),
      fetchLossBackfillCandidates(pool, workspaceId, periodStart, periodEnd),
    ]);

  // triageCounts derivados dos julgamentos coletados (cap MAX_JUDGMENTS) — os rótulos
  // 'triage:lead'/'triage:not_lead' são gravados pelo aplicador nível 1 (ai-judgment-apply).
  let toLead = 0;
  let toNotLead = 0;
  for (const j of judgments) {
    if (j.applied.includes('triage:lead')) toLead++;
    else if (j.applied.includes('triage:not_lead')) toNotLead++;
  }

  return {
    workspaceId,
    periodStart,
    periodEnd,
    judgments,
    tags,
    lossReasons,
    aggregates: { byOpportunityTag, byLossReason, byOpportunityStatus },
    guidances,
    triageCounts: { judged: judgments.length, toLead, toNotLead },
    opportunityIds,
    lossBackfillCandidates,
  };
}
