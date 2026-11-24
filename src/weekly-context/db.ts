/**
 * src/weekly-context/db.ts — leituras e escrita do resumo semanal de contexto.
 *
 * Fonte das mensagens: grupos INTERNOS do monitor (agent='saturno') vinculados ao
 * workspace (`linked_workspace_id`). Quem escreveu é marcado como "BeeAds" quando
 * o mesmo autor aparece em 2+ grupos vinculados (a equipe está em todos os grupos;
 * o cliente, só no dele) — a marcação ajuda o modelo a separar o que o cliente
 * disse do que a agência disse.
 */
import type { Pool } from 'pg';
import { MEETINGS_WINDOW_DAYS, MESSAGES_WINDOW_DAYS, clientNameFromGroup } from './core.js';
import type { ContextMeeting, ContextMessage } from './core.js';

export type WeeklyContextRow = {
  workspace_id: string;
  week_start: string;
  status: 'ok' | 'empty' | 'failed';
  summary: string | null;
  model: string | null;
  cost_usd: number | null;
  generated_at: Date;
  generated_by: string | null;
};

/** Workspaces com grupo do monitor vinculado: o universo do gerador semanal. */
export async function listEligibleWorkspaces(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ ws: string }>(
    `/* wc:eligible */ SELECT DISTINCT linked_workspace_id AS ws
       FROM whatsapp_groups
      WHERE agent = 'saturno' AND linked_workspace_id IS NOT NULL`,
  );
  return rows.map((r) => r.ws);
}

/** Elegíveis sem resumo da semana; `failed` volta a ser tentado depois de 1h. */
export async function listPendingWorkspaces(pool: Pool, weekStart: string): Promise<string[]> {
  const { rows } = await pool.query<{ ws: string }>(
    `/* wc:pending */ SELECT DISTINCT g.linked_workspace_id AS ws
       FROM whatsapp_groups g
      WHERE g.agent = 'saturno' AND g.linked_workspace_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM weekly_context_summaries s
           WHERE s.workspace_id = g.linked_workspace_id AND s.week_start = $1::date
             AND (s.status <> 'failed' OR s.generated_at > now() - interval '1 hour'))
      ORDER BY 1`,
    [weekStart],
  );
  return rows.map((r) => r.ws);
}

export async function loadContextInputs(
  pool: Pool,
  workspaceId: string,
): Promise<{ clientName: string; messages: ContextMessage[]; meetings: ContextMeeting[] }> {
  const [groups, msgs, meets] = await Promise.all([
    pool.query<{ subject: string | null }>(
      `SELECT subject FROM whatsapp_groups
        WHERE agent = 'saturno' AND linked_workspace_id = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [workspaceId],
    ),
    pool.query<{ at: string; role: 'BeeAds' | 'cliente'; text: string }>(
      `/* wc:messages */
       WITH linked AS (
         SELECT jid FROM whatsapp_groups WHERE agent = 'saturno' AND linked_workspace_id IS NOT NULL
       ), team AS (
         SELECT m.author FROM messages m JOIN linked l ON l.jid = m.identifier
          WHERE m.agent = 'saturno' AND m.author IS NOT NULL AND m.created_at > now() - interval '90 days'
          GROUP BY m.author HAVING count(DISTINCT m.identifier) >= 2
       )
       SELECT to_char(m.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS at,
              CASE WHEN m.author IN (SELECT author FROM team) THEN 'BeeAds' ELSE 'cliente' END AS role,
              m.text
         FROM messages m
         JOIN whatsapp_groups g ON g.jid = m.identifier AND g.agent = 'saturno'
        WHERE m.agent = 'saturno' AND g.linked_workspace_id = $1
          AND m.created_at > now() - make_interval(days => $2)
          AND coalesce(m.text, '') <> ''
        ORDER BY m.created_at`,
      [workspaceId, MESSAGES_WINDOW_DAYS],
    ),
    pool.query<{
      title: string | null; at: string; summary: string | null; points: unknown;
      decisions: unknown; actions: unknown; open_questions: unknown;
    }>(
      `/* wc:meetings */
       SELECT title, to_char(occurred_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM') AS at,
              summary, summary_points AS points, summary_decisions AS decisions,
              summary_actions AS actions, summary_open_questions AS open_questions
         FROM episodes
        WHERE workspace_id = $1 AND occurred_at > now() - make_interval(days => $2)
        ORDER BY occurred_at`,
      [workspaceId, MEETINGS_WINDOW_DAYS],
    ),
  ]);
  return {
    clientName: clientNameFromGroup(groups.rows[0]?.subject ?? null),
    messages: msgs.rows,
    meetings: meets.rows.map((r) => ({
      title: r.title, at: r.at, summary: r.summary, points: r.points,
      decisions: r.decisions, actions: r.actions, openQuestions: r.open_questions,
    })),
  };
}

export async function upsertWeeklyContext(
  pool: Pool,
  row: {
    workspaceId: string; weekStart: string; status: 'ok' | 'empty' | 'failed';
    summary: string | null; provider: string | null; model: string | null;
    tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
    sources: { messages: number; meetings: number; tasks: { open: number; completed: number } | null }; error: string | null; generatedBy: string | null;
  },
): Promise<void> {
  await pool.query(
    `/* wc:upsert */ INSERT INTO weekly_context_summaries
       (workspace_id, week_start, status, summary, provider, model, tokens_in, tokens_out,
        cost_usd, sources, error, generated_by, generated_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (workspace_id, week_start) DO UPDATE SET
       status = EXCLUDED.status, summary = EXCLUDED.summary, provider = EXCLUDED.provider,
       model = EXCLUDED.model, tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out,
       cost_usd = EXCLUDED.cost_usd, sources = EXCLUDED.sources, error = EXCLUDED.error,
       generated_by = EXCLUDED.generated_by, generated_at = now()`,
    [
      row.workspaceId, row.weekStart, row.status, row.summary, row.provider, row.model,
      row.tokensIn, row.tokensOut, row.costUsd, JSON.stringify(row.sources), row.error, row.generatedBy,
    ],
  );
}

/** Resumo mais recente que não falhou (o painel mostra o último bom, mesmo de semana anterior). */
export async function getLatestWeeklyContext(pool: Pool, workspaceId: string): Promise<WeeklyContextRow | null> {
  const { rows } = await pool.query<WeeklyContextRow & { cost_usd: string | null; week_start: string }>(
    `/* wc:latest */ SELECT workspace_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, status, summary,
            model, cost_usd, generated_at, generated_by
       FROM weekly_context_summaries
      WHERE workspace_id = $1 AND status <> 'failed'
      ORDER BY week_start DESC LIMIT 1`,
    [workspaceId],
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, cost_usd: r.cost_usd == null ? null : Number(r.cost_usd) };
}
