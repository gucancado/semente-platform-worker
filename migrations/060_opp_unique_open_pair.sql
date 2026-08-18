-- 060: o invariante "no máximo UMA oportunidade aberta por conversa" passa a ser
-- imposto pelo BANCO, não só pelo código.
--
-- Até aqui o invariante existia em dois pontos do TypeScript (o re-check dentro do
-- lock no poller de criação e o `countOpenOpportunities` do closed_action da IA) e
-- em NENHUM lugar no schema: `idx_opp_open_pair` era um índice comum, criado pela
-- 051 só para acelerar essas consultas. A rota manual `POST /opportunities` (e por
-- tabela o MCP, que fala com ela) chamava `createOpportunityV3` sem checagem
-- alguma — um segundo card aberto na mesma conversa era aceito sem erro.
--
-- Auditoria antes de aplicar: zero pares com 2+ abertas em produção (todos os
-- workspaces), então a promoção do índice a UNIQUE não precisa de saneamento
-- prévio e não pode falhar por dado existente. Se um dia falhar, a query que
-- localiza o conflito é:
--   SELECT whatsapp_number_id, identifier, count(*) FROM whatsapp_opportunities
--    WHERE status='em_andamento' GROUP BY 1,2 HAVING count(*) > 1;
--
-- O índice parcial serve aos DOIS papéis (unicidade + o lookup do par aberto que a
-- 051 queria), por isso o antigo é substituído em vez de ganhar um irmão.
DROP INDEX IF EXISTS idx_opp_open_pair;
CREATE UNIQUE INDEX IF NOT EXISTS idx_opp_open_pair ON whatsapp_opportunities
  (whatsapp_number_id, identifier) WHERE status = 'em_andamento';
