import { pool } from '../db.js';

/** Lançado quando UPDATE com if_match_updated_at não encontrou o row na versão esperada (alguém editou no meio). */
export class StaleWriteError extends Error {
  constructor(public readonly current: { id: number; updated_at: Date; [key: string]: unknown }) {
    super('stale write — row was modified concurrently');
    this.name = 'StaleWriteError';
  }
}

export type Project = {
  id: number;
  agent: string;
  slug: string;
  display_name: string;
  created_at: Date;
  updated_at: Date;
};

export async function createProject(args: {
  agent: string;
  slug: string;
  display_name: string;
}): Promise<Project> {
  const { rows } = await pool.query<Project>(
    `INSERT INTO projects (agent, slug, display_name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [args.agent, args.slug, args.display_name]
  );
  return rows[0]!;
}

export async function listProjects(agent: string): Promise<Project[]> {
  const { rows } = await pool.query<Project>(
    `SELECT * FROM projects WHERE agent = $1 ORDER BY created_at DESC`,
    [agent]
  );
  return rows;
}

export async function getProjectBySlug(agent: string, slug: string): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    `SELECT * FROM projects WHERE agent = $1 AND slug = $2 LIMIT 1`,
    [agent, slug]
  );
  return rows[0] ?? null;
}

export async function getProjectById(id: number): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    `SELECT * FROM projects WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function updateProject(
  id: number,
  patch: { display_name?: string }
): Promise<Project> {
  const { rows } = await pool.query<Project>(
    `UPDATE projects
        SET display_name = COALESCE($2, display_name),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, patch.display_name ?? null]
  );
  if (!rows[0]) throw new Error(`project ${id} not found`);
  return rows[0];
}

export type ProjectGoal = {
  id: number;
  project_id: number;
  goal_type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export async function upsertGoal(args: {
  project_id: number;
  goal_type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}): Promise<ProjectGoal> {
  const { rows } = await pool.query<ProjectGoal>(
    `INSERT INTO project_goals (project_id, goal_type, enabled, config)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (project_id, goal_type)
     DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = NOW()
     RETURNING *`,
    [args.project_id, args.goal_type, args.enabled, JSON.stringify(args.config)]
  );
  return rows[0]!;
}

export async function listGoals(project_id: number): Promise<ProjectGoal[]> {
  const { rows } = await pool.query<ProjectGoal>(
    `SELECT * FROM project_goals WHERE project_id = $1 ORDER BY goal_type`,
    [project_id]
  );
  return rows;
}

export async function disableGoal(
  project_id: number,
  goal_type: string
): Promise<ProjectGoal> {
  const { rows } = await pool.query<ProjectGoal>(
    `UPDATE project_goals SET enabled = FALSE, updated_at = NOW()
      WHERE project_id = $1 AND goal_type = $2
      RETURNING *`,
    [project_id, goal_type]
  );
  if (!rows[0]) throw new Error(`goal ${goal_type} not found for project ${project_id}`);
  return rows[0];
}

export type WorkingHours = {
  mon?: string[];
  tue?: string[];
  wed?: string[];
  thu?: string[];
  fri?: string[];
  sat?: string[];
  sun?: string[];
  timezone: string;
};

export type SchedulingAgenda = {
  id: number;
  project_id: number;
  person_name: string;
  person_email: string;
  display_label: string;
  description: string | null;
  working_hours: WorkingHours;
  meeting_duration_min: number;
  min_advance_hours: number;
  max_advance_business_days: number;
  active: boolean;
  round_robin_last_assigned_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function createAgenda(args: {
  project_id: number;
  person_name: string;
  person_email: string;
  display_label: string;
  description: string | null;
  working_hours: WorkingHours;
  meeting_duration_min: number;
  min_advance_hours: number;
  max_advance_business_days: number;
}): Promise<SchedulingAgenda> {
  const { rows } = await pool.query<SchedulingAgenda>(
    `INSERT INTO scheduling_agendas (
       project_id, person_name, person_email, display_label, description,
       working_hours, meeting_duration_min, min_advance_hours, max_advance_business_days
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      args.project_id,
      args.person_name,
      args.person_email,
      args.display_label,
      args.description,
      JSON.stringify(args.working_hours),
      args.meeting_duration_min,
      args.min_advance_hours,
      args.max_advance_business_days,
    ]
  );
  return rows[0]!;
}

export async function listAgendas(
  project_id: number,
  opts: { activeOnly?: boolean } = {}
): Promise<SchedulingAgenda[]> {
  const where = opts.activeOnly
    ? 'WHERE project_id = $1 AND active = TRUE'
    : 'WHERE project_id = $1';
  const { rows } = await pool.query<SchedulingAgenda>(
    `SELECT * FROM scheduling_agendas ${where} ORDER BY created_at ASC`,
    [project_id]
  );
  return rows;
}

export async function getAgenda(id: number): Promise<SchedulingAgenda | null> {
  const { rows } = await pool.query<SchedulingAgenda>(
    `SELECT * FROM scheduling_agendas WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function updateAgenda(
  id: number,
  patch: Partial<{
    person_name: string;
    person_email: string;
    display_label: string;
    description: string | null;
    working_hours: WorkingHours;
    meeting_duration_min: number;
    min_advance_hours: number;
    max_advance_business_days: number;
    active: boolean;
  }>
): Promise<SchedulingAgenda> {
  const { rows } = await pool.query<SchedulingAgenda>(
    `UPDATE scheduling_agendas SET
       person_name              = COALESCE($2, person_name),
       person_email             = COALESCE($3, person_email),
       display_label            = COALESCE($4, display_label),
       description              = COALESCE($5, description),
       working_hours            = COALESCE($6::jsonb, working_hours),
       meeting_duration_min     = COALESCE($7, meeting_duration_min),
       min_advance_hours        = COALESCE($8, min_advance_hours),
       max_advance_business_days = COALESCE($9, max_advance_business_days),
       active                   = COALESCE($10, active),
       updated_at               = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.person_name ?? null,
      patch.person_email ?? null,
      patch.display_label ?? null,
      patch.description === undefined ? null : patch.description,
      patch.working_hours === undefined ? null : JSON.stringify(patch.working_hours),
      patch.meeting_duration_min ?? null,
      patch.min_advance_hours ?? null,
      patch.max_advance_business_days ?? null,
      patch.active ?? null,
    ]
  );
  if (!rows[0]) throw new Error(`agenda ${id} not found`);
  return rows[0];
}

export async function softDeleteAgenda(id: number): Promise<SchedulingAgenda> {
  return updateAgenda(id, { active: false });
}
