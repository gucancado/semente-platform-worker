import { pool } from '../db.js';

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
