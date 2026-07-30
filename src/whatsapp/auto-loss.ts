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
 *
 * Motivo da perda (spec §6) deriva de quem falou por último no par:
 *   - última mensagem 'outbound' (atendente falou, lead sumiu) → lead_nao_respondeu
 *   - última mensagem 'inbound' (lead falou, atendente não respondeu) → atendente_nao_respondeu
 *   - par SEM mensagem nenhuma (max_at NULL — ex.: opp manual numa conversa sem
 *     histórico) → lead_nao_respondeu (default documentado: sem evidência de
 *     quem "devia" responder, a spec resolve o empate a favor do lead, mesmo
 *     lado do caso 'outbound')
 *
 * Fecha 1 a 1 via patchOpportunityV3 (lock da conversa + kernel + eventos,
 * changedBy='system'). `{ok:false}` (ex.: 'not_found' — a opp sumiu entre o
 * SELECT de candidatos e o patch) loga warn e segue — best-effort, nunca aborta
 * o workspace nem o ciclo.
 *
 * Idempotente: opp fechada deixa de ser `em_andamento`, então some da query de
 * candidatos no próximo sweep — rodar N vezes/dia é inócuo.
 *
 * Módulo PURO no sentido de imports: só tipos de 'pg' + opportunities.ts (kernel
 * + lock) + loss-reasons.ts (constantes SYSTEM_LOSS_REASONS) — nenhum dos dois
 * importa config.js/env de servidor, então tests/auto-loss.test.ts roda local
 * sem DATABASE_URL (mesmo molde de opportunity-pipeline.ts, Fase B Task B1).
 */
import type { Pool } from 'pg';
import { patchOpportunityV3 } from './opportunities.js';
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
// mensagem do par e o created_at da própria opp) já passou de auto_loss_days.
// $1 = workspace_id, $2 = auto_loss_days. Desempate de "quem falou por último"
// via ORDER BY created_at DESC, id DESC (2 mensagens no mesmo timestamp — o id
// mais alto vence) dentro do ARRAY_AGG.
const CANDIDATES_SQL = `
  SELECT o.id, o.whatsapp_number_id, o.identifier,
         GREATEST(COALESCE(last.max_at, 'epoch'::timestamptz), o.created_at) AS last_activity,
         last.direction AS last_direction
    FROM whatsapp_opportunities o
    LEFT JOIN LATERAL (
      SELECT MAX(m.created_at) AS max_at,
             (ARRAY_AGG(m.direction ORDER BY m.created_at DESC, m.id DESC))[1] AS direction
        FROM messages m
       WHERE m.whatsapp_number_id = o.whatsapp_number_id AND m.identifier = o.identifier
    ) last ON TRUE
   WHERE o.workspace_id = $1 AND o.status = 'em_andamento'
     AND GREATEST(COALESCE(last.max_at, 'epoch'::timestamptz), o.created_at) < NOW() - make_interval(days => $2)`;

/**
 * 1 ciclo do sweep de auto-perda. Best-effort: erro na query de candidatos de
 * um workspace loga warn e passa pro próximo; um patch individual que volta
 * `{ok:false}` (ex.: not_found) loga warn e segue pros demais candidatos —
 * nunca lança, então um workspace/opp com problema não impede os demais.
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
        const lossReason = lossReasonForLastDirection(c.last_direction);
        const result = await patchOpportunityV3(pool, opportunityId, { status: 'perdido', lossReason }, 'system');
        if (result.ok) closed++;
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
