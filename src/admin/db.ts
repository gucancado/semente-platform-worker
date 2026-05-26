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
