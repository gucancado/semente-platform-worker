import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import {
  migrationRowFor,
  normalizeTagName,
  type OppQualification,
  type OppStatus,
} from '../whatsapp/opportunity-core.js';
import { TAG_COLORS, type TagColor } from '../whatsapp/tags.js';

// ─────────────────────────────────────────────────────────────────────────────
// Script one-off (roda em prod como `node dist/cli/migrate-opportunities.js`):
// migra o funil por-conversa legado (whatsapp_thread_meta.lead_stage/lead_temperature
// + whatsapp_thread_tags) pra entidade Oportunidade + catálogo de etiquetas.
// Determinístico, transacional por workspace, dry-run por default. Spec §4.
//
// O PLANEJAMENTO (planMigration) é uma função PURA — recebe as rows já lidas e
// devolve o plano de inserts, sem tocar em banco. main() só lê o banco, chama o
// planejador e escreve. Isso mantém a lógica testável sem DATABASE_URL.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tipos de entrada (rows cruas mapeadas) ──────────────────────────────────
export interface ThreadRow {
  numberId: number;
  identifier: string;
  workspaceId: string;
  leadStage: string | null;
  leadTemperature: string | null;
  updatedAt: string; // ISO — vira created_at/closed_at da opp (spec §3.2, aproximação)
}
export interface ThreadTagRow {
  numberId: number;
  identifier: string;
  tag: string;
}
export interface CatalogTagRow {
  workspaceId: string;
  name: string;
}
export interface MigratedPairRow {
  numberId: number;
  identifier: string;
}
export interface PlanInput {
  threads: ThreadRow[];
  threadTags: ThreadTagRow[];
  existingCatalogTags: CatalogTagRow[];
  migratedPairs: MigratedPairRow[];
}

// ── Tipos de saída (plano de inserts) ───────────────────────────────────────
export interface PlannedTag {
  key: string; // lower(name) — chave de dedupe/resolução
  name: string; // casing exibido (primeira ocorrência vence)
  color: TagColor;
}
export interface PlannedAttachment {
  tagKey: string;
  tagName: string; // new_value do evento tag_added
}
export interface PlannedOpportunity {
  numberId: number;
  identifier: string;
  status: OppStatus;
  qualification: OppQualification;
  closed: boolean;
  createdAt: string; // = thread_meta.updated_at
  closedAt: string | null; // = updated_at quando closed, senão null
  attachments: PlannedAttachment[];
}
export interface SkippedThread {
  numberId: number;
  identifier: string;
}
export interface WorkspacePlan {
  workspaceId: string;
  newTags: PlannedTag[];
  opportunities: PlannedOpportunity[];
  skipped: SkippedThread[];
  eligibleByStage: Record<string, number>; // candidatos (inclui já-migrados)
  oppsByStatus: Record<string, number>; // opps NOVAS a criar
  attachmentCount: number;
}
export interface MigrationPlan {
  workspaces: WorkspacePlan[];
  totals: { opportunities: number; newTags: number; attachments: number; skipped: number };
}

const pairKey = (numberId: number, identifier: string): string => `${numberId} ${identifier}`;

// Cores fixas das etiquetas derivadas de lead_temperature (spec §4 + brief).
// A coluna não tem CHECK, então qualquer valor fora dos 3 conhecidos → slate.
function temperatureColor(lowerName: string): TagColor {
  switch (lowerName) {
    case 'quente':
      return 'red';
    case 'morno':
      return 'amber';
    case 'frio':
      return 'blue';
    default:
      return 'slate';
  }
}

type Tuple = [number, string, string];
function cmpTuple(a: Tuple, b: Tuple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}
function cmpThread(a: ThreadRow, b: ThreadRow): number {
  if (a.numberId !== b.numberId) return a.numberId - b.numberId;
  if (a.identifier !== b.identifier) return a.identifier < b.identifier ? -1 : 1;
  return 0;
}

interface TagAgg {
  name: string; // casing da menor tupla (number_id, identifier, raw)
  bestTuple: Tuple;
  hasTemperature: boolean;
}

/**
 * Planejamento PURO da migração. Determinístico: a mesma entrada (independente da
 * ordem das arrays) devolve o mesmo plano.
 *
 * Regras (spec §4):
 * - 1 opportunity por thread elegível (lead_stage cliente/qualificado/perdido via
 *   migrationRowFor; desqualificado/null → ignorado). created_at/closed_at = updated_at.
 * - Idempotência: par (number_id, identifier) já com opp created_by='migration' → skip total.
 * - Etiquetas: thread_tags + lead_temperature viram catálogo por workspace; dedupe por
 *   lower(name); casing = primeira ocorrência (menor tupla (number_id, identifier, raw)).
 * - Cor: temperature usa cor fixa (quente/morno/frio/slate) e NÃO consome slot da paleta;
 *   demais etiquetas ciclam TAG_COLORS em ordem alfabética de lower(name), com o cursor
 *   começando na contagem de tags já existentes no catálogo do workspace (catálogo com N
 *   tags → próxima nova usa TAG_COLORS[N % 10]).
 */
export function planMigration(input: PlanInput): MigrationPlan {
  const migrated = new Set<string>();
  for (const m of input.migratedPairs) migrated.add(pairKey(m.numberId, m.identifier));

  const tagsByPair = new Map<string, ThreadTagRow[]>();
  for (const tt of input.threadTags) {
    const k = pairKey(tt.numberId, tt.identifier);
    const arr = tagsByPair.get(k);
    if (arr) arr.push(tt);
    else tagsByPair.set(k, [tt]);
  }

  // catálogo existente por workspace: lower(name) → casing existente
  const existingByWs = new Map<string, Map<string, string>>();
  for (const c of input.existingCatalogTags) {
    const key = c.name.trim().toLowerCase();
    let m = existingByWs.get(c.workspaceId);
    if (!m) {
      m = new Map();
      existingByWs.set(c.workspaceId, m);
    }
    if (!m.has(key)) m.set(key, c.name);
  }

  const wsIds = new Set<string>();
  const threadsByWs = new Map<string, ThreadRow[]>();
  for (const t of input.threads) {
    wsIds.add(t.workspaceId);
    const arr = threadsByWs.get(t.workspaceId);
    if (arr) arr.push(t);
    else threadsByWs.set(t.workspaceId, [t]);
  }

  const workspaces: WorkspacePlan[] = [];
  for (const workspaceId of [...wsIds].sort()) {
    const threads = (threadsByWs.get(workspaceId) ?? []).slice().sort(cmpThread);
    const existing = existingByWs.get(workspaceId) ?? new Map<string, string>();

    const eligibleByStage: Record<string, number> = {};
    const oppsByStatus: Record<string, number> = {};
    const skipped: SkippedThread[] = [];
    const agg = new Map<string, TagAgg>();
    const drafts: { opp: PlannedOpportunity; attachmentKeys: string[] }[] = [];

    for (const t of threads) {
      const stage = t.leadStage ?? '';
      const row = migrationRowFor(stage);
      if (!row) continue; // não elegível
      eligibleByStage[stage] = (eligibleByStage[stage] ?? 0) + 1;

      const pk = pairKey(t.numberId, t.identifier);
      if (migrated.has(pk)) {
        skipped.push({ numberId: t.numberId, identifier: t.identifier });
        continue;
      }
      oppsByStatus[row.status] = (oppsByStatus[row.status] ?? 0) + 1;

      // intents de etiqueta desta thread: temperature (1) + thread_tags (N)
      const intents: { key: string; name: string; tuple: Tuple; isTemperature: boolean }[] = [];
      if (t.leadTemperature != null) {
        const nm = normalizeTagName(t.leadTemperature);
        if (nm) {
          intents.push({
            key: nm.toLowerCase(),
            name: nm,
            tuple: [t.numberId, t.identifier, t.leadTemperature],
            isTemperature: true,
          });
        }
      }
      for (const tt of tagsByPair.get(pk) ?? []) {
        const nm = normalizeTagName(tt.tag);
        if (nm) {
          intents.push({
            key: nm.toLowerCase(),
            name: nm,
            tuple: [t.numberId, t.identifier, tt.tag],
            isTemperature: false,
          });
        }
      }

      const attachKeys: string[] = [];
      const seen = new Set<string>();
      for (const it of intents) {
        const cur = agg.get(it.key);
        if (!cur) {
          agg.set(it.key, { name: it.name, bestTuple: it.tuple, hasTemperature: it.isTemperature });
        } else {
          if (it.isTemperature) cur.hasTemperature = true;
          if (cmpTuple(it.tuple, cur.bestTuple) < 0) {
            cur.bestTuple = it.tuple;
            cur.name = it.name;
          }
        }
        if (!seen.has(it.key)) {
          seen.add(it.key);
          attachKeys.push(it.key);
        }
      }
      attachKeys.sort();

      drafts.push({
        opp: {
          numberId: t.numberId,
          identifier: t.identifier,
          status: row.status,
          qualification: row.qualification,
          closed: row.closed,
          createdAt: t.updatedAt,
          closedAt: row.closed ? t.updatedAt : null,
          attachments: [],
        },
        attachmentKeys: attachKeys,
      });
    }

    // etiquetas novas (chaves ausentes do catálogo), com atribuição de cor
    const newKeys = [...agg.keys()].filter((k) => !existing.has(k)).sort();
    let cursor = existing.size;
    const newTags: PlannedTag[] = [];
    const resolvedName = new Map<string, string>(existing);
    for (const key of newKeys) {
      const a = agg.get(key)!;
      let color: TagColor;
      if (a.hasTemperature) {
        color = temperatureColor(key);
      } else {
        color = TAG_COLORS[cursor % TAG_COLORS.length]!;
        cursor += 1;
      }
      newTags.push({ key, name: a.name, color });
      resolvedName.set(key, a.name);
    }

    let attachmentCount = 0;
    const opportunities: PlannedOpportunity[] = [];
    for (const d of drafts) {
      d.opp.attachments = d.attachmentKeys.map((k) => ({ tagKey: k, tagName: resolvedName.get(k)! }));
      attachmentCount += d.opp.attachments.length;
      opportunities.push(d.opp);
    }

    workspaces.push({
      workspaceId,
      newTags,
      opportunities,
      skipped,
      eligibleByStage,
      oppsByStatus,
      attachmentCount,
    });
  }

  const totals = { opportunities: 0, newTags: 0, attachments: 0, skipped: 0 };
  for (const w of workspaces) {
    totals.opportunities += w.opportunities.length;
    totals.newTags += w.newTags.length;
    totals.attachments += w.attachmentCount;
    totals.skipped += w.skipped.length;
  }
  return { workspaces, totals };
}

// ── CLI plumbing ────────────────────────────────────────────────────────────
export interface CliArgs {
  apply: boolean;
  dryRun: boolean;
  workspace: string | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const hasApply = argv.includes('--apply');
  const hasDry = argv.includes('--dry-run');
  // Default (sem flag) = dry-run. Só escreve com --apply. --dry-run explícito
  // sempre vence por segurança (--apply --dry-run = dry-run).
  const apply = hasApply && !hasDry;
  let workspace: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--workspace=')) workspace = a.slice('--workspace='.length) || null;
  }
  return { apply, dryRun: !apply, workspace };
}

function firstRow<T = any>(rows: T[], ctx: string): T {
  const r = rows[0];
  if (r === undefined) throw new Error(`esperava row de ${ctx}`);
  return r;
}

async function readPlanInput(pool: Pool, workspace: string | null): Promise<PlanInput> {
  const wsParam = workspace ? [workspace] : [];
  const wsThreads = workspace ? ' AND n.workspace_id = $1' : '';

  const threadsQ = await pool.query(
    `SELECT tm.whatsapp_number_id, tm.identifier, n.workspace_id,
            tm.lead_stage, tm.lead_temperature, tm.updated_at
       FROM whatsapp_thread_meta tm
       JOIN whatsapp_numbers n ON n.id = tm.whatsapp_number_id
      WHERE tm.lead_stage IN ('qualificado','cliente','perdido')${wsThreads}`,
    wsParam,
  );
  const threads: ThreadRow[] = threadsQ.rows.map((r: any) => ({
    numberId: Number(r.whatsapp_number_id),
    identifier: r.identifier,
    workspaceId: r.workspace_id,
    leadStage: r.lead_stage,
    leadTemperature: r.lead_temperature,
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at),
  }));

  const tagsQ = await pool.query(
    `SELECT tt.whatsapp_number_id, tt.identifier, tt.tag
       FROM whatsapp_thread_tags tt
       JOIN whatsapp_numbers n ON n.id = tt.whatsapp_number_id
      ${workspace ? 'WHERE n.workspace_id = $1' : ''}`,
    wsParam,
  );
  const threadTags: ThreadTagRow[] = tagsQ.rows.map((r: any) => ({
    numberId: Number(r.whatsapp_number_id),
    identifier: r.identifier,
    tag: r.tag,
  }));

  const catQ = await pool.query(
    `SELECT workspace_id, name FROM whatsapp_tags${workspace ? ' WHERE workspace_id = $1' : ''}`,
    wsParam,
  );
  const existingCatalogTags: CatalogTagRow[] = catQ.rows.map((r: any) => ({
    workspaceId: r.workspace_id,
    name: r.name,
  }));

  const migQ = await pool.query(
    `SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities
      WHERE created_by = 'migration'${workspace ? ' AND workspace_id = $1' : ''}`,
    wsParam,
  );
  const migratedPairs: MigratedPairRow[] = migQ.rows.map((r: any) => ({
    numberId: Number(r.whatsapp_number_id),
    identifier: r.identifier,
  }));

  return { threads, threadTags, existingCatalogTags, migratedPairs };
}

async function applyWorkspacePlan(client: PoolClient, ws: WorkspacePlan): Promise<void> {
  await client.query('BEGIN');
  try {
    const tagIdByKey = new Map<string, number>();
    const existing = await client.query(
      `SELECT id, name FROM whatsapp_tags WHERE workspace_id = $1`,
      [ws.workspaceId],
    );
    for (const r of existing.rows) tagIdByKey.set(String(r.name).trim().toLowerCase(), Number(r.id));

    for (const t of ws.newTags) {
      const ins = await client.query(
        `INSERT INTO whatsapp_tags (workspace_id, name, color) VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id, lower(name)) DO NOTHING RETURNING id`,
        [ws.workspaceId, t.name, t.color],
      );
      let id: number;
      if (ins.rows[0]) {
        id = Number(ins.rows[0].id);
      } else {
        const sel = await client.query(
          `SELECT id FROM whatsapp_tags WHERE workspace_id = $1 AND lower(name) = lower($2)`,
          [ws.workspaceId, t.name],
        );
        id = Number(firstRow(sel.rows, `resolução da tag ${t.name}`).id);
      }
      tagIdByKey.set(t.key, id);
    }

    for (const opp of ws.opportunities) {
      const ins = await client.query(
        `INSERT INTO whatsapp_opportunities
           (whatsapp_number_id, identifier, workspace_id, title, status, qualification,
            created_at, updated_at, created_by, closed_at)
         VALUES ($1,$2,$3,NULL,$4,$5,$6::timestamptz,$6::timestamptz,'migration',$7)
         RETURNING id`,
        [opp.numberId, opp.identifier, ws.workspaceId, opp.status, opp.qualification, opp.createdAt, opp.closedAt],
      );
      const oppId = Number(firstRow(ins.rows, 'insert de opportunity').id);
      await client.query(
        `INSERT INTO whatsapp_opportunity_events
           (opportunity_id, field, old_value, new_value, changed_by, changed_at)
         VALUES ($1,'created',NULL,NULL,'migration',$2::timestamptz)`,
        [oppId, opp.createdAt],
      );
      for (const at of opp.attachments) {
        const tagId = tagIdByKey.get(at.tagKey);
        if (tagId === undefined) throw new Error(`tag não resolvida: ${at.tagKey}`);
        await client.query(
          `INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [oppId, tagId],
        );
        await client.query(
          `INSERT INTO whatsapp_opportunity_events
             (opportunity_id, field, old_value, new_value, changed_by, changed_at)
           VALUES ($1,'tag_added',NULL,$2,'migration',$3::timestamptz)`,
          [oppId, at.tagName, opp.createdAt],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

function printReport(plan: MigrationPlan, args: CliArgs): void {
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  const scope = args.workspace ? ` (workspace=${args.workspace})` : '';
  console.log(`# migração de oportunidades — ${mode}${scope}`);
  for (const ws of plan.workspaces) {
    console.log(`\nworkspace ${ws.workspaceId}`);
    console.log(`  elegíveis por stage: ${JSON.stringify(ws.eligibleByStage)}`);
    console.log(
      `  opps a criar por status: ${JSON.stringify(ws.oppsByStatus)} (total ${ws.opportunities.length})`,
    );
    const tagList = ws.newTags.map((t) => `${t.name}:${t.color}`).join(', ');
    console.log(`  tags novas no catálogo: ${ws.newTags.length}${tagList ? ` → ${tagList}` : ''}`);
    console.log(`  anexos: ${ws.attachmentCount}`);
    console.log(`  threads puladas (já migradas): ${ws.skipped.length}`);
  }
  const t = plan.totals;
  console.log(
    `\n# total: ${t.opportunities} opps · ${t.newTags} tags · ${t.attachments} anexos · ${t.skipped} puladas`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { pool } = await import('../db.js');
  const input = await readPlanInput(pool, args.workspace);
  const plan = planMigration(input);
  printReport(plan, args);

  let failures = 0;
  if (args.apply) {
    for (const ws of plan.workspaces) {
      if (ws.opportunities.length === 0 && ws.newTags.length === 0) continue;
      const client = await pool.connect();
      try {
        await applyWorkspacePlan(client, ws);
        console.log(
          `[apply] ${ws.workspaceId}: ${ws.opportunities.length} opps, ${ws.newTags.length} tags novas, ${ws.attachmentCount} anexos`,
        );
      } catch (err) {
        failures += 1;
        console.error(`[apply] FALHOU ${ws.workspaceId}: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
    console.log(
      `[apply] concluído: ${plan.totals.opportunities} opps planejadas, ${failures} workspace(s) com falha`,
    );
  }

  await pool.end();
  if (failures > 0) process.exitCode = 1;
}

// Só dispara quando executado como script (não quando importado por um teste).
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
