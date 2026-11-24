import { config } from '../config.js';

/**
 * Tarefas de um workspace pelo Bloquim (`GET /api/internal/workspaces/:id/tasks`,
 * gated por INTERNAL_API_SECRET). Usadas pelo resumo semanal (src/weekly-context)
 * para cruzar o que foi dito no grupo e nas reuniões com o que a equipe tem em
 * aberto e o que entregou.
 *
 * Graceful: qualquer falha devolve `null` (o resumo sai sem tarefas, e
 * `sources.tasks` grava null para distinguir de "zero tarefas").
 */
export type BloquimTask = {
  title: string;
  status: string;
  priority: string | null;
  overdue: boolean;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string | null;
  assigneeName: string | null;
};

export type WorkspaceTasks = { open: BloquimTask[]; completed: BloquimTask[] };

export type WorkspaceTasksDeps = {
  fetch?: typeof fetch;
  /** Sobrescreve INTERNAL_API_SECRET (testes). String vazia = sem segredo. */
  secret?: string;
  /** Sobrescreve a origem derivada de BLOQUIM_API_URL (testes). */
  bloquimOrigin?: string;
};

function toTask(raw: unknown): BloquimTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title.trim()) return null;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    title: r.title.trim(),
    status: typeof r.status === 'string' ? r.status : 'pending',
    priority: str(r.priority),
    overdue: r.overdue === true,
    dueDate: str(r.dueDate),
    completedAt: str(r.completedAt),
    createdAt: str(r.createdAt),
    assigneeName: str(r.assigneeName),
  };
}

export async function fetchWorkspaceTasks(
  workspaceId: string,
  completedSince: Date,
  deps: WorkspaceTasksDeps = {},
): Promise<WorkspaceTasks | null> {
  const secret = deps.secret ?? config.INTERNAL_API_SECRET;
  if (!secret) return null;
  let origin = deps.bloquimOrigin;
  if (!origin) {
    try {
      origin = new URL(config.BLOQUIM_API_URL).origin;
    } catch {
      return null;
    }
  }
  try {
    const r = await (deps.fetch ?? fetch)(
      `${origin}/api/internal/workspaces/${encodeURIComponent(workspaceId)}/tasks` +
        `?completedSince=${encodeURIComponent(completedSince.toISOString())}`,
      { headers: { 'X-Internal-Secret': secret }, signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const body = (await r.json()) as { open?: unknown; completed?: unknown };
    if (!Array.isArray(body.open) || !Array.isArray(body.completed)) return null;
    const pick = (a: unknown[]) => a.map(toTask).filter((t): t is BloquimTask => t !== null);
    return { open: pick(body.open), completed: pick(body.completed) };
  } catch {
    return null;
  }
}
