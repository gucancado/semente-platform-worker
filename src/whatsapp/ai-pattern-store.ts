/**
 * src/whatsapp/ai-pattern-store.ts
 *
 * Data layer do motor de IA nível 2 (análise semanal de padrões — spec
 * beeads-central-de-dados/docs/superpowers/specs/2026-07-29-crm-whatsapp-v3-kanban-ia-design.md
 * §3.2/§8, migration 055): claim/finish/fail de `whatsapp_ai_pattern_runs`, dedupe de
 * `whatsapp_ai_suggestions` (nível 2 → humano, nunca aplicado automaticamente) e escrita
 * de `whatsapp_ai_insights` (relatório semanal). Consumido pelo runner (Task E3) — este
 * módulo não decide NADA sobre conteúdo (tags/motivos/guidance), só persiste.
 *
 * Todas as funções recebem `Pool` (não `PoolClient`): ao contrário do aplicador de
 * julgamento (D4, por-conversa, sob `pg_advisory_xact_lock`), este data layer é
 * workspace-level e não participa do lock por par — o runner semanal (E3) chama direto
 * no `pool` top-level.
 */
import type { Pool } from 'pg';

export type PatternRunStatus = 'running' | 'done' | 'failed';
export type SuggestionKind = 'guidance_lead' | 'guidance_qualified';
export type SuggestionStatus = 'pending' | 'applied' | 'dismissed';

export interface ClaimPatternRunResult {
  runId: number;
  /** true = row existente com status='failed' foi retomada (não é claim novo). */
  resumed: boolean;
}

export interface Suggestion {
  id: number;
  workspaceId: string;
  kind: SuggestionKind;
  payload: unknown;
  status: SuggestionStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface Insight {
  id: number;
  workspaceId: string;
  runId: number | null;
  runAt: string;
  summary: string;
  details: unknown;
}

/** timestamptz do pg vem como Date; toleramos string ISO (fakes/serialização). */
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof (v as { toISOString?: unknown })?.toISOString === 'function') return (v as Date).toISOString();
  return String(v);
}

function mapSuggestion(row: any): Suggestion {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    createdAt: toISO(row.created_at) as string,
    resolvedAt: toISO(row.resolved_at),
    resolvedBy: row.resolved_by ?? null,
  };
}

function mapInsight(row: any): Insight {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    runId: row.run_id == null ? null : Number(row.run_id),
    runAt: toISO(row.run_at) as string,
    summary: row.summary,
    details: row.details ?? null,
  };
}

/**
 * Claim idempotente da run semanal de um workspace (spec §8 — molde `claimNight`,
 * src/lua/db.ts): a INSERÇÃO É O CLAIM via UNIQUE (workspace_id, period_start).
 *  - INSERT ganha (row nova) → { runId, resumed: false }.
 *  - Conflito → relê a row existente:
 *    - status='failed' (tentativa anterior morreu) → UPDATE pra 'running' (reseta
 *      started_at/finished_at) e RETOMA → { runId, resumed: true }.
 *    - status='running' (outra réplica/tick em progresso) ou 'done' (semana já
 *      processada) → null, não faz nada.
 */
export async function claimPatternRun(
  pool: Pool,
  workspaceId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ClaimPatternRunResult | null> {
  const ins = await pool.query(
    `INSERT INTO whatsapp_ai_pattern_runs (workspace_id, period_start, period_end)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, period_start) DO NOTHING
     RETURNING id`,
    [workspaceId, periodStart, periodEnd],
  );
  if (ins.rows.length > 0) {
    return { runId: Number(ins.rows[0].id), resumed: false };
  }

  const { rows } = await pool.query(
    `SELECT id, status FROM whatsapp_ai_pattern_runs WHERE workspace_id = $1 AND period_start = $2`,
    [workspaceId, periodStart],
  );
  const existing = rows[0];
  if (existing == null || existing.status !== 'failed') {
    return null;
  }

  // Guard `AND status = 'failed'` no UPDATE: SELECT+UPDATE são dois round-trips
  // separados (sem transação/lock entre eles) — sem o guard, duas réplicas que leem
  // 'failed' ao mesmo tempo (CLI manual + runner, ex.) ganhariam AMBAS o resume e
  // disparariam 2 calls LLM pra mesma run. Com o guard, só quem chega primeiro casa
  // a linha; a 2ª UPDATE afeta 0 rows (a row já não está mais 'failed') → corrida
  // perdida, devolve null (não inventa um runId de uma retomada que não aconteceu).
  const upd = await pool.query(
    `UPDATE whatsapp_ai_pattern_runs
        SET status = 'running', started_at = now(), finished_at = NULL
      WHERE id = $1 AND status = 'failed'
      RETURNING id`,
    [existing.id],
  );
  if (upd.rows.length === 0) {
    return null;
  }
  return { runId: Number(upd.rows[0].id), resumed: true };
}

/**
 * Fecha a run com sucesso: status='done' + finished_at=now() + MERGE do output.
 * O merge (`COALESCE(output,'{}') || $2`) — não overwrite cego — PRESERVA a `decision`
 * persistida por `persistPatternDecision` ANTES do apply (retomada idempotente, Task E3
 * fix): finish grava `{applied, skipped}` por cima, resultando em `{decision, applied,
 * skipped}`. `output` não-objeto quebraria o `||`; todos os chamadores passam objetos.
 */
export async function finishPatternRun(pool: Pool, runId: number, output: unknown): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_ai_pattern_runs
        SET status = 'done',
            output = COALESCE(output, '{}'::jsonb) || $2::jsonb,
            finished_at = now()
      WHERE id = $1`,
    [runId, JSON.stringify(output ?? {})],
  );
}

/** Fecha a run com falha: status='failed' + finished_at=now() (output preservado — a
 *  `decision` persistida sobrevive pra retomada re-aplicar A MESMA na próxima semana). */
export async function failPatternRun(pool: Pool, runId: number): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_ai_pattern_runs
        SET status = 'failed', finished_at = now()
      WHERE id = $1`,
    [runId],
  );
}

/**
 * Persiste a decisão VALIDADA no output da run ANTES do apply (Task E3 fix — retry
 * idempotente). `status` segue 'running' (a run não terminou). Merge (`|| jsonb_build_object`)
 * pra não apagar nada já gravado. Se um crash interromper o apply, a retomada (claim de
 * 'failed') lê esta decisão e RE-APLICA A MESMA (upserts/guards do aplicador toleram
 * re-execução) em vez de re-chamar o LLM — que poderia decidir DIFERENTE sobre efeitos
 * parciais já escritos.
 */
export async function persistPatternDecision(pool: Pool, runId: number, decision: unknown): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_ai_pattern_runs
        SET output = COALESCE(output, '{}'::jsonb) || jsonb_build_object('decision', $2::jsonb)
      WHERE id = $1`,
    [runId, JSON.stringify(decision)],
  );
}

/** Lê o jsonb `output` de uma run (retomada usa `output.decision` pra re-aplicar sem LLM). */
export async function getPatternRunOutput(pool: Pool, runId: number): Promise<unknown> {
  const { rows } = await pool.query(
    `SELECT output FROM whatsapp_ai_pattern_runs WHERE id = $1`,
    [runId],
  );
  return rows[0] ? (rows[0].output ?? null) : null;
}

export interface FailedPatternRun {
  runId: number;
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * Runs 'failed' de um workspace (mais recentes primeiro, cap `limit`) — Task E3 fix
 * (BLOQUEADOR 2): o sweep só calcula a semana CORRENTE; sem isto, uma run que falhou numa
 * semana passada nunca seria retomada (o claim daquela semana nunca mais é chamado). O
 * runner retoma cada uma via `claimPatternRun` do período dela (CAS de resume). `::text`
 * nas datas devolve 'YYYY-MM-DD' estável (o driver converteria `date` pra Date com shift).
 */
export async function fetchFailedPatternRuns(pool: Pool, workspaceId: string, limit: number): Promise<FailedPatternRun[]> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, period_start::text AS period_start, period_end::text AS period_end
       FROM whatsapp_ai_pattern_runs
      WHERE workspace_id = $1 AND status = 'failed'
      ORDER BY period_start DESC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((r: any) => ({
    runId: Number(r.id),
    workspaceId: r.workspace_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
  }));
}

/** Código do Postgres pra unique_violation (23505 — classe 23, integrity_constraint_violation). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/**
 * Insere uma sugestão de edição de guidance (nível 2 → humano; spec §8 "Não-autonomia").
 * Dedupe em DUAS camadas: (1) fast-path `INSERT ... WHERE NOT EXISTS` — evita a escrita
 * na maioria dos casos sem round-trip de erro; (2) guarda de verdade = índice único
 * parcial `uq_ai_suggestions_pending (workspace_id, kind) WHERE status='pending'`
 * (migration 055) — se duas chamadas passarem AMBAS pelo NOT EXISTS antes de qualquer
 * uma commitar (a mesma classe de corrida do finding do claim acima), o banco rejeita a
 * 2ª com unique_violation (23505), que é tratada aqui como dedupe (retorna `null`, não
 * propaga erro). Qualquer outro erro é relançado. Retorna o id inserido, ou `null` se já
 * havia uma pendente do mesmo `kind` no workspace.
 */
export async function insertSuggestion(
  pool: Pool,
  workspaceId: string,
  kind: SuggestionKind,
  payload: unknown,
): Promise<number | null> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_ai_suggestions (workspace_id, kind, payload)
       SELECT $1, $2, $3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM whatsapp_ai_suggestions
           WHERE workspace_id = $1 AND kind = $2 AND status = 'pending'
        )
       RETURNING id`,
      [workspaceId, kind, JSON.stringify(payload)],
    );
    return rows[0] ? Number(rows[0].id) : null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/**
 * Grava o relatório semanal (spec §8 "Saída de insights"). "1 por run" agora é INVARIANTE
 * DO BANCO (Task E3 fix — migration 056: índice único parcial `uq_ai_insights_run (run_id)
 * WHERE run_id IS NOT NULL`), não mais convenção do chamador: uma retomada que re-aplica a
 * decisão NÃO duplica o insight. `ON CONFLICT ... DO NOTHING` + fallback 23505 → retorna
 * `null` quando já existe insight pra este run. `runId` null é aceito (defensivo) e nunca
 * conflita (fora do índice parcial).
 */
export async function insertInsight(
  pool: Pool,
  workspaceId: string,
  runId: number | null,
  summary: string,
  details: unknown = null,
): Promise<number | null> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_ai_insights (workspace_id, run_id, summary, details)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [workspaceId, runId, summary, details == null ? null : JSON.stringify(details)],
    );
    return rows[0] ? Number(rows[0].id) : null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** Últimos N insights de um workspace, mais recentes primeiro (Task E4 — GET /whatsapp/insights). */
export async function listInsights(pool: Pool, workspaceId: string, limit: number): Promise<Insight[]> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, run_id, run_at, summary, details
       FROM whatsapp_ai_insights
      WHERE workspace_id = $1
      ORDER BY run_at DESC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map(mapInsight);
}

/** Sugestões pendentes de um workspace, mais antigas primeiro (fila de revisão humana). */
export async function listPendingSuggestions(pool: Pool, workspaceId: string): Promise<Suggestion[]> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, kind, payload, status, created_at, resolved_at, resolved_by
       FROM whatsapp_ai_suggestions
      WHERE workspace_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [workspaceId],
  );
  return rows.map(mapSuggestion);
}

/**
 * Lê uma sugestão por id, SEM filtro de workspace (Task E4 — a rota que consome
 * isto é responsável por comparar `suggestion.workspaceId` contra o workspace
 * derivado do `number_id` do request e responder 404 em caso de mismatch, pra
 * não vazar existência de sugestão de outro workspace).
 */
export async function getSuggestion(pool: Pool, id: number): Promise<Suggestion | null> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, kind, payload, status, created_at, resolved_at, resolved_by
       FROM whatsapp_ai_suggestions
      WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapSuggestion(rows[0]) : null;
}

/**
 * Resolve uma sugestão pendente (aplicar/dispensar) como ato humano auditável
 * (`resolvedBy`). WHERE status='pending' torna a transição idempotente por linha —
 * resolver 2x (ou uma sugestão inexistente) não sobrescreve nem lança, apenas
 * retorna `null` (0 rows afetadas).
 */
export async function resolveSuggestion(
  pool: Pool,
  id: number,
  status: 'applied' | 'dismissed',
  resolvedBy: string,
): Promise<Suggestion | null> {
  const { rows } = await pool.query(
    `UPDATE whatsapp_ai_suggestions
        SET status = $2, resolved_at = now(), resolved_by = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING id, workspace_id, kind, payload, status, created_at, resolved_at, resolved_by`,
    [id, status, resolvedBy],
  );
  return rows[0] ? mapSuggestion(rows[0]) : null;
}

/**
 * Rollback best-effort de um APPLY que ganhou o CAS mas cujo `patchSettings` falhou depois
 * (Task E3 fix — IMPORTANT B): devolve a sugestão 'applied' pra 'pending' pra que um retry
 * possa reaplicar. Guard `status = 'applied'` torna idempotente e impede reverter uma
 * sugestão dispensada/aplicada por OUTRO fluxo. `resolved_at/by` voltam a NULL.
 */
export async function revertSuggestionApplied(pool: Pool, id: number): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_ai_suggestions
        SET status = 'pending', resolved_at = NULL, resolved_by = NULL
      WHERE id = $1 AND status = 'applied'`,
    [id],
  );
}
