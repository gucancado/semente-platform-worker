-- migrations/068_connection_probes.sql
-- Sonda de conexão: o número Cloud manda uma mensagem de teste a uma instância
-- Evolution suspeita e o worker verifica se ela chegou. `state:'open'` e
-- `status='connected'` mentem quando a sessão morre por dentro (12/09, número 18).

CREATE TABLE IF NOT EXISTS connection_probes (
  id               BIGSERIAL PRIMARY KEY,
  instance         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('number','system')),
  number_id        INTEGER NULL REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  phone            TEXT NOT NULL,
  label            TEXT NULL,
  code             TEXT NOT NULL,
  -- 2ª sonda (repetição) aponta para a 1ª.
  parent_id        BIGINT NULL REFERENCES connection_probes(id),
  trigger          TEXT NOT NULL CHECK (trigger IN ('store_stale','quiet')),
  wamid            TEXT UNIQUE,
  mirror_wamid     TEXT NULL,
  sent_at          TIMESTAMPTZ NULL,
  send_error       JSONB NULL,
  cloud_status     TEXT NULL CHECK (cloud_status IN ('sent','delivered','read','failed')),
  cloud_status_at  TIMESTAMPTZ NULL,
  cloud_error      JSONB NULL,
  received_at      TIMESTAMPTZ NULL,
  -- key da mensagem na instância (id/remoteJid/fromMe) — para ler e arquivar.
  msg_key          JSONB NULL,
  store_seen       BOOLEAN NULL,
  verdict          TEXT NULL CHECK (verdict IN
                     ('alive','repeated','pipeline_broken','down','send_failed','inconclusive','identity_mismatch')),
  verdict_at       TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uma sonda ABERTA por instância: segunda barreira contra dois containers
-- (rolling deploy) sondando a mesma instância no mesmo tick.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_probes_open
  ON connection_probes (instance) WHERE verdict IS NULL;
CREATE INDEX IF NOT EXISTS idx_connection_probes_code
  ON connection_probes (instance, code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_probes_instance
  ON connection_probes (instance, created_at DESC);

-- Fonte do episódio aberto da instância de sistema. 'probe' = só a sonda fecha
-- (ou tráfego real / estado); sem isto o próprio vigia fecharia no tick seguinte.
ALTER TABLE system_instance_health
  ADD COLUMN IF NOT EXISTS down_source TEXT NULL CHECK (down_source IN ('state','probe'));

-- O CHECK de 066 é inline e sem nome: o Postgres o chamou de
-- instance_outages_started_at_source_check. Recriado com a lista COMPLETA.
ALTER TABLE instance_outages DROP CONSTRAINT IF EXISTS instance_outages_started_at_source_check;
ALTER TABLE instance_outages ADD CONSTRAINT instance_outages_started_at_source_check
  CHECK (started_at_source IN ('webhook','observed_store','detected_now','probe'));
