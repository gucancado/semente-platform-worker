import type { Pool } from 'pg';

export type GroupParticipant = {
  phone: string;
  pushName: string | null;
  isAdmin: boolean;
  isLid: boolean;
  avatarKey: string | null;
  bloquimUserId: string | null;
  bloquimName: string | null;
  lastSeenAt: string;
};

/**
 * Upsert do roster. `last_seen_at` avança em TODO sync; quem saiu do grupo não é
 * deletado (fica com a data velha) — é o que permite a UI mostrar só quem foi
 * visto no último sync sem perder o histórico de quem já participou.
 * `push_name` só sobrescreve quando o novo valor não é nulo (a Evolution nem
 * sempre traz nome; nulo não pode apagar um nome já conhecido).
 */
export async function upsertParticipants(
  pool: Pool,
  groupId: number,
  people: Array<{ phone: string; pushName: string | null; isAdmin: boolean; isLid: boolean }>,
): Promise<number> {
  let n = 0;
  for (const p of people) {
    await pool.query(
      `INSERT INTO whatsapp_group_participants (group_id, phone, push_name, is_admin, is_lid)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id, phone) DO UPDATE
         SET push_name = COALESCE(EXCLUDED.push_name, whatsapp_group_participants.push_name),
             is_admin = EXCLUDED.is_admin,
             is_lid = EXCLUDED.is_lid,
             last_seen_at = NOW()`,
      [groupId, p.phone, p.pushName, p.isAdmin, p.isLid],
    );
    n++;
  }
  return n;
}

/**
 * Roster ATUAL do grupo, admins primeiro, depois por nome.
 *
 * O corte `last_seen_at >= g.updated_at` é o que separa quem está no grupo de
 * quem saiu: o upsert do grupo grava `updated_at = NOW()` ANTES de gravar os
 * participantes, então todo mundo visto no sync corrente tem `last_seen_at`
 * posterior, e quem saiu ficou com a data do sync anterior. Grupo nunca
 * sincronizado com participantes devolve lista vazia (nenhum participante ainda).
 */
export async function listParticipants(pool: Pool, groupId: number): Promise<GroupParticipant[]> {
  const { rows } = await pool.query(
    `SELECT p.phone, p.push_name, p.is_admin, p.is_lid, p.avatar_key,
            p.bloquim_user_id, p.bloquim_name, p.last_seen_at
       FROM whatsapp_group_participants p
       JOIN whatsapp_groups g ON g.id = p.group_id
      WHERE p.group_id = $1 AND p.last_seen_at >= g.updated_at
      ORDER BY p.is_admin DESC, COALESCE(p.bloquim_name, p.push_name, p.phone)`,
    [groupId],
  );
  return rows.map((r) => ({
    phone: r.phone,
    pushName: r.push_name ?? null,
    isAdmin: r.is_admin === true,
    isLid: r.is_lid === true,
    avatarKey: r.avatar_key ?? null,
    bloquimUserId: r.bloquim_user_id ?? null,
    bloquimName: r.bloquim_name ?? null,
    lastSeenAt: r.last_seen_at.toISOString?.() ?? r.last_seen_at,
  }));
}
