/**
 * src/whatsapp/opportunity-pipeline.ts
 *
 * CRM WhatsApp v3 — Fase B, Task B1: poller de CRIAÇÃO. A cada ciclo (~5min),
 * varre os workspaces que já têm row em `whatsapp_workspace_settings` (Task 5-A
 * garante a row no provisionamento — workspace sem row fica de fora, sem
 * sintetizar default aqui) por pares DM (número, identifier) que:
 *   - têm mensagem mais nova que `pipeline_since` (não retroage sobre histórico
 *     pré-pipeline);
 *   - NÃO são explicitamente not_lead (`tm.is_lead IS DISTINCT FROM FALSE` —
 *     cobre indefinido/NULL e lead/TRUE, só exclui FALSE);
 *   - NUNCA tiveram oportunidade (qualquer status, não só em_andamento);
 *   - NÃO são grupo — detector CANÔNICO (mesmo de stats.ts/read-queries.ts):
 *     row em whatsapp_groups pelo jid OU alguma message do par com
 *     author IS NOT NULL.
 *
 * Cria 1 oportunidade em_andamento/is_qualified NULL/created_by='system' por
 * candidato via createOpportunityV3(..., { skipIfAnyOpportunity: true }): a
 * re-checagem "zero opps do par" roda DENTRO da transação/lock do create — uma
 * corrida entre o SELECT desta varredura (fora do lock) e o create (2 sweeps
 * concorrentes, ou um humano criando manualmente no meio) nunca duplica; quem
 * perde a corrida volta { skipped: true }.
 *
 * Loop SERIAL por workspace (escala atual é pequena, sem necessidade de pool de
 * concorrência). Erro num workspace (query de candidatos ou algum create) loga
 * warn e segue pros demais — best-effort, nunca aborta o ciclo inteiro.
 *
 * Módulo PURO no sentido de imports: só tipos de 'pg' + opportunities.ts (que só
 * importa tipos + módulos puros) — NÃO importa config.js/env de servidor, então
 * `tests/opportunity-pipeline.test.ts` roda local sem DATABASE_URL nem demais env
 * obrigatórias do servidor.
 */
import type { Pool } from 'pg';
import { createOpportunityV3 } from './opportunities.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5min

/**
 * Resolve o intervalo do poller: o param explícito (`intervalMs`) sempre vence;
 * senão lê `CRM_CREATION_POLL_MS` direto de `process.env` (SEM config.js — ver
 * nota de pureza acima); ausente/vazio/inválido (não-numérico, <=0) cai no
 * default de 5min.
 */
export function resolvePollIntervalMs(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.CRM_CREATION_POLL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

// Candidatos: pares DM com mensagem > pipeline_since, is_lead ≠ FALSE, ZERO opps
// no par (nunca teve, qualquer status). $1 = workspace_id, $2 = pipeline_since.
const CANDIDATES_SQL = `
  SELECT DISTINCT m.whatsapp_number_id, m.identifier, m.workspace_id
    FROM messages m
    LEFT JOIN whatsapp_thread_meta tm
      ON tm.whatsapp_number_id = m.whatsapp_number_id AND tm.identifier = m.identifier
   WHERE m.workspace_id = $1
     AND m.created_at > $2
     AND (tm.is_lead IS DISTINCT FROM FALSE)
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_opportunities o
        WHERE o.whatsapp_number_id = m.whatsapp_number_id AND o.identifier = m.identifier
     )
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_groups g
        WHERE g.whatsapp_number_id = m.whatsapp_number_id AND g.jid = m.identifier
     )
     AND NOT EXISTS (
       SELECT 1 FROM messages m2
        WHERE m2.whatsapp_number_id = m.whatsapp_number_id AND m2.identifier = m.identifier
          AND m2.author IS NOT NULL
     )`;

/**
 * 1 ciclo do poller de criação. Best-effort por workspace: erro num workspace
 * (query de candidatos ou algum create) loga warn e passa pro próximo — nunca
 * lança, então um workspace com problema não impede os demais de rodarem.
 */
export async function runCreationSweep(pool: Pool): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  const { rows: workspaces } = await pool.query(
    `SELECT workspace_id, pipeline_since FROM whatsapp_workspace_settings`,
  );
  for (const row of workspaces) {
    const workspaceId = String(row.workspace_id);
    try {
      const { rows: candidates } = await pool.query(CANDIDATES_SQL, [workspaceId, row.pipeline_since]);
      for (const c of candidates) {
        const numberId = Number(c.whatsapp_number_id);
        const identifier = String(c.identifier);
        const result = await createOpportunityV3(pool, {
          numberId, workspaceId, identifier, createdBy: 'system', skipIfAnyOpportunity: true,
        });
        // result===null é inalcançável aqui (sem tagIds não há validação de tag pra falhar) —
        // tratado defensivamente como "não criou" (nem created nem skipped) em vez de lançar.
        if (result && 'skipped' in result) skipped++;
        else if (result) created++;
      }
    } catch (err) {
      console.warn(`[opportunity-pipeline] sweep de criação falhou pro workspace ${workspaceId}:`, (err as Error).message);
    }
  }
  return { created, skipped };
}

/**
 * Poller (setInterval + flag in-flight — molde de events/dispatcher.ts): default
 * 5min, override via `CRM_CREATION_POLL_MS` ou o param `intervalMs`. Um ciclo em
 * andamento bloqueia o tick seguinte (nunca 2 sweeps concorrentes).
 */
export function startCreationPoller(pool: Pool, intervalMs?: number): NodeJS.Timeout {
  const ms = resolvePollIntervalMs(intervalMs);
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runCreationSweep(pool);
    } catch (err) {
      console.error('[opportunity-pipeline] ciclo do poller de criação falhou:', (err as Error).message);
    } finally {
      running = false;
    }
  }, ms);
}
