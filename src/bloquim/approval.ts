// Wrapper de portao da Lua sobre o cliente Bloquim (spec Lua v1 §9.4).
//
// `createApprovalTask` e a dependencia injetada em `proposeConduta` (condutas.ts):
// cria a tarefa de aprovacao (portao 03 §4) no workspace correspondente. Em
// producao deveria chamar `src/bloquim/client.ts::createTask`.
//
// STUB CONSCIENTE: `createTask` exige `agent` + `bloquim_token`, e nao ha token
// dedicado da "lua" nem o contrato real da API Bloquim fechado (pendencia §14 #2/
// fechamento do stub). Ate la, este wrapper retorna `null` — `proposeConduta`
// trata isso como "portao indisponivel": a conduta fica `proposed` SEM
// approval_task_id, recuperavel quando o portao real existir. NUNCA derruba a
// noite. Quando o stub do client.ts fechar, plugar `createTask` aqui (com o token
// resolvido por workspace/agente) e remover o retorno nulo.

import type { CreateApprovalTask } from '../lua/condutas.js';

export const createApprovalTask: CreateApprovalTask = async (_args) => {
  // Portao real ainda nao fiado (stub do client.ts / token da lua pendente).
  // Retornar null mantem a proposta recuperavel sem inventar credencial.
  return null;
};
