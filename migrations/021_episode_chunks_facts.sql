-- Camada episódica: chunks vetorizados de episódios.
CREATE TABLE episode_chunks (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'chunk_v1',
  episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  episode_revision INT NOT NULL,         -- proveniência: qual texto foi vetorizado
  workspace_id TEXT NOT NULL,            -- denormalizado p/ busca; trigger §4.6 mantém em sincronia
  chunk_index INT NOT NULL,              -- 0-based, ordem no episódio
  turn_start INT NOT NULL,               -- turn_index inicial (inclusivo)
  turn_end INT NOT NULL,                 -- turn_index final (inclusivo)
  char_start INT,                        -- não-nulos só em split intra-turno (monólogo > chunk)
  char_end INT,
  text TEXT NOT NULL,                    -- texto do chunk com prefixo "Falante:" por turno
  token_count INT NOT NULL,
  embedding vector(1024) NOT NULL,
  embedding_model TEXT NOT NULL,         -- 'text-embedding-3-large@1024' (obrigatório, decisão v1.4)
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', text)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (episode_id, chunk_index)
);
CREATE INDEX idx_chunks_workspace ON episode_chunks (workspace_id, episode_id);
CREATE INDEX idx_chunks_embedding ON episode_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_chunks_tsv ON episode_chunks USING gin (tsv);

-- Camada semântica: fatos tipados bi-temporais (fato_v1).
CREATE TABLE facts (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'fato_v1',
  workspace_id TEXT NOT NULL,            -- fato SEM workspace não existe (§5.2)
  fact_type TEXT NOT NULL,
  statement TEXT NOT NULL,               -- afirmação autocontida em PT-BR, presente do indicativo
  attributes JSONB NOT NULL DEFAULT '{}',
    -- estrutura por tipo (zod no código): compromisso { owner, due_date } ·
    -- decisao { decided_by, parameter?, value? } · papel { person_name, person_email?, role,
    -- responsibilities[] } · marco { event_kind: 'recorde'|'interrupcao'|'reclamacao'|'outro' } ·
    -- objetivo { metric?, target? } · ameaca/oportunidade { horizon? }
  confidence REAL NOT NULL,

  -- bi-temporal (decisão v1.4): "ainda vale?" = invalid_at IS NULL
  valid_at TIMESTAMPTZ NOT NULL,         -- quando o fato passou a valer no MUNDO
  invalid_at TIMESTAMPTZ,                -- quando deixou de valer (nunca DELETE)
  superseded_by_fact_id BIGINT REFERENCES facts(id) ON DELETE SET NULL,
  invalidation_reason TEXT,
    -- 'superseded' | 'revision_reprocessed' | 'manual' | 'retracted'

  -- proveniência (03 §3): fato → episódio + janela de turnos
  episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  episode_revision INT NOT NULL,
  turn_start INT NOT NULL,
  turn_end INT NOT NULL,

  -- curadoria
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  review_note TEXT,

  -- busca
  embedding vector(1024) NOT NULL,
  embedding_model TEXT NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', statement)) STORED,

  extracted_by TEXT NOT NULL,            -- model id da extração (ex: 'claude-sonnet-4-6')
  run_id BIGINT REFERENCES lua_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- tempo de transação (quando SOUBEMOS)

  CONSTRAINT facts_type_chk CHECK (fact_type IN
    ('decisao', 'preferencia', 'restricao', 'compromisso', 'contexto',
     'objetivo', 'ameaca', 'oportunidade', 'marco', 'papel')),
  CONSTRAINT facts_confidence_chk CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT facts_invalidation_chk
    CHECK ((invalid_at IS NULL) = (invalidation_reason IS NULL)),
  CONSTRAINT facts_supersede_chk
    CHECK (superseded_by_fact_id IS NULL OR invalid_at IS NOT NULL)
);
CREATE INDEX idx_facts_workspace_active ON facts (workspace_id, fact_type)
  WHERE invalid_at IS NULL;
CREATE INDEX idx_facts_workspace_time ON facts (workspace_id, valid_at DESC);
CREATE INDEX idx_facts_episode ON facts (episode_id);
CREATE INDEX idx_facts_review ON facts (workspace_id, created_at DESC) WHERE needs_review;
CREATE INDEX idx_facts_embedding ON facts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_facts_tsv ON facts USING gin (tsv);
