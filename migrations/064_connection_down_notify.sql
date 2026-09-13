-- Aviso de queda enviado ao PRÓPRIO número (via Cloud API do saturno).
--
-- alerted_at continua sendo do alerta de PAINEL (outbox, um por episódio).
-- O aviso ao número tem cadência própria (re-aviso até um teto), por isso ganha
-- colunas próprias em vez de reusar alerted_at. down_notify_count é também a
-- VERSÃO do claim otimista — comparar down_notified_at quebraria: NOW() grava
-- microssegundo e o Date do JS lê milissegundo.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS down_notified_at  TIMESTAMPTZ;
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS down_notify_count INTEGER NOT NULL DEFAULT 0;

-- Instância de SISTEMA (ex.: saturno) não existe em whatsapp_numbers por contrato:
-- registrá-la ali migraria a ingestão dos grupos e colidiria em
-- uq_whatsapp_groups_linked_jid. O vigia dela guarda o estado aqui.
CREATE TABLE IF NOT EXISTS system_instance_health (
  instance           TEXT PRIMARY KEY,
  expected_phone     TEXT NOT NULL,
  label              TEXT,
  last_state         TEXT,
  last_reason        TEXT,
  own_store_ts       TIMESTAMPTZ,
  peer_store_ts      TIMESTAMPTZ,
  checked_at         TIMESTAMPTZ,
  -- NULL = saudável. Preenchido na transição saudável→fora; preservado enquanto
  -- o episódio dura; zerado (junto com o aviso) na volta.
  down_since         TIMESTAMPTZ,
  down_notified_at   TIMESTAMPTZ,
  down_notify_count  INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
