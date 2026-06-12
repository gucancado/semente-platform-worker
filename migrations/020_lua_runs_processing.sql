-- Lua v1: ledger de batches e de processamento por episódio.
-- lua_processing espelha o padrão webhook_receipts (017): retry + lease + dead-letter.
CREATE TABLE lua_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'nightly',  -- 'nightly' | 'bootstrap' | 'manual'
  run_date DATE NOT NULL,                -- data local (America/Sao_Paulo) da noite
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  stats JSONB NOT NULL DEFAULT '{}',
    -- { episodes_processed, episodes_failed, chunks, facts_new, facts_superseded,
    --   facts_flagged, condutas_proposed, recaps, tokens_in, tokens_out,
    --   embedding_tokens, cost_usd }
  error TEXT,
  CONSTRAINT lua_runs_status_chk CHECK (status IN ('running', 'done', 'failed')),
  CONSTRAINT lua_runs_kind_chk CHECK (kind IN ('nightly', 'bootstrap', 'manual'))
);
-- 1 run noturno por noite (bootstrap/manual não disputam a chave)
CREATE UNIQUE INDEX idx_lua_runs_one_nightly ON lua_runs (run_date) WHERE kind = 'nightly';

CREATE TABLE lua_processing (
  id BIGSERIAL PRIMARY KEY,
  episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  episode_revision INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' → 'chunked' → 'done' | 'failed' (retry) | 'dead' | 'skipped'
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,                -- lease; claim vencido (>15min) é retomável
  claimed_by TEXT,
  last_error TEXT,
  stats JSONB NOT NULL DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lua_processing_status_chk
    CHECK (status IN ('pending', 'chunked', 'done', 'failed', 'dead', 'skipped')),
  UNIQUE (episode_id, episode_revision)
);
CREATE INDEX idx_lua_processing_due ON lua_processing (next_attempt_at)
  WHERE status IN ('pending', 'chunked', 'failed');
