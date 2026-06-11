import { pool } from '../db.js';
import { insertEventTx } from '../events/outbox.js';

export type EpisodeTurnInput = {
  turn_index: number; speaker_name: string | null; speaker_label: string | null;
  speaker_email?: string | null; started_at_ms?: number | null; ended_at_ms?: number | null; text: string;
};

export type EpisodeInput = {
  fonte: 'reuniao' | 'whatsapp'; external_source: string; external_id: string;
  title?: string | null; occurred_at: Date; duration_seconds?: number | null;
  language?: string; workspace_id?: string | null; project_slug?: string | null;
  attribution_method?: string;
  participants?: Array<{ name?: string; email?: string | null }>;
  metadata?: Record<string, unknown>;
  raw_r2_key?: string | null; audio_r2_key?: string | null;
  turns: EpisodeTurnInput[]; force?: boolean;
};

export type EpisodeRow = {
  id: number; schema_version: string; fonte: string; external_source: string; external_id: string;
  title: string | null; occurred_at: Date; duration_seconds: number | null; language: string;
  workspace_id: string | null; project_slug: string | null; attribution_method: string;
  participants: unknown; metadata: unknown; raw_r2_key: string | null; audio_r2_key: string | null;
  turn_count: number; revision: number; created_at: Date; updated_at: Date;
};

function eventPayload(ep: { id: number; revision: number }, a: EpisodeInput) {
  return {
    schema: 'episodio_pronto_v1', episode_id: ep.id, revision: ep.revision,
    fonte: a.fonte, workspace_id: a.workspace_id ?? null, project_slug: a.project_slug ?? null,
    occurred_at: a.occurred_at.toISOString(), turn_count: a.turns.length, title: a.title ?? null,
  };
}

/**
 * Grava episódio + turnos + evento outbox em UMA transação (spec §3/§4).
 * Duplicata (external_source, external_id): sem force → no-op; com force →
 * substitui turnos, bumpa revision e re-emite evento (spec §3, achado #11).
 */
export async function insertEpisodeWithTurns(a: EpisodeInput): Promise<{ id: number; duplicate: boolean; revision: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query<{ id: number; revision: number }>(
      `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds,
         language, workspace_id, project_slug, attribution_method, participants, metadata, raw_r2_key, audio_r2_key, turn_count)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'pt-BR'),$8,$9,COALESCE($10,'none'),$11,$12,$13,$14,$15)
       ON CONFLICT (external_source, external_id) DO NOTHING
       RETURNING id, revision`,
      [a.fonte, a.external_source, a.external_id, a.title ?? null, a.occurred_at, a.duration_seconds ?? null,
       a.language ?? null, a.workspace_id ?? null, a.project_slug ?? null, a.attribution_method ?? null,
       JSON.stringify(a.participants ?? []), JSON.stringify(a.metadata ?? {}), a.raw_r2_key ?? null,
       a.audio_r2_key ?? null, a.turns.length]
    );

    let id: number; let revision: number; let duplicate = false;
    if (ins.rows[0]) {
      ({ id, revision } = ins.rows[0]);
    } else {
      duplicate = true;
      const ex = await client.query<{ id: number; revision: number }>(
        `SELECT id, revision FROM episodes WHERE external_source=$1 AND external_id=$2 FOR UPDATE`,
        [a.external_source, a.external_id]
      );
      id = ex.rows[0]!.id;
      if (!a.force) {
        await client.query('COMMIT');
        return { id, duplicate: true, revision: ex.rows[0]!.revision };
      }
      revision = ex.rows[0]!.revision + 1;
      await client.query(`DELETE FROM episode_turns WHERE episode_id=$1`, [id]);
      await client.query(
        `UPDATE episodes SET title=$2, occurred_at=$3, duration_seconds=$4, participants=$5,
                metadata=$6, raw_r2_key=$7, audio_r2_key=$8, turn_count=$9, revision=$10, updated_at=NOW()
          WHERE id=$1`,
        [id, a.title ?? null, a.occurred_at, a.duration_seconds ?? null, JSON.stringify(a.participants ?? []),
         JSON.stringify(a.metadata ?? {}), a.raw_r2_key ?? null, a.audio_r2_key ?? null, a.turns.length, revision]
      );
    }

    for (const t of a.turns) {
      await client.query(
        `INSERT INTO episode_turns (episode_id, turn_index, speaker_name, speaker_label, speaker_email, started_at_ms, ended_at_ms, text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, t.turn_index, t.speaker_name, t.speaker_label, t.speaker_email ?? null,
         t.started_at_ms ?? null, t.ended_at_ms ?? null, t.text]
      );
    }
    await insertEventTx(client, {
      event_type: 'episodio_pronto_v1', aggregate_type: 'episode', aggregate_id: String(id),
      payload: eventPayload({ id, revision: revision! }, a),
    });
    await client.query('COMMIT');
    return { id, duplicate, revision: revision! };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getEpisode(id: number): Promise<(EpisodeRow & { turns: EpisodeTurnInput[] }) | null> {
  const { rows } = await pool.query<EpisodeRow>(`SELECT * FROM episodes WHERE id=$1`, [id]);
  if (!rows[0]) return null;
  const { rows: turns } = await pool.query(
    `SELECT turn_index, speaker_name, speaker_label, speaker_email, started_at_ms, ended_at_ms, text
       FROM episode_turns WHERE episode_id=$1 ORDER BY turn_index ASC`, [id]);
  return { ...rows[0], turns };
}

/** Cursor composto base64url("occurred_at_iso|id") — ordem por occurred_at DESC, id DESC (spec §11). */
export async function listEpisodes(f: {
  workspace_id?: string; fonte?: string; since?: Date; until?: Date; q?: string;
  orphans?: boolean; limit?: number; cursor?: string;
}): Promise<{ items: EpisodeRow[]; next_cursor: string | null }> {
  const limit = Math.min(f.limit ?? 50, 200);
  const where: string[] = []; const args: unknown[] = [];
  const p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (f.workspace_id) where.push(`workspace_id = ${p(f.workspace_id)}`);
  if (f.orphans) where.push(`workspace_id IS NULL`);
  if (f.fonte) where.push(`fonte = ${p(f.fonte)}`);
  if (f.since) where.push(`occurred_at >= ${p(f.since)}`);
  if (f.until) where.push(`occurred_at <= ${p(f.until)}`);
  if (f.q) where.push(`title ILIKE ${p('%' + f.q + '%')}`);
  if (f.cursor) {
    const decoded = Buffer.from(f.cursor, 'base64url').toString();
    const pipeIdx = decoded.lastIndexOf('|');
    const iso = decoded.slice(0, pipeIdx);
    const id = decoded.slice(pipeIdx + 1);
    where.push(`(occurred_at, id) < (${p(new Date(iso))}, ${p(Number(id))})`);
  }
  const sql = `SELECT * FROM episodes ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY occurred_at DESC, id DESC LIMIT ${p(limit + 1)}`;
  const { rows } = await pool.query<EpisodeRow>(sql, args);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const next_cursor = rows.length > limit && last
    ? Buffer.from(`${last.occurred_at.toISOString()}|${last.id}`).toString('base64url') : null;
  return { items, next_cursor };
}

/** Atribuição manual com auditoria em metadata.attribution_history (spec §9.4). */
export async function updateEpisodeAttribution(
  id: number, a: { workspace_id: string; project_slug?: string | null; by: string }
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE episodes SET
        workspace_id=$2, project_slug=$3, attribution_method='manual', updated_at=NOW(),
        metadata = jsonb_set(metadata, '{attribution_history}',
          COALESCE(metadata->'attribution_history', '[]'::jsonb) ||
          jsonb_build_object('method','manual','workspace_id',$2::text,'by',$4::text,'at',NOW()::text))
      WHERE id=$1`,
    [id, a.workspace_id, a.project_slug ?? null, a.by]
  );
  return (rowCount ?? 0) > 0;
}
