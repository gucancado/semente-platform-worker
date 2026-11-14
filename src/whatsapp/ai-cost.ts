/**
 * src/whatsapp/ai-cost.ts
 *
 * Custo de IA (US$) atribuído ao WhatsApp de um workspace, lido de llm_metrics
 * (colunas de escopo da mig 077). Entra: julgamento diário do CRM, análise
 * semanal do CRM e transcrição de áudio. NÃO entra o custo de reunião (vai na
 * página da reunião) nem o de agentes (mercurio).
 *
 * Com `numberId`, soma o custo daquele número MAIS o custo do workspace inteiro
 * (whatsapp_number_id nulo = análise semanal, que olha todos os números). Num
 * workspace com mais de um número essa parcela aparece no dashboard de cada um.
 *
 * Bucket por dia/semana de São Paulo com a MESMA expressão de timeseries.ts (o
 * SQL é a autoridade de fuso); o merge com a série acontece por chave texto.
 */
import type { Pool } from 'pg';

export const WHATSAPP_AI_COST_AGENTS = ['crm-ai-judgment', 'crm-ai-pattern', 'transcription'] as const;

const SCOPE = `
  l.workspace_id = $1
  AND ($2::bigint IS NULL OR l.whatsapp_number_id = $2 OR l.whatsapp_number_id IS NULL)
  AND l.agent = ANY($3::text[])
  AND l.cost_usd IS NOT NULL
  AND ($4::timestamptz IS NULL OR l.created_at >= $4::timestamptz)
  AND ($5::timestamptz IS NULL OR l.created_at <= $5::timestamptz)`;

export async function getWhatsappAiCostTotal(
  pool: Pool,
  p: { workspaceId: string; numberId?: number; since?: string; until?: string },
): Promise<number> {
  const { rows } = await pool.query(
    `/* wa:ai_cost_total */ SELECT COALESCE(SUM(l.cost_usd), 0)::float8 AS usd FROM llm_metrics l WHERE ${SCOPE}`,
    [p.workspaceId, p.numberId ?? null, [...WHATSAPP_AI_COST_AGENTS], p.since ?? null, p.until ?? null],
  );
  return Number(rows[0]?.usd ?? 0);
}

/** Custo por bucket ('YYYY-MM-DD' do início do dia/semana em SP). Bucket sem custo não vem. */
export async function getWhatsappAiCostByBucket(
  pool: Pool,
  p: { workspaceId: string; numberId?: number; since: string; until: string; bucket: 'day' | 'week' },
): Promise<Map<string, number>> {
  const unit = p.bucket === 'week' ? 'week' : 'day';
  const { rows } = await pool.query(
    `/* wa:ai_cost_series */
     SELECT to_char(date_trunc($6::text, l.created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS bucket,
            SUM(l.cost_usd)::float8 AS usd
       FROM llm_metrics l
      WHERE ${SCOPE}
      GROUP BY 1`,
    [p.workspaceId, p.numberId ?? null, [...WHATSAPP_AI_COST_AGENTS], p.since, p.until, unit],
  );
  return new Map(rows.map((r) => [String(r.bucket), Number(r.usd)]));
}
