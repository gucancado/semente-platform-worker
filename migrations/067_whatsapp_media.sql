-- 067: mídia do WhatsApp além de áudio (imagem, vídeo, documento, figurinha).
--
-- Até aqui o CHECK de kind da 041 só aceitava text/audio. Foto SEM legenda nem
-- chegava a `messages` (não havia texto pra gravar e `text` é NOT NULL) e foto COM
-- legenda virava texto puro, perdendo o arquivo em silêncio.
--
-- Tudo aqui é inerte até WHATSAPP_MEDIA_MODE=on: o ingest só grava estes kinds e
-- só enfileira download com o modo ligado.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS media_filename TEXT,
  ADD COLUMN IF NOT EXISTS media_status TEXT;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_chk;
ALTER TABLE messages ADD CONSTRAINT messages_kind_chk
  CHECK (kind IN ('text','audio','image','video','document','sticker'));

-- NULL = linha anterior a esta migration ou mensagem sem arquivo (texto, áudio legado).
--   pending        download enfileirado
--   stored         arquivo no R2 (media_key preenchida)
--   skipped_size   acima do teto por arquivo — mensagem existe, arquivo não
--   skipped_policy tipo que não é baixado (figurinha, ou tipo fora de WHATSAPP_MEDIA_KINDS)
--   failed         tentativas esgotadas
--   expired        arquivo apagado pela expiração por idade (media_key volta a NULL)
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_status_chk;
ALTER TABLE messages ADD CONSTRAINT messages_media_status_chk
  CHECK (media_status IS NULL OR media_status IN
    ('pending','stored','skipped_size','skipped_policy','failed','expired'));

-- Fila de download. Molde de transcription_jobs, sem o que é específico de áudio.
-- raw_envelope guarda o `data` do webhook: é o que getBase64FromMediaMessage exige
-- (a mídia não vem no payload — o webhook usa base64:false). Zerado ao concluir.
CREATE TABLE IF NOT EXISTS whatsapp_media_jobs (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  whatsapp_number_id BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  workspace_id TEXT,
  instance TEXT NOT NULL,
  evolution_event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  raw_envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_media_jobs_status_chk CHECK (status IN ('pending','done','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_media_jobs_evt
  ON whatsapp_media_jobs (whatsapp_number_id, evolution_event_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_media_jobs_due
  ON whatsapp_media_jobs (scheduled_at) WHERE status = 'pending';

-- Varredura da expiração por idade (construída, desligada por env). Parcial: só
-- linhas que ainda têm arquivo — áudio incluído, já que ele mora no mesmo bucket.
CREATE INDEX IF NOT EXISTS idx_messages_media_expiry
  ON messages (created_at) WHERE media_key IS NOT NULL;
