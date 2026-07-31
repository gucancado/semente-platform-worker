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

  const upd = await pool.query(
    `UPDATE whatsapp_ai_pattern_runs
        SET status = 'running', started_at = now(), finished_at = NULL
      WHERE id = $1
      RETURNING id`,
    [existing.id],
  );
  return { runId: Number(upd.rows[0].id), resumed: true };
}

/** Fecha a run com sucesso: status='done' + output (jsonb) + finished_at=now(). */
export async function finishPatternRun(pool: Pool, runId: number, output: unknown): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_ai_pattern_runs
        SET status = 'done', output = $2::jsonb, finished_at = now()
      WHERE id = $1`,
    [runId, JSON.stringify(output ?? null)],
  );
}

/** Fecha a run com falha: status='failed' + finished_at=now() (output preservado). */
export async function failPatternRun(pool: Pool, runId: number): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_ai_pattern_runs
        SET status = 'failed', finished_at = now()
      WHERE id = $1`,
    [runId],
  );
}

/**
 * Insere uma sugestão de edição de guidance (nível 2 → humano; spec §8 "Não-autonomia").
 * Dedupe ATÔMICO (INSERT ... WHERE NOT EXISTS numa única query — sem race entre
 * SELECT-então-INSERT): não cria uma 2ª pendente do mesmo `kind` no workspace. Retorna
 * o id inserido, ou `null` se já havia uma pendente (nada foi escrito).
 */
export async function insertSuggestion(
  pool: Pool,
  workspaceId: string,
  kind: SuggestionKind,
  payload: unknown,
): Promise<number | null> {
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
}

/**
 * Grava o relatório semanal (spec §8 "Saída de insights"). `runId` null é aceito
 * (defensivo), mas o uso real sempre associa ao run corrente. "1 por run" é convenção
 * do chamador (E3 chama uma vez por run) — não há UNIQUE em `run_id` no DDL (§3.2).
 */
export async function insertInsight(
  pool: Pool,
  workspaceId: string,
  runId: number | null,
  summary: string,
  details: unknown = null,
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_ai_insights (workspace_id, run_id, summary, details)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [workspaceId, runId, summary, details == null ? null : JSON.stringify(details)],
  );
  return Number(rows[0].id);
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
