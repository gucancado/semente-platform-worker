/**
 * src/whatsapp/auto-loss.ts
 *
 * CRM WhatsApp v3 — Fase B, Task B2: job de AUTO-PERDA por inatividade. A cada
 * ciclo (~1h), varre os workspaces com `auto_loss_days` configurado (NULL —
 * incluindo workspace sem row, já que `getOrCreateSettings` nunca é chamado
 * aqui — fica de fora, a própria SQL de settings filtra) por oportunidades
 * `em_andamento` cuja última atividade já passou de `auto_loss_days`.
 *
 * "Última atividade" = GREATEST(MAX(messages.created_at) do par, created_at da
 * própria opp). O GREATEST cobre um caso sutil: uma opp criada manualmente numa
 * conversa já dormente ganha a janela cheia a partir da PRÓPRIA criação, não do
 * histórico velho do par — senão nasceria "auto-perdível" no minuto seguinte.
 * Candidato também exige `is_lead IS DISTINCT FROM FALSE` (join com
 * whatsapp_thread_meta) — mesma simetria do poller de criação (B1): uma opp
 * órfã numa thread explicitamente not_lead não devia virar "perda" com motivo
 * (a thread já foi triada como não-lead por outro caminho).
 *
 * Motivo da perda (spec §6) deriva de quem falou por último no par:
 *   - última mensagem 'outbound' (atendente falou, lead sumiu) → lead_nao_respondeu
 *   - última mensagem 'inbound' (lead falou, atendente não respondeu) → atendente_nao_respondeu
 *   - par SEM mensagem nenhuma (max_at NULL — ex.: opp manual numa conversa sem
 *     histórico) → lead_nao_respondeu (default documentado: sem evidência de
 *     quem "devia" responder, a spec resolve o empate a favor do lead, mesmo
 *     lado do caso 'outbound')
 *
 * Fecha 1 a 1 via patchOpportunityGuarded (lock da conversa + kernel + eventos,
 * changedBy='system') com um GUARD avaliado DENTRO do lock, depois do re-read e
 * ANTES de qualquer escrita — fecha a janela entre o SELECT de candidatos (fora
 * do lock) e o momento em que o patch toma o lock, onde o mundo pode ter mudado:
 *   (a) status deixou de ser 'em_andamento' — um humano marcou ganho (ou já
 *       fechou/reabriu) nesse meio-tempo. SEM o guard, `applyOppPatchV3` aceita
 *       ganho→perdido (não seta isQualified, então não bate no invariante
 *       desqualificar_ganho) e o sweep clobberaria uma venda real — resetando
 *       closed_at e sem qualquer auto-cura. O guard mata isso na raiz: só
 *       prossegue se `current.status === 'em_andamento'`.
 *   (b) o par deixou de estar inativo — uma mensagem nova chegou depois do
 *       SELECT de candidatos. O guard RE-EXECUTA a checagem de inatividade
 *       (MAX(messages.created_at) fresco, não o `last_activity` já calculado
 *       pelo SELECT de candidatos) sob o mesmo lock que vai escrever.
 * Guard `false` → `{ok:false, error:'conflict'}`, SEM escrever nada — loga
 * `console.info` (não é erro, é o guard funcionando) e segue pro próximo
 * candidato. `{ok:false, error:'not_found'}` (opp sumiu de vez) loga warn e
 * segue igual — best-effort, nunca aborta o workspace nem o ciclo.
 *
 * Idempotente: opp fechada deixa de ser `em_andamento`, então some da query de
 * candidatos no próximo sweep — rodar N vezes/dia é inócuo.
 *
 * Módulo PURO no sentido de imports: só tipos de 'pg' + opportunities.ts (kernel
 * + lock) + opportunity-core.ts (tipo OppStateV3) + loss-reasons.ts (constantes
 * SYSTEM_LOSS_REASONS) — nenhum deles importa config.js/env de servidor, então
 * tests/auto-loss.test.ts roda local sem DATABASE_URL (mesmo molde de
 * opportunity-pipeline.ts, Fase B Task B1).
 */
import type { Pool, PoolClient } from 'pg';
import { patchOpportunityGuarded, type PatchGuard } from './opportunities.js';
import type { OppStateV3 } from './opportunity-core.js';
import { SYSTEM_LOSS_REASONS } from './loss-reasons.js';

const DEFAULT_INTERVAL_MS = 60 * 60_000; // 1h

// Códigos de sistema (loss-reasons.ts define a ordem: [0]=lead_nao_respondeu,
// [1]=atendente_nao_respondeu) — sempre via constante, nunca string solta.
const LEAD_NAO_RESPONDEU = SYSTEM_LOSS_REASONS[0].code;
const ATENDENTE_NAO_RESPONDEU = SYSTEM_LOSS_REASONS[1].code;

/**
 * Motivo de auto-perda a partir da direção da última mensagem do par (spec §6).
 * `null`/`undefined` (par sem NENHUMA mensagem, `last.direction` sai NULL do
 * LEFT JOIN LATERAL sem match) cai no mesmo default do caso 'outbound' — ver
 * doc do módulo.
 */
export function lossReasonForLastDirection(lastDirection: string | null | undefined): string {
  return lastDirection === 'inbound' ? ATENDENTE_NAO_RESPONDEU : LEAD_NAO_RESPONDEU;
}

/**
 * Resolve o intervalo do poller: o param explícito (`intervalMs`) sempre vence;
 * senão lê `CRM_AUTOLOSS_POLL_MS` direto de `process.env` (SEM config.js — ver
 * nota de pureza acima); ausente/vazio/inválido (não-numérico, <=0) cai no
 * default de 1h.
 */
export function resolveAutoLossPollIntervalMs(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.CRM_AUTOLOSS_POLL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

// Candidatos: opps em_andamento cuja última atividade (GREATEST entre a última
// mensagem do par e o created_at da própria opp) já passou de auto_loss_days,
// numa thread que não é explicitamente not_lead (simetria com o poller B1).
// $1 = workspace_id, $2 = auto_loss_days. Desempate de "quem falou por último"
// via ORDER BY created_at DESC, id DESC (2 mensagens no mesmo timestamp — o id
// mais alto vence) dentro do ARRAY_AGG. Traz o.created_at cru (além do
// last_activity já combinado) pra o guard do patch poder re-checar a inatividade
// sob o lock sem precisar re-selecionar a opportunity.
const CANDIDATES_SQL = `
  SELECT o.id, o.whatsapp_number_id, o.identifier, o.created_at,
         GREATEST(COALESCE(last.max_at, 'epoch'::timestamptz), o.created_at) AS last_activity,
         last.direction AS last_direction
    FROM whatsapp_opportunities o
    LEFT JOIN whatsapp_thread_meta tm
      ON tm.whatsapp_number_id = o.whatsapp_number_id AND tm.identifier = o.identifier
    LEFT JOIN LATERAL (
      SELECT MAX(m.created_at) AS max_at,
             (ARRAY_AGG(m.direction ORDER BY m.created_at DESC, m.id DESC))[1] AS direction
        FROM messages m
       WHERE m.whatsapp_number_id = o.whatsapp_number_id AND m.identifier = o.identifier
    ) last ON TRUE
   WHERE o.workspace_id = $1 AND o.status = 'em_andamento'
     AND (tm.is_lead IS DISTINCT FROM FALSE)
     AND GREATEST(COALESCE(last.max_at, 'epoch'::timestamptz), o.created_at) < NOW() - make_interval(days => $2)`;

/**
 * Guard do patch de auto-perda (roda DENTRO do lock, depois do re-read, antes de
 * qualquer escrita — ver doc do módulo, itens (a)/(b)). `createdAt`/`autoLossDays`
 * vêm do SELECT de candidatos (fora do lock); o guard usa `createdAt` (imutável)
 * mas RE-LÊ `MAX(messages.created_at)` fresco — é exatamente essa releitura que
 * pega uma mensagem nova chegada depois do SELECT de candidatos.
 */
function autoLossGuard(ctx: { numberId: number; identifier: string; createdAt: unknown; autoLossDays: number }): PatchGuard {
  return async (client: PoolClient, current: OppStateV3): Promise<boolean> => {
    if (current.status !== 'em_andamento') return false; // (a) humano já fechou diferente (ex.: ganho)
    const { rows } = await client.query(
      `SELECT GREATEST(COALESCE((SELECT MAX(m.created_at) FROM messages m
          WHERE m.whatsapp_number_id = $1 AND m.identifier = $2), 'epoch'::timestamptz), $3::timestamptz)
         < NOW() - make_interval(days => $4) AS still_stale`,
      [ctx.numberId, ctx.identifier, ctx.createdAt, ctx.autoLossDays],
    );
    return rows[0]?.still_stale === true; // (b) segue inativo mesmo com leitura fresca
  };
}

/**
 * 1 ciclo do sweep de auto-perda. Best-effort: erro na query de candidatos de
 * um workspace loga warn e passa pro próximo; um patch individual que volta
 * `{ok:false, error:'not_found'}` loga warn e segue pros demais candidatos —
 * nunca lança, então um workspace/opp com problema não impede os demais. Um
 * patch que volta `{ok:false, error:'conflict'}` (guard recusou — deixou de ser
 * candidata entre o SELECT e o lock) loga info (é o guard funcionando, não um
 * erro) e segue.
 */
export async function runAutoLossSweep(pool: Pool): Promise<{ closed: number }> {
  let closed = 0;
  const { rows: workspaces } = await pool.query(
    `SELECT workspace_id, auto_loss_days FROM whatsapp_workspace_settings WHERE auto_loss_days IS NOT NULL`,
  );
  for (const row of workspaces) {
    const workspaceId = String(row.workspace_id);
    const autoLossDays = Number(row.auto_loss_days);
    try {
      const { rows: candidates } = await pool.query(CANDIDATES_SQL, [workspaceId, autoLossDays]);
      for (const c of candidates) {
        const opportunityId = Number(c.id);
        const numberId = Number(c.whatsapp_number_id);
        const identifier = String(c.identifier);
        const lossReason = lossReasonForLastDirection(c.last_direction);
        const guard = autoLossGuard({ numberId, identifier, createdAt: c.created_at, autoLossDays });
        const result = await patchOpportunityGuarded(pool, opportunityId, { status: 'perdido', lossReason }, 'system', guard);
        if (result.ok) closed++;
        else if (result.error === 'conflict') console.info(`[auto-loss] opp ${opportunityId} deixou de ser candidata (workspace ${workspaceId}) — segue`);
        else console.warn(`[auto-loss] falha ao fechar opp ${opportunityId} (workspace ${workspaceId}): ${result.error}`);
      }
    } catch (err) {
      console.warn(`[auto-loss] sweep falhou pro workspace ${workspaceId}:`, (err as Error).message);
    }
  }
  return { closed };
}

/**
 * Poller (setInterval + flag in-flight — mesmo molde de opportunity-pipeline.ts,
 * Fase B Task B1): default 1h, override via `CRM_AUTOLOSS_POLL_MS` ou o param
 * `intervalMs`. Um ciclo em andamento bloqueia o tick seguinte (nunca 2 sweeps
 * concorrentes).
 */
export function startAutoLossPoller(pool: Pool, intervalMs?: number): NodeJS.Timeout {
  const ms = resolveAutoLossPollIntervalMs(intervalMs);
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runAutoLossSweep(pool);
    } catch (err) {
      console.error('[auto-loss] ciclo do poller de auto-perda falhou:', (err as Error).message);
    } finally {
      running = false;
    }
  }, ms);
}
