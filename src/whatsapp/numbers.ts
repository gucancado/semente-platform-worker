import type { Pool } from 'pg';

export type WhatsappNumber = {
  id: number; workspaceId: string; phone: string | null; evolutionInstance: string;
  label: string | null; status: 'pending'|'connecting'|'connected'|'disconnected';
  mode: 'monitored'|'agent_operated'; createdBy: string | null; createdAt: string; updatedAt: string;
};

const SELECT = `SELECT id, workspace_id, phone, evolution_instance, label, status, mode,
  created_by, created_at, updated_at FROM whatsapp_numbers`;

function map(r: any): WhatsappNumber {
  return { id: Number(r.id), workspaceId: r.workspace_id, phone: r.phone, evolutionInstance: r.evolution_instance,
    label: r.label, status: r.status, mode: r.mode, createdBy: r.created_by,
    createdAt: r.created_at.toISOString?.() ?? r.created_at, updatedAt: r.updated_at.toISOString?.() ?? r.updated_at };
}

export async function createNumber(pool: Pool, p: { workspaceId: string; evolutionInstance: string; label: string | null; createdBy: string | null }) {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, label, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [p.workspaceId, p.evolutionInstance, p.label, p.createdBy]);
  return map(rows[0]);
}
export async function getNumberByInstance(pool: Pool, instance: string) {
  const { rows } = await pool.query(`${SELECT} WHERE evolution_instance = $1`, [instance]);
  return rows[0] ? map(rows[0]) : null;
}
export async function getNumber(pool: Pool, id: number) {
  const { rows } = await pool.query(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}
export async function listNumbers(pool: Pool, workspaceId: string) {
  const { rows } = await pool.query(`${SELECT} WHERE workspace_id = $1 ORDER BY created_at DESC`, [workspaceId]);
  return rows.map(map);
}
export async function updateNumberStatus(pool: Pool, instance: string, p: { status: WhatsappNumber['status']; phone?: string }) {
  await pool.query(
    `UPDATE whatsapp_numbers SET status = $2, phone = COALESCE($3, phone), updated_at = NOW() WHERE evolution_instance = $1`,
    [instance, p.status, p.phone ?? null]);
}
