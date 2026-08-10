/**
 * src/whatsapp/ai-judgment-context.ts
 *
 * Montagem DETERMINÍSTICA e READ-ONLY do contexto de uma conversa para o motor de
 * julgamento IA nível 1 (spec v3 §7). Só faz SELECTs — nenhuma escrita, nenhuma
 * chamada LLM. O resultado (JudgmentContext) é o snapshot que:
 *  - alimenta o prompt (`buildJudgmentPrompt`, ai-judgment-prompt.ts);
 *  - é re-lido/re-checado pelo aplicador atômico (D4, `applyJudgment`) sob o lock
 *    do par para detectar staleness antes de aplicar.
 *
 * `watermark` (max `input_last_message_at` do julgamento anterior) é ENTRADA — o
 * runner (D5) o calcula de whatsapp_ai_judgments e o passa aqui. As mensagens são
 * "novas desde o watermark" + uma cauda de contexto (caps abaixo). A row de
 * whatsapp_workspace_settings é lida read-only (o runner garante a existência — a
 * criação/seed com pipeline_since NUNCA acontece aqui).
 */
import type { Pool } from 'pg';
import { computeSticky, type StickyFlags } from './ai-sticky.js';
import { listLossReasons } from './loss-reasons.js';
import { listDisqualifyReasons } from './disqualify-reasons.js';

/** Cauda de contexto: últimas N mensagens em/antes do watermark. */
const TAIL_LIMIT = 30;
/** Teto total de mensagens no contexto (cauda + novas). */
const MAX_MESSAGES = 80;
/** Truncamento por mensagem (evita estourar o prompt com uma mensagem gigante). */
const MAX_TEXT_CHARS = 500;

export interface JudgmentMessage {
  direction: string;
  text: string;
  createdAt: string;
}

export interface OppSnapshot {
  id: number;
  title: string | null;
  status: 'em_andamento' | 'ganho' | 'perdido';
  isQualified: boolean | null;
  lossReason: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface JudgmentTriage {
  isLead: boolean | null;
  leadSource: string | null;
  notes: string | null;
}

export interface JudgmentSettings {
  newOppAfterDays: number;
  aiLeadGuidance: string | null;
  aiQualifiedGuidance: string | null;
}

export interface JudgmentLossReason {
  code: string;
  label: string;
  description: string | null;
}

/** Motivo de não-lead: o prompt mostra o `label`, mas a decisão/persistência (D4)
 *  usa o `code` (write-routes/lead-qualify validam disqualify_reason por code). */
export interface JudgmentNotLeadReason {
  code: string;
  label: string;
}

export interface JudgmentTag {
  id: number;
  name: string;
  description: string | null;
}

export interface JudgmentContext {
  numberId: number;
  identifier: string;
  workspaceId: string;
  /** max input_last_message_at do julgamento anterior (null = nunca julgado). */
  watermark: string | null;
  /** max created_at REAL da conversa (novo watermark do input); null = sem mensagens. */
  lastMessageAt: string | null;
  messages: JudgmentMessage[];
  triage: JudgmentTriage;
  openOpp: OppSnapshot | null;
  lastClosedOpp: OppSnapshot | null;
  settings: JudgmentSettings;
  lossReasons: JudgmentLossReason[];
  notLeadReasons: JudgmentNotLeadReason[];
  tags: JudgmentTag[];
  sticky: StickyFlags;
}

/** timestamptz do pg vem como Date; toleramos também string ISO (fakes/serialização). */
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof (v as { toISOString?: unknown })?.toISOString === 'function') {
    return (v as Date).toISOString();
  }
  return String(v);
}

function mapMessage(row: any): JudgmentMessage {
  const text = row.text == null ? '' : String(row.text);
  return {
    direction: row.direction,
    text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
    createdAt: toISO(row.created_at) ?? '',
  };
}

function mapOpp(row: any): OppSnapshot {
  return {
    id: Number(row.id),
    title: row.title ?? null,
    status: row.status,
    isQualified: row.is_qualified == null ? null : row.is_qualified === true,
    lossReason: row.loss_reason ?? null,
    tags: Array.isArray(row.tag_names) ? row.tag_names.filter((t: unknown) => t != null) : [],
    createdAt: toISO(row.created_at) ?? '',
    updatedAt: toISO(row.updated_at) ?? '',
    closedAt: toISO(row.closed_at),
  };
}

const MSG_BASE = `SELECT direction, text, created_at, id FROM messages
  WHERE whatsapp_number_id = $1 AND identifier = $2 AND workspace_id = $3`;

/**
 * Mensagens do contexto: novas desde o watermark + cauda das TAIL_LIMIT anteriores,
 * com teto MAX_MESSAGES mantendo SEMPRE as MAIS RECENTES (novas e cauda buscadas
 * DESC LIMIT + revertidas pra ASC — com >MAX_MESSAGES novas, fica com as recentes,
 * não com as antigas). `lastMessageAt` = created_at REAL da última mensagem da
 * conversa (não o fim da janela truncada); null se a conversa não tem mensagem.
 *
 * A partição cauda/novas trunca os DOIS lados pra MILISSEGUNDO porque o watermark
 * (input_last_message_at) foi gravado a partir de uma ISO string de JS e só tem ms,
 * enquanto messages.created_at tem µs — comparar cru joga a última mensagem JÁ julgada
 * no balde "novas" a cada run (mesma raiz do bug do PENDING_SQL, ai-judgment-runner.ts).
 */
async function fetchMessages(
  pool: Pool,
  numberId: number,
  identifier: string,
  workspaceId: string,
  watermark: string | null,
): Promise<{ messages: JudgmentMessage[]; lastMessageAt: string | null }> {
  let tailAsc: any[] = [];
  let freshDesc: any[] = [];
  if (watermark != null) {
    const newRes = await pool.query(
      `/* ctx:messages:new */ ${MSG_BASE} AND date_trunc('milliseconds', created_at) > $4 ORDER BY created_at DESC, id DESC LIMIT $5`,
      [numberId, identifier, workspaceId, watermark, MAX_MESSAGES],
    );
    freshDesc = newRes.rows;
    const tailRes = await pool.query(
      `/* ctx:messages:tail */ ${MSG_BASE} AND date_trunc('milliseconds', created_at) <= $4 ORDER BY created_at DESC, id DESC LIMIT $5`,
      [numberId, identifier, workspaceId, watermark, TAIL_LIMIT],
    );
    tailAsc = tailRes.rows.slice().reverse();
  } else {
    const allRes = await pool.query(
      `/* ctx:messages:new */ ${MSG_BASE} ORDER BY created_at DESC, id DESC LIMIT $4`,
      [numberId, identifier, workspaceId, MAX_MESSAGES],
    );
    freshDesc = allRes.rows;
  }
  const freshAsc = freshDesc.slice().reverse();
  let combined = [...tailAsc, ...freshAsc];
  if (combined.length > MAX_MESSAGES) combined = combined.slice(combined.length - MAX_MESSAGES);

  // Última mensagem REAL: topo do DESC das novas; sem novas, a mais recente da cauda.
  const newestRow = freshDesc[0] ?? tailAsc[tailAsc.length - 1] ?? null;
  const lastMessageAt = newestRow ? toISO(newestRow.created_at) : null;

  return { messages: combined.map(mapMessage), lastMessageAt };
}

async function fetchTriage(pool: Pool, numberId: number, identifier: string): Promise<JudgmentTriage> {
  const { rows } = await pool.query(
    `/* ctx:triage */ SELECT is_lead, lead_source, notes FROM whatsapp_thread_meta
      WHERE whatsapp_number_id = $1 AND identifier = $2`,
    [numberId, identifier],
  );
  const row = rows[0];
  if (!row) return { isLead: null, leadSource: null, notes: null };
  return {
    isLead: row.is_lead == null ? null : row.is_lead === true,
    leadSource: row.lead_source ?? null,
    notes: row.notes ?? null,
  };
}

async function fetchOpps(
  pool: Pool,
  numberId: number,
  identifier: string,
  workspaceId: string,
): Promise<OppSnapshot[]> {
  const { rows } = await pool.query(
    `/* ctx:opps */
     SELECT o.id, o.title, o.status, o.is_qualified, o.loss_reason,
            o.created_at, o.updated_at, o.closed_at,
            COALESCE(
              array_agg(t.name ORDER BY lower(t.name)) FILTER (WHERE t.name IS NOT NULL),
              ARRAY[]::text[]
            ) AS tag_names
       FROM whatsapp_opportunities o
       LEFT JOIN whatsapp_opportunity_tags ot ON ot.opportunity_id = o.id
       LEFT JOIN whatsapp_tags t ON t.id = ot.tag_id
      WHERE o.whatsapp_number_id = $1 AND o.identifier = $2 AND o.workspace_id = $3
      GROUP BY o.id
      ORDER BY o.created_at DESC, o.id DESC`,
    [numberId, identifier, workspaceId],
  );
  return rows.map(mapOpp);
}

async function fetchSettings(pool: Pool, workspaceId: string): Promise<JudgmentSettings> {
  const { rows } = await pool.query(
    `/* ctx:settings */ SELECT new_opp_after_days, ai_lead_guidance, ai_qualified_guidance
       FROM whatsapp_workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  // Row obrigatória em prod (garantida pelo runner); default só como salvaguarda
  // read-only — pipeline_since nunca é sintetizado aqui (não é lido).
  if (!row) return { newOppAfterDays: 30, aiLeadGuidance: null, aiQualifiedGuidance: null };
  return {
    newOppAfterDays: Number(row.new_opp_after_days),
    aiLeadGuidance: row.ai_lead_guidance ?? null,
    aiQualifiedGuidance: row.ai_qualified_guidance ?? null,
  };
}

async function fetchTags(pool: Pool, workspaceId: string): Promise<JudgmentTag[]> {
  const { rows } = await pool.query(
    `/* ctx:tags */ SELECT id, name, description FROM whatsapp_tags
      WHERE workspace_id = $1 ORDER BY lower(name), id`,
    [workspaceId],
  );
  return rows.map((r: any) => ({ id: Number(r.id), name: r.name, description: r.description ?? null }));
}

export async function buildJudgmentContext(
  pool: Pool,
  { numberId, identifier, workspaceId, watermark }: {
    numberId: number;
    identifier: string;
    workspaceId: string;
    watermark: string | null;
  },
): Promise<JudgmentContext> {
  const [msgResult, triage, opps, settings, tags, lossReasonsRaw, notLeadRaw] = await Promise.all([
    fetchMessages(pool, numberId, identifier, workspaceId, watermark),
    fetchTriage(pool, numberId, identifier),
    fetchOpps(pool, numberId, identifier, workspaceId),
    fetchSettings(pool, workspaceId),
    fetchTags(pool, workspaceId),
    listLossReasons(pool, workspaceId),
    listDisqualifyReasons(pool, { workspaceId }),
  ]);
  const { messages, lastMessageAt } = msgResult;

  const openOpp = opps.find((o) => o.status === 'em_andamento') ?? null;
  const lastClosedOpp = opps.find((o) => o.status === 'ganho' || o.status === 'perdido') ?? null;

  // Sticky é por-opp: a opp que a IA de fato tocaria. Aberta se existe; senão a
  // última fechada (para constranger reabrir/reclassificar); senão null (só is_lead,
  // que deriva do log da thread e independe de opp).
  const sticky = await computeSticky(pool, {
    numberId,
    identifier,
    opportunityId: openOpp?.id ?? lastClosedOpp?.id ?? null,
  });

  const lossReasons: JudgmentLossReason[] = lossReasonsRaw
    .filter((r) => r.active)
    .map((r) => ({ code: r.code, label: r.label, description: r.description }));
  const notLeadReasons: JudgmentNotLeadReason[] = notLeadRaw.map((r) => ({ code: r.code, label: r.label }));

  return {
    numberId,
    identifier,
    workspaceId,
    watermark: watermark ?? null,
    lastMessageAt,
    messages,
    triage,
    openOpp,
    lastClosedOpp,
    settings,
    lossReasons,
    notLeadReasons,
    tags,
    sticky,
  };
}
