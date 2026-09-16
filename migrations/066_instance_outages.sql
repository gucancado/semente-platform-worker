-- migrations/066_instance_outages.sql
-- Episódios de indisponibilidade de uma instância de WhatsApp, APPEND-ONLY.
--
-- Por que a tabela existe: o estado de conexão hoje é sobrescrito e o fim do
-- episódio APAGA o começo — `updateNumberStatus` zera `disconnected_since` na
-- reconexão, e `recordSystemHealth` zera `down_since`. Instância de sistema
-- (saturno) nem enfileira evento no outbox. Resultado: em 18/08/2026 sete telas
-- de grupo congelaram por 16 dias e não há registro nenhum daquela janela.

CREATE TABLE IF NOT EXISTS instance_outages (
  id                BIGSERIAL PRIMARY KEY,
  instance          TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('number','system')),
  number_id         INTEGER NULL REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  -- 'webhook' = transição observada ao vivo. 'observed_store'/'detected_now' =
  -- vigia de sistema, que roda a cada 5min e ESTIMA o início pela última
  -- mensagem do store. A UI precisa poder dizer "desde aproximadamente".
  started_at_source TEXT NOT NULL CHECK (started_at_source IN ('webhook','observed_store','detected_now')),
  ended_at          TIMESTAMPTZ NULL,
  reason            TEXT NULL,
  detected_by       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instance_outages_window_chk CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- ⚠️ `kind='number'` NÃO exige `number_id` preenchido, e isso é deliberado.
  -- A ação `ON DELETE SET NULL` executa um UPDATE que o CHECK valida
  -- IMEDIATAMENTE (CHECK no Postgres nunca é deferrable). Com a forma estrita
  -- `(kind='number' AND number_id IS NOT NULL)`, apagar um número com histórico
  -- ABORTA a deleção inteira em vez de preservar a linha — medido no banco:
  --   ERROR: new row for relation "instance_outages" violates check constraint
  --   "instance_outages_kind_chk"
  --   CONTEXT: UPDATE ONLY "public"."instance_outages" SET "number_id" = NULL
  -- ou seja, o oposto do motivo pelo qual escolhemos SET NULL em vez de CASCADE.
  -- O CHECK segue garantindo o que importa: episódio de sistema nunca carrega
  -- number_id. Quem sustenta a leitura é `instance`, não `number_id`.
  CONSTRAINT instance_outages_kind_chk CHECK (
    kind = 'number' OR (kind = 'system' AND number_id IS NULL))
);

-- O índice é o coração da tabela: DOIS escritores independentes tocam o mesmo
-- episódio (o webhook de connection.update, a qualquer momento, e o vigia de
-- sistema, a cada 5min). Sem ele a mesma queda abriria dois episódios e a
-- conversa mostraria o buraco duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instance_outages_open
  ON instance_outages (instance) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_instance_outages_instance_started
  ON instance_outages (instance, started_at DESC);
