/**
 * Espelho do vocabulário de tags do painel em whatsapp_tags. O painel é a fonte;
 * aqui só se planeja (puro) e se aplica (savepoint por op) a diferença.
 * Nunca há DELETE em whatsapp_tags: o CASCADE apagaria os vínculos.
 */
import type { Pool } from 'pg';

export interface VocabRow {
  id: string; workspaceId: string; parentId: string | null; ancestorIds: string[];
  name: string; color: string; description: string | null; deletedAt: string | null; mergedIntoId: string | null;
}
export interface MirrorRow {
  id: number; workspaceId: string; externalId: string | null; name: string; color: string;
  description: string | null; parentExternalId: string | null; ancestorExternalIds: string[]; deletedAt: string | null;
}
export type SyncOp =
  | { op: 'link'; id: number; externalId: string; fields: Partial<MirrorRow> }
  | { op: 'update'; id: number; fields: Partial<MirrorRow> }
  | { op: 'insert'; row: VocabRow }
  | { op: 'merge'; fromId: number; toExternalId: string }
  | { op: 'tombstone'; id: number; deletedAt: string };

const sameArr = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function diffFields(m: MirrorRow, v: VocabRow): Partial<MirrorRow> {
  const f: Partial<MirrorRow> = {};
  if (m.name !== v.name) f.name = v.name;
  if (m.color !== v.color) f.color = v.color;
  if (m.description !== v.description) f.description = v.description;
  if (m.parentExternalId !== v.parentId) f.parentExternalId = v.parentId;
  if (!sameArr(m.ancestorExternalIds, v.ancestorIds)) f.ancestorExternalIds = v.ancestorIds;
  if (m.deletedAt !== null) f.deletedAt = null;
  return f;
}

export function planVocabularySync(mirror: MirrorRow[], snapshot: VocabRow[]): SyncOp[] {
  const byExt = new Map<string, MirrorRow>();
  const unlinked = new Map<string, MirrorRow>(); // ws|lower(name) -> espelho vivo sem external_id
  for (const m of mirror) {
    if (m.externalId) byExt.set(m.externalId, m);
    else if (!m.deletedAt) unlinked.set(`${m.workspaceId}|${m.name.toLowerCase()}`, m);
  }

  const simpleTombstones: SyncOp[] = [];
  const inserts: SyncOp[] = [];
  const updates: SyncOp[] = [];
  const merges: SyncOp[] = [];
  const mergeTombstones: SyncOp[] = [];

  // Só tag viva do snapshot pode reivindicar o vínculo por nome.
  for (const v of snapshot) {
    if (v.deletedAt || v.mergedIntoId) continue;
    const m = byExt.get(v.id);
    if (!m) {
      const key = `${v.workspaceId}|${v.name.toLowerCase()}`;
      const cand = unlinked.get(key);
      if (cand) {
        unlinked.delete(key);
        updates.push({ op: 'link', id: cand.id, externalId: v.id, fields: diffFields(cand, v) });
      } else {
        inserts.push({ op: 'insert', row: v });
      }
      continue;
    }
    const fields = diffFields(m, v);
    if (Object.keys(fields).length) updates.push({ op: 'update', id: m.id, fields });
  }

  for (const v of snapshot) {
    if (!v.deletedAt && !v.mergedIntoId) continue;
    const m = byExt.get(v.id);
    if (!m || m.deletedAt) continue;
    const deletedAt = v.deletedAt ?? new Date().toISOString();
    if (v.mergedIntoId) {
      merges.push({ op: 'merge', fromId: m.id, toExternalId: v.mergedIntoId });
      mergeTombstones.push({ op: 'tombstone', id: m.id, deletedAt });
    } else {
      simpleTombstones.push({ op: 'tombstone', id: m.id, deletedAt });
    }
  }

  return [...simpleTombstones, ...inserts, ...updates, ...merges, ...mergeTombstones];
}

const COLS: Record<string, string> = {
  name: 'name', color: 'color', description: 'description',
  parentExternalId: 'parent_external_id', ancestorExternalIds: 'ancestor_external_ids', deletedAt: 'deleted_at',
};

type Q = { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> };

async function applyOp(c: Q, op: SyncOp): Promise<void> {
  switch (op.op) {
    case 'insert': {
      const r = op.row;
      await c.query(
        `INSERT INTO whatsapp_tags (workspace_id, name, color, description, external_id, parent_external_id,
                                    ancestor_external_ids, synced_at, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),'system:vocab','system:vocab')`,
        [r.workspaceId, r.name, r.color, r.description, r.id, r.parentId, r.ancestorIds],
      );
      return;
    }
    case 'link':
    case 'update': {
      const sets: string[] = ['synced_at = NOW()', "updated_by = 'system:vocab'"];
      const params: unknown[] = [op.id];
      if (op.op === 'link') { params.push(op.externalId); sets.push(`external_id = $${params.length}`); }
      for (const [k, val] of Object.entries(op.fields)) {
        const col = COLS[k];
        if (!col) continue;
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
      await c.query(`UPDATE whatsapp_tags SET ${sets.join(', ')} WHERE id = $1`, params);
      return;
    }
    case 'merge': {
      const dest = await c.query(
        `SELECT d.id FROM whatsapp_tags d JOIN whatsapp_tags s ON s.workspace_id = d.workspace_id
          WHERE s.id = $1 AND d.external_id = $2`,
        [op.fromId, op.toExternalId],
      );
      if (!dest.rows.length) throw new Error(`merge: destino ${op.toExternalId} ausente no espelho`);
      await c.query(
        `INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id)
         SELECT opportunity_id, $2 FROM whatsapp_opportunity_tags WHERE tag_id = $1
         ON CONFLICT DO NOTHING`,
        [op.fromId, dest.rows[0].id],
      );
      await c.query('DELETE FROM whatsapp_opportunity_tags WHERE tag_id = $1', [op.fromId]);
      return;
    }
    case 'tombstone':
      await c.query(
        "UPDATE whatsapp_tags SET deleted_at = $2, synced_at = NOW(), updated_by = 'system:vocab' WHERE id = $1",
        [op.id, op.deletedAt],
      );
      return;
  }
}

const MIRROR_SQL = `SELECT id, workspace_id, external_id, name, color, description, parent_external_id,
  ancestor_external_ids, deleted_at FROM whatsapp_tags`;

export async function runVocabularySync(
  pool: Pool, fetchSnapshot: () => Promise<VocabRow[]>,
): Promise<{ ops: number; errors: number }> {
  let snapshot: VocabRow[];
  try {
    snapshot = await fetchSnapshot();
  } catch (err) {
    console.error('[tag-vocab] falha ao buscar o vocabulário:', (err as Error).message);
    return { ops: 0, errors: 1 };
  }
  const client = await pool.connect();
  let ops = 0;
  let errors = 0;
  try {
    await client.query('BEGIN');
    const res = await client.query(MIRROR_SQL);
    const mirror: MirrorRow[] = res.rows.map((r: any) => ({
      id: Number(r.id), workspaceId: r.workspace_id, externalId: r.external_id, name: r.name, color: r.color,
      description: r.description, parentExternalId: r.parent_external_id,
      ancestorExternalIds: r.ancestor_external_ids ?? [],
      deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
    }));
    for (const op of planVocabularySync(mirror, snapshot)) {
      await client.query('SAVEPOINT tv_op');
      try {
        await applyOp(client, op);
        await client.query('RELEASE SAVEPOINT tv_op');
        ops++;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT tv_op');
        errors++;
        console.warn(`[tag-vocab] op ${op.op} falhou (retenta no próximo tick):`, (err as Error).message);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[tag-vocab] ciclo falhou:', (err as Error).message);
    return { ops: 0, errors: errors + 1 };
  } finally {
    client.release();
  }
  return { ops, errors };
}

export async function fetchVocabularySnapshot(): Promise<VocabRow[]> {
  const base = process.env.PANEL_URL?.trim() || 'https://painel.beeads.com.br';
  const res = await fetch(`${base.replace(/\/$/, '')}/api/internal/tags/vocabulary`, {
    headers: { 'X-Panel-Token': process.env.PANEL_TOKEN ?? '' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { tags?: VocabRow[] };
  if (!Array.isArray(body.tags)) throw new Error('resposta sem tags[]');
  return body.tags;
}

const TICK_MS = 60_000;

export function startTagVocabularySync(pool: Pool): void {
  if (process.env.TAG_VOCABULARY_SYNC !== 'on') return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runVocabularySync(pool, fetchVocabularySnapshot);
    } catch (err) {
      console.error('[tag-vocab] tick falhou:', (err as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, TICK_MS);
  void tick();
}
