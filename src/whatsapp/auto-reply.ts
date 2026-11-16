/**
 * src/whatsapp/auto-reply.ts
 *
 * Resposta nossa que chega em menos de AUTO_REPLY_SECONDS depois de uma
 * mensagem do cliente é AUTOMÁTICA (saudação do WhatsApp Business, robô) e não
 * conta como resposta — nem no tempo de resposta (response-time.ts) nem no
 * "quem está esperando" do kanban (board.ts). As duas consultas usam esta
 * constante pra não divergirem.
 *
 * Medido em 2026-11-16 nos 11 números com volume: os que têm automação mostram
 * um pico de respostas abaixo de 2 s (até 31% de todas as respostas), ausente
 * nos que não têm; entre 5 e 60 s a distribuição já é a de gente digitando.
 * Não depende de saber quem usa robô.
 *
 * Módulo puro (sem imports) — board.ts promete rodar teste sem DATABASE_URL.
 */
export const AUTO_REPLY_SECONDS = 5;

/**
 * Predicado SQL: a mensagem `alias` é uma resposta automática (outbound com
 * mensagem do cliente na mesma conversa nos AUTO_REPLY_SECONDS anteriores).
 */
export function autoReplySql(alias: string): string {
  return `(${alias}.direction = 'outbound' AND EXISTS (
    SELECT 1 FROM messages ai
     WHERE ai.whatsapp_number_id = ${alias}.whatsapp_number_id AND ai.identifier = ${alias}.identifier
       AND ai.direction = 'inbound'
       AND ai.created_at <= ${alias}.created_at
       AND ai.created_at > ${alias}.created_at - interval '${AUTO_REPLY_SECONDS} seconds'))`;
}
