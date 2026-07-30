import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { getOrCreateSettings } from '../whatsapp/workspace-settings.js';

// ─────────────────────────────────────────────────────────────────────────────
// Script one-off (roda em prod como `node dist/cli/migrate-crm-v3.js`, docker exec):
// cutover do CRM WhatsApp v3 (spec §12.2 e §12.4, migration 051).
//
// Dois passos independentes:
//  1. Promoção de triagem: par (numberId, identifier) com pelo menos 1 opp
//     `created_by='migration'` (estagiada na v1 = já triada) E cuja
//     whatsapp_thread_meta.is_lead ainda é NULL (ou nem tem row) → grava
//     is_lead=TRUE + log em whatsapp_thread_meta_log (actor='migration'). SÓ
//     promove NULL→TRUE — nunca toca FALSE (não-lead humano fica intocado).
//  2. Seed de settings: garante 1 row em whatsapp_workspace_settings pra CADA
//     workspace distinto de whatsapp_numbers, via getOrCreateSettings (mesma
//     função dos jobs da Fase B/D — nunca INSERT manual aqui).
//
// Molde: src/cli/migrate-opportunities.ts — planejamento PURO (planCutover)
// separado da leitura/escrita em banco, dry-run por default, --apply executa,
// --workspace=<id> restringe os dois passos, relatório com contagens por
// workspace. Idempotente: re-rodar promove 0 pares (is_lead já TRUE) e o seed
// é ON CONFLICT DO NOTHING (no-op).
//
// Transação por workspace (mesmo padrão de applyWorkspacePlan no molde): as
// promoções de um workspace rodam sob 1 client dedicado com BEGIN/COMMIT —
// UPSERT+log de cada par ficam atômicos entre si E com os pares irmãos do
// mesmo workspace, então um crash a meio caminho nunca deixa is_lead=TRUE sem
// o log correspondente (o que seria uma lacuna de auditoria permanente e
// silenciosa, já que readCandidates só re-seleciona pares com is_lead NULL).
// Isolamento de falha em main(): 1 workspace que falha (ROLLBACK) não aborta
// os demais nem pula o seed de settings — cada passo é contado e reportado
// separadamente, seed roda sempre.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tipos de entrada (rows já mapeadas) ─────────────────────────────────────
export interface PromotionCandidateRow {
  numberId: number;
  identifier: string;
  workspaceId: string;
}
export interface CutoverInput {
  /** Pares elegíveis pra promoção (opp created_by='migration' + is_lead IS NULL/sem row). */
  candidates: PromotionCandidateRow[];
  /** workspace_id distintos de whatsapp_numbers — alvo do seed de settings. */
  numberWorkspaces: string[];
  /** workspace_id que já têm row em whatsapp_workspace_settings. */
  existingSettingsWorkspaces: string[];
}

// ── Tipos de saída (plano) ──────────────────────────────────────────────────
export interface WorkspaceCutoverPlan {
  workspaceId: string;
  pairs: PromotionCandidateRow[];
  needsSettings: boolean;
}
export interface CutoverPlan {
  workspaces: WorkspaceCutoverPlan[];
  totals: { pairsToPromote: number; workspacesNeedingSettings: number };
}

function cmpPair(a: PromotionCandidateRow, b: PromotionCandidateRow): number {
  if (a.numberId !== b.numberId) return a.numberId - b.numberId;
  if (a.identifier !== b.identifier) return a.identifier < b.identifier ? -1 : 1;
  return 0;
}

/**
 * Planejamento PURO do cutover. Determinístico: a mesma entrada (independente
 * da ordem das arrays) devolve o mesmo plano. União dos workspaces = workspaces
 * com candidatos ∪ workspaces de whatsapp_numbers (mesmo que um deles não
 * apareça no outro conjunto — cobre o caso raro/defensivo).
 */
export function planCutover(input: CutoverInput): CutoverPlan {
  const pairsByWs = new Map<string, PromotionCandidateRow[]>();
  for (const c of input.candidates) {
    const arr = pairsByWs.get(c.workspaceId);
    if (arr) arr.push(c);
    else pairsByWs.set(c.workspaceId, [c]);
  }

  const existingSettings = new Set(input.existingSettingsWorkspaces);

  const wsIds = new Set<string>();
  for (const w of input.numberWorkspaces) wsIds.add(w);
  for (const w of pairsByWs.keys()) wsIds.add(w);

  const workspaces: WorkspaceCutoverPlan[] = [];
  for (const workspaceId of [...wsIds].sort()) {
    const pairs = (pairsByWs.get(workspaceId) ?? []).slice().sort(cmpPair);
    workspaces.push({
      workspaceId,
      pairs,
      needsSettings: !existingSettings.has(workspaceId),
    });
  }

  const totals = { pairsToPromote: 0, workspacesNeedingSettings: 0 };
  for (const w of workspaces) {
    totals.pairsToPromote += w.pairs.length;
    if (w.needsSettings) totals.workspacesNeedingSettings += 1;
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

export function formatReport(plan: CutoverPlan, args: CliArgs): string[] {
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  const scope = args.workspace ? ` (workspace=${args.workspace})` : '';
  const lines: string[] = [`# migração CRM v3 (cutover) — ${mode}${scope}`];
  for (const ws of plan.workspaces) {
    lines.push('');
    lines.push(`workspace ${ws.workspaceId}`);
    lines.push(`  pares a promover (is_lead NULL→TRUE): ${ws.pairs.length}`);
    lines.push(`  settings: ${ws.needsSettings ? 'sem row (será criada)' : 'já existe'}`);
  }
  lines.push('');
  lines.push(
    `# total: ${plan.totals.pairsToPromote} pares a promover · ${plan.totals.workspacesNeedingSettings} workspace(s) sem settings`,
  );
  return lines;
}

function printReport(plan: CutoverPlan, args: CliArgs): void {
  for (const line of formatReport(plan, args)) console.log(line);
}

// ── Leitura (banco) ──────────────────────────────────────────────────────────

/**
 * Pares elegíveis pra promoção: opp `created_by='migration'` cuja thread ainda
 * não foi triada (`whatsapp_thread_meta.is_lead IS NULL` cobre tanto a row
 * existente com NULL quanto a ausência de row, via LEFT JOIN).
 */
export async function readCandidates(pool: Pool, workspace: string | null): Promise<PromotionCandidateRow[]> {
  const wsParam = workspace ? [workspace] : [];
  const wsFilter = workspace ? ' AND o.workspace_id = $1' : '';
  const { rows } = await pool.query(
    `SELECT DISTINCT o.whatsapp_number_id, o.identifier, o.workspace_id
       FROM whatsapp_opportunities o
       LEFT JOIN whatsapp_thread_meta tm
         ON tm.whatsapp_number_id = o.whatsapp_number_id AND tm.identifier = o.identifier
      WHERE o.created_by = 'migration'
        AND tm.is_lead IS NULL${wsFilter}`,
    wsParam,
  );
  return rows.map((r: any) => ({
    numberId: Number(r.whatsapp_number_id),
    identifier: r.identifier,
    workspaceId: r.workspace_id,
  }));
}

export async function readNumberWorkspaces(pool: Pool, workspace: string | null): Promise<string[]> {
  const wsParam = workspace ? [workspace] : [];
  const wsFilter = workspace ? ' WHERE workspace_id = $1' : '';
  const { rows } = await pool.query(
    `SELECT DISTINCT workspace_id FROM whatsapp_numbers${wsFilter}`,
    wsParam,
  );
  return rows.map((r: any) => r.workspace_id);
}

export async function readExistingSettingsWorkspaces(pool: Pool, workspace: string | null): Promise<string[]> {
  const wsParam = workspace ? [workspace] : [];
  const wsFilter = workspace ? ' WHERE workspace_id = $1' : '';
  const { rows } = await pool.query(
    `SELECT workspace_id FROM whatsapp_workspace_settings${wsFilter}`,
    wsParam,
  );
  return rows.map((r: any) => r.workspace_id);
}

export async function readCutoverInput(pool: Pool, workspace: string | null): Promise<CutoverInput> {
  const candidates = await readCandidates(pool, workspace);
  const numberWorkspaces = await readNumberWorkspaces(pool, workspace);
  const existingSettingsWorkspaces = await readExistingSettingsWorkspaces(pool, workspace);
  return { candidates, numberWorkspaces, existingSettingsWorkspaces };
}

// ── Escrita (apply) ──────────────────────────────────────────────────────────

/**
 * Promove um par DENTRO da transação já aberta pelo caller (client, não pool):
 * UPSERT direto e simples (NÃO é applyLeadUpdate — sem lock, sem cascata, sem
 * exigir updatedBy humano). O `WHERE ... is_lead IS NULL` no braço de UPDATE
 * garante que só promove quando o valor atual ainda é NULL (idempotência +
 * nunca sobrescreve FALSE, mesmo sob corrida). Devolve true só quando a row
 * foi de fato promovida (pra decidir se loga a transição).
 */
async function promotePair(client: PoolClient, pair: PromotionCandidateRow): Promise<boolean> {
  // §4.11: serializa com as mutações da conversa (rotas/poller) sob a MESMA chave
  // do withConversationLock (conversation-lock.ts) — `${numberId}:${identifier}`.
  // conversation-lock.ts não exporta helper de chave, então o formato é duplicado
  // EXATO. xact_lock é liberado no COMMIT/ROLLBACK da transação por workspace.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${pair.numberId}:${pair.identifier}`]);
  const res = await client.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, updated_at, updated_by)
     VALUES ($1, $2, TRUE, NOW(), 'migration')
     ON CONFLICT (whatsapp_number_id, identifier)
     DO UPDATE SET is_lead = TRUE, updated_at = NOW(), updated_by = 'migration'
     WHERE whatsapp_thread_meta.is_lead IS NULL
     RETURNING whatsapp_number_id`,
    [pair.numberId, pair.identifier],
  );
  const promoted = (res.rowCount ?? 0) > 0;
  if (promoted) {
    await client.query(
      `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
       VALUES ($1, $2, 'is_lead', NULL, 'true', 'migration')`,
      [pair.numberId, pair.identifier],
    );
  }
  return promoted;
}

/**
 * Aplica TODOS os pares de um workspace sob uma única transação (BEGIN...COMMIT,
 * padrão de applyWorkspacePlan no molde): UPSERT+log de cada par ficam atômicos
 * entre si — nunca sobra is_lead=TRUE sem o log correspondente, mesmo se o
 * processo cair a meio caminho. Erro em qualquer par faz ROLLBACK de TODOS os
 * pares do workspace (nada meio-promovido) e relança pro caller decidir o que
 * fazer (main() isola por workspace — ver abaixo).
 */
export async function applyWorkspacePromotions(client: PoolClient, ws: WorkspaceCutoverPlan): Promise<number> {
  await client.query('BEGIN');
  try {
    let promoted = 0;
    for (const pair of ws.pairs) {
      if (await promotePair(client, pair)) promoted += 1;
    }
    await client.query('COMMIT');
    return promoted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Seed de settings, workspace por workspace, com isolamento de falha (um
 * workspace problemático não impede os demais). Devolve a contagem de falhas
 * pro report final — chamado incondicionalmente em main(), mesmo se a etapa
 * de promoção teve falhas.
 */
async function seedSettingsForWorkspaces(pool: Pool, workspaceIds: string[]): Promise<number> {
  let failures = 0;
  for (const workspaceId of workspaceIds) {
    try {
      await getOrCreateSettings(pool, workspaceId);
    } catch (err) {
      failures += 1;
      console.error(`[apply] FALHOU seed de settings ${workspaceId}: ${(err as Error).message}`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { pool } = await import('../db.js');
  const input = await readCutoverInput(pool, args.workspace);
  const plan = planCutover(input);
  printReport(plan, args);

  if (args.apply) {
    let totalPromoted = 0;
    let promotionFailures = 0;
    // Isolamento por workspace: client dedicado + BEGIN/COMMIT dentro de
    // applyWorkspacePromotions. Um workspace que falha (ROLLBACK) não aborta
    // os demais nem impede o seed de settings logo abaixo.
    for (const ws of plan.workspaces) {
      if (ws.pairs.length === 0) continue;
      const client = await pool.connect();
      try {
        const promoted = await applyWorkspacePromotions(client, ws);
        totalPromoted += promoted;
        console.log(`[apply] ${ws.workspaceId}: ${promoted}/${ws.pairs.length} par(es) promovido(s)`);
      } catch (err) {
        promotionFailures += 1;
        console.error(`[apply] FALHOU promoção ${ws.workspaceId}: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }

    // Roda SEMPRE, mesmo com falhas de promoção acima — settings não depende
    // do resultado da triagem.
    const settingsFailures = await seedSettingsForWorkspaces(pool, input.numberWorkspaces);

    console.log(
      `[apply] concluído: ${totalPromoted} par(es) promovido(s) (${promotionFailures} workspace(s) com falha) · ` +
        `${input.numberWorkspaces.length} workspace(s) alvo de settings (${settingsFailures} falha(s))`,
    );
    if (promotionFailures > 0 || settingsFailures > 0) process.exitCode = 1;
  }

  await pool.end();
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
