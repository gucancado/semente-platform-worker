import type { PoolClient } from 'pg';

/**
 * Sticky = precedência humana por dimensão (spec v3 §6). A IA nunca escreve uma
 * dimensão que um humano já escreveu naquela opp/thread. Este módulo computa, a
 * partir dos LOGS, quais dimensões estão TRAVADAS pra IA — é consultado ANTES de
 * montar o prompt (o prompt informa as travas) e RE-CHECADO na aplicação, sob o
 * lock do par (§4.11). NÃO escreve nada; recebe o `client` da transação do aplicador.
 *
 * true = TRAVADO pra IA. `tagsRemovedByHuman` = nomes de tags que um humano removeu
 * DESSA opp — a IA não re-adiciona essas (mas pode adicionar outras).
 */
export interface StickyFlags {
  isLead: boolean;
  isQualified: boolean;
  status: boolean;
  lossReason: boolean;
  tagsRemovedByHuman: string[];
}

/** Atores NÃO-humanos: cascata/criação determinística, motor de IA, migração one-off.
 *  Exportado (Task D4) como a lista canônica compartilhada pelos caminhos de escrita
 *  de sistema (o aplicador do julgamento IA e afins). */
export const SYSTEM_ACTORS = ['ai', 'system', 'migration'] as const;

/**
 * Humano = `actor IS NOT NULL AND actor NOT IN ('ai','system','migration')` E que NÃO
 * carregue o prefixo `system:` (spec §6). NULL = legado (não trava). Escrita via MCP
 * carrega uuid real → humana → trava. Um job determinístico pode se identificar com
 * sufixo (`system:backfill`, `system:auto_loss`) — o prefixo `system:` é tratado como
 * ator de sistema e NÃO trava o sticky da IA. Case-sensitive: sistema é sempre minúsculo.
 */
export function isHumanActor(actor: string | null | undefined): boolean {
  if (actor == null || actor === '') return false;
  if ((SYSTEM_ACTORS as readonly string[]).includes(actor)) return false;
  if (actor.startsWith('system:')) return false;
  return true;
}

/** Fragmento SQL do predicado humano na coluna dada (fonte única — actor / changed_by).
 *  Espelha isHumanActor: exclui a lista fixa E o prefixo `system:`. */
function humanActorSql(col: string): string {
  return `${col} IS NOT NULL AND ${col} NOT IN ('ai', 'system', 'migration') AND ${col} NOT LIKE 'system:%'`;
}

/**
 * Computa as travas de sticky do par (thread) + da opp mais recente informada.
 *
 * Fontes por dimensão (spec §6):
 *  - is_lead      ⇐ whatsapp_thread_meta_log field='is_lead' com ator humano;
 *  - is_qualified ⇐ whatsapp_opportunity_events field='qualification' humano;
 *  - status       ⇐ whatsapp_opportunity_events field='status' humano;
 *  - loss_reason  ⇐ whatsapp_opportunity_events field='loss_reason' humano;
 *  - tags         ⇐ whatsapp_opportunity_events field='tag_removed' humano → new_value.
 *
 * `opportunityId` null → as flags de opp são todas false e a lista vazia (is_lead
 * continua derivando do log da thread, que independe de opp).
 */
export async function computeSticky(
  client: Pick<PoolClient, 'query'>,
  p: { numberId: number; identifier: string; opportunityId: number | null },
): Promise<StickyFlags> {
  // Trava de is_lead: qualquer mudança real de is_lead com ator humano (o writer
  // loga is_lead SÓ em mudança efetiva — §3.1) trava a triagem pra IA.
  const leadRes = await client.query<{ is_lead: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM whatsapp_thread_meta_log
        WHERE whatsapp_number_id = $1 AND identifier = $2 AND field = 'is_lead'
          AND ${humanActorSql('actor')}
     ) AS is_lead`,
    [p.numberId, p.identifier],
  );
  const isLead = leadRes.rows[0]?.is_lead === true;

  if (p.opportunityId == null) {
    return { isLead, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] };
  }

  // Agregado das travas da opp: um bool_or por dimensão + a lista de tags removidas
  // por humano. WHERE já reduz aos eventos humanos das dimensões relevantes, então
  // um conjunto vazio devolve NULLs (coalesced a false/[]).
  const oppRes = await client.query<{
    is_qualified: boolean | null;
    status: boolean | null;
    loss_reason: boolean | null;
    tags_removed: string[] | null;
  }>(
    `SELECT
       COALESCE(bool_or(field = 'qualification'), FALSE) AS is_qualified,
       COALESCE(bool_or(field = 'status'), FALSE)        AS status,
       COALESCE(bool_or(field = 'loss_reason'), FALSE)   AS loss_reason,
       COALESCE(
         array_agg(DISTINCT new_value) FILTER (WHERE field = 'tag_removed' AND new_value IS NOT NULL),
         ARRAY[]::text[]
       ) AS tags_removed
     FROM whatsapp_opportunity_events
     WHERE opportunity_id = $1
       AND ${humanActorSql('changed_by')}
       AND field IN ('qualification', 'status', 'loss_reason', 'tag_removed')`,
    [p.opportunityId],
  );
  const row = oppRes.rows[0];

  return {
    isLead,
    isQualified: row?.is_qualified === true,
    status: row?.status === true,
    lossReason: row?.loss_reason === true,
    tagsRemovedByHuman: row?.tags_removed ?? [],
  };
}
