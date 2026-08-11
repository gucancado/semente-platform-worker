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
 *
 * `syncedAt`, quando informado, é gravado em `last_seen_at` NO LUGAR do `NOW()`
 * do banco — `syncGroupSubjects` (group-sync.ts) passa aqui o MESMO instante
 * que depois carimba em `participants_synced_at`. É essa igualdade (não a
 * ordem das duas escritas) que garante `last_seen_at >= participants_synced_at`
 * pro corte de `listParticipants`: dois `NOW()` independentes, em statements
 * sequenciais sem transação, quase sempre diferem (round-trip de rede entre
 * eles), e se o marcador vier depois ele fica LOGO À FRENTE do `last_seen_at`
 * que acabou de ser gravado — o `>=` falha pro lote inteiro e a lista some.
 * Omitir `syncedAt` mantém o `NOW()` do banco (usado só em teste).
 */
export async function upsertParticipants(
  pool: Pool,
  groupId: number,
  people: Array<{ phone: string; pushName: string | null; isAdmin: boolean; isLid: boolean }>,
  syncedAt?: Date,
): Promise<number> {
  let n = 0;
  for (const p of people) {
    if (syncedAt) {
      await pool.query(
        `INSERT INTO whatsapp_group_participants (group_id, phone, push_name, is_admin, is_lid, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (group_id, phone) DO UPDATE
           SET push_name = COALESCE(EXCLUDED.push_name, whatsapp_group_participants.push_name),
               is_admin = EXCLUDED.is_admin,
               is_lid = EXCLUDED.is_lid,
               last_seen_at = EXCLUDED.last_seen_at`,
        [groupId, p.phone, p.pushName, p.isAdmin, p.isLid, syncedAt],
      );
    } else {
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
    }
    n++;
  }
  return n;
}

/**
 * Roster ATUAL do grupo, admins primeiro, depois por nome.
 *
 * O corte `last_seen_at >= g.participants_synced_at` é o que separa quem está
 * no grupo de quem saiu. `syncGroupSubjects` (group-sync.ts) grava os dois
 * lados com o MESMO instante (`syncedAt` passado explicitamente pra
 * `upsertParticipants` e pro UPDATE do marcador) — por isso `last_seen_at ==
 * participants_synced_at` pra todo o lote do sync corrente, e o `>=` inclui
 * todo mundo. Quem saiu ficou com o `last_seen_at` de um sync ANTERIOR
 * (instante estritamente menor), então fica de fora. NÃO é
 * `whatsapp_groups.updated_at` (esse avança em todo sync de subject, mesmo
 * sem tocar participante nenhum — usá-lo esvaziaria o roster a cada
 * reconexão). Grupo nunca sincronizado com participantes tem
 * `participants_synced_at` NULL → `last_seen_at >= NULL` nunca é verdadeiro →
 * lista vazia (correto: não há roster conhecido).
 */
export async function listParticipants(pool: Pool, groupId: number): Promise<GroupParticipant[]> {
  const { rows } = await pool.query(
    `SELECT p.phone, p.push_name, p.is_admin, p.is_lid, p.avatar_key,
            p.bloquim_user_id, p.bloquim_name, p.last_seen_at
       FROM whatsapp_group_participants p
       JOIN whatsapp_groups g ON g.id = p.group_id
      WHERE p.group_id = $1 AND p.last_seen_at >= g.participants_synced_at
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
