/**
 * src/whatsapp/sql-scope.ts
 *
 * Fragmentos SQL de escopo por workspace, compartilhados pelas queries de
 * agregação de WhatsApp (stats, timeseries, first-response). Casa neutra pra o
 * PRÓXIMO módulo de agregação herdar o padrão de escopo por CONSTRUÇÃO.
 *
 * Contexto: o vazamento cross-workspace que atingiu 3 módulos na Fase 2 nasceu
 * de cada módulo reescrever os LATERAL joins de whatsapp_groups/whatsapp_thread_meta
 * SEM o filtro de workspace — dois números de workspaces diferentes que
 * compartilham o mesmo identifier (JID) casavam o metadado um do outro. O
 * `stats.ts` já tinha o padrão certo (no byTag), mas ninguém o aplicou aos
 * outros laterais. Manter o fragmento canônico AQUI, e não colar de novo em cada
 * módulo, remove a chance de o próximo esquecer o filtro.
 */

/**
 * Subconjunto de números do workspace atual.
 *
 * ⚠️ CONTRATO POSICIONAL: assume `$1 = workspaceId` no array de params da query
 * consumidora (todas as queries de agregação de WhatsApp seguem essa convenção).
 * Todo LATERAL join de `whatsapp_groups`/`whatsapp_thread_meta` deve filtrar por
 * `whatsapp_number_id IN ${WORKSPACE_NUMBERS}` — senão, com `number_id` ausente
 * (agregado do workspace inteiro), casaria metadado de QUALQUER workspace que
 * compartilhe o mesmo identifier.
 */
export const WORKSPACE_NUMBERS = `(SELECT id FROM whatsapp_numbers WHERE workspace_id = $1)`;

// NOTA (follow-up): o predicado de `kind` (dm/group/all) também está repetido à
// mão em stats.ts, timeseries.ts e first-response.ts, mas NÃO consolida como uma
// constante única: o índice do param varia ($5 em first-response, $6 em
// stats/timeseries) e o alias da coluna has_author também (a/tk). Consolidá-lo
// exigiria um helper gerador `kindPredicate(param, alias)` + migrar os 5 call
// sites de SQL de produção, com validação pelos testes DB-gated. Fica pro dia em
// que houver um 4º consumidor — aí o custo se paga. Diferente do escopo de
// workspace acima, o predicado de kind nunca foi fonte de bug.
