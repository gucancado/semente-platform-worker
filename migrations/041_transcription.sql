-- 041: transcrição de áudio do WhatsApp — metadados de mídia em messages + fila de jobs.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_key TEXT,
  ADD COLUMN IF NOT EXISTS media_mime TEXT,
  ADD COLUMN IF NOT EXISTS media_duration_s INT,
  ADD COLUMN IF NOT EXISTS transcription_status TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_kind_chk') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_kind_chk CHECK (kind IN ('text','audio'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_transcription_status_chk') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_transcription_status_chk
      CHECK (transcription_status IS NULL OR transcription_status IN ('pending','done','failed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS transcription_jobs (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  whatsapp_number_id BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  workspace_id TEXT,
  instance TEXT NOT NULL,
  evolution_event_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  is_group BOOLEAN NOT NULL DEFAULT FALSE,
  identifier TEXT NOT NULL,
  inbox_id BIGINT,
  raw_envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transcription_jobs_evt
  ON transcription_jobs (whatsapp_number_id, evolution_event_id);
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_due
  ON transcription_jobs (scheduled_at) WHERE status = 'pending';
