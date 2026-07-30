-- migrations/053_crm_v3_contract.sql
-- CRM WhatsApp v3 — Fase D: CONTRACT (spec
-- beeads-central-de-dados/docs/superpowers/specs/2026-07-29-crm-whatsapp-v3-kanban-ia-design.md §3.1-3.2, §12.1).
--
-- ⚠️ DEPLOY SEPARADO OBRIGATÓRIO — só rodar com o worker single-write (contract
-- fase 1, commit "contract fase 1: codigo single-write, coluna viva") já estável
-- em prod E o container antigo (dual-write, pré-fase-1) removido. Publicar esta
-- migration no MESMO deploy do código novo dropa a coluna enquanto o worker
-- VELHO (dual-write) ainda pode estar servindo tráfego na janela do healthcheck
-- do Coolify — a migration roda no boot ANTES do healthcheck, sem esperar o
-- container antigo morrer, e o worker velho escrevendo `qualification`
-- explicitamente causaria 500 em toda escrita de opp até o rollout completar.
--
-- Fecha a janela expand/contract aberta na 051: derruba o trigger de sincronia
-- dual-write, o CHECK legado que referencia a coluna, e a própria coluna
-- `qualification` de whatsapp_opportunities. `is_qualified` é a única fonte da
-- verdade a partir daqui — a string `qualification` segue existindo só como
-- campo DERIVADO nas respostas da API (qualificationLabel(is_qualified) em
-- opportunities.ts/read-queries.ts), nunca mais como coluna nem como aceitação
-- de input nas rotas.

-- lock_timeout curto: mesmo racional da 051 (falha rápido se a tabela estiver
-- sob lock no boot; o runner re-tenta no próximo deploy). Primeiro statement,
-- sem BEGIN/COMMIT próprio — o runner (src/migrate.ts) já envolve o arquivo
-- inteiro numa transação.
SET LOCAL lock_timeout = '10s';

-- Nome real conferido em migrations/051_crm_v3_expand.sql (linha 89):
-- `crm_v3_sync_qualification_trg`, não `..._trigger`.
DROP TRIGGER IF EXISTS crm_v3_sync_qualification_trg ON whatsapp_opportunities;
DROP FUNCTION IF EXISTS crm_v3_sync_qualification();

-- CHECK legado da 049 (`status <> 'ganho' OR qualification = 'qualificado'`) —
-- referencia a coluna que está saindo. O CHECK v3 equivalente
-- (opp_v3_ganho_qualificado, sobre is_qualified, da 051) permanece.
ALTER TABLE whatsapp_opportunities DROP CONSTRAINT IF EXISTS opp_ganho_qualificado;

ALTER TABLE whatsapp_opportunities DROP COLUMN IF EXISTS qualification;
