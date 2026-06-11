-- Repositório de transcrições (spec ecossistema/docs/specs/2026-06-10).
-- Episódio = cabeçalho + turnos. fonte='reuniao' agora; 'whatsapp' futuro.
CREATE TABLE episodes (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'episodio_v1',
  fonte TEXT NOT NULL,
  external_source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  duration_seconds INT,
  language TEXT NOT NULL DEFAULT 'pt-BR',
  workspace_id TEXT,
  project_slug TEXT,
  attribution_method TEXT NOT NULL DEFAULT 'none',
  participants JSONB NOT NULL DEFAULT '[]',
  metadata JSONB NOT NULL DEFAULT '{}',
  raw_r2_key TEXT,
  audio_r2_key TEXT,
  turn_count INT NOT NULL DEFAULT 0,
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT episodes_fonte_chk CHECK (fonte IN ('reuniao', 'whatsapp')),
  CONSTRAINT episodes_attr_method_chk CHECK (attribution_method IN ('domain','calendar','manual','internal','group_tag','contact_route','none')),
  UNIQUE (external_source, external_id)
);
CREATE INDEX idx_episodes_workspace_time ON episodes (workspace_id, occurred_at DESC);
CREATE INDEX idx_episodes_orphans ON episodes (occurred_at DESC) WHERE workspace_id IS NULL;
CREATE INDEX idx_episodes_fonte ON episodes (fonte, occurred_at DESC);
CREATE INDEX idx_episodes_cursor ON episodes (occurred_at DESC, id DESC);

CREATE TABLE episode_turns (
  id BIGSERIAL PRIMARY KEY,
  episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  turn_index INT NOT NULL,
  speaker_name TEXT,
  speaker_label TEXT,
  speaker_email TEXT,
  started_at_ms INT,
  ended_at_ms INT,
  text TEXT NOT NULL,
  UNIQUE (episode_id, turn_index)
);
CREATE INDEX idx_episode_turns_episode ON episode_turns (episode_id, turn_index);
