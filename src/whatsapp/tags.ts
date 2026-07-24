import type { Pool } from 'pg';

export const TAG_COLORS = [
  'red', 'orange', 'amber', 'green', 'teal',
  'blue', 'indigo', 'violet', 'pink', 'slate',
] as const;

export type TagColor = typeof TAG_COLORS[number];

export interface CatalogTag {
  id: number;
  name: string;
  color: TagColor;
  usageCount: number;
}

export interface Tag {
  id: number;
  name: string;
  color: TagColor;
}

const mapTag = (row: any): Tag => ({
  id: Number(row.id),
  name: row.name,
  color: row.color,
});

export async function listTags(pool: Pool, workspaceId: string): Promise<CatalogTag[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.color, COUNT(ot.opportunity_id)::int AS usage_count
       FROM whatsapp_tags t
       LEFT JOIN whatsapp_opportunity_tags ot ON ot.tag_id = t.id
      WHERE t.workspace_id = $1
      GROUP BY t.id, t.name, t.color
      ORDER BY lower(t.name), t.id`,
    [workspaceId],
  );
  return rows.map((row: any) => ({ ...mapTag(row), usageCount: Number(row.usage_count) }));
}

export async function createTag(pool: Pool, p: {
  workspaceId: string;
  name: string;
  color: TagColor;
}): Promise<Tag> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_tags (workspace_id, name, color)
     VALUES ($1, $2, $3)
     RETURNING id, name, color`,
    [p.workspaceId, p.name, p.color],
  );
  return mapTag(rows[0]);
}

export async function patchTag(pool: Pool, p: {
  id: number;
  workspaceId: string;
  name?: string;
  color?: TagColor;
}): Promise<Tag | null> {
  const values: unknown[] = [p.id, p.workspaceId];
  const set: string[] = [];
  if (p.name !== undefined) {
    values.push(p.name);
    set.push(`name=$${values.length}`);
  }
  if (p.color !== undefined) {
    values.push(p.color);
    set.push(`color=$${values.length}`);
  }
  const { rows } = await pool.query(
    `UPDATE whatsapp_tags SET ${set.join(', ')}
      WHERE id=$1 AND workspace_id=$2
      RETURNING id, name, color`,
    values,
  );
  return rows[0] ? mapTag(rows[0]) : null;
}

export async function deleteTag(pool: Pool, p: {
  id: number;
  workspaceId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM whatsapp_tags
      WHERE id=$1 AND workspace_id=$2
      RETURNING id`,
    [p.id, p.workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
