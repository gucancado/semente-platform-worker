-- 063: digest de reunião gerado por IA (resumo curto + pontos discutidos).
--
-- O resumo alimenta o card da lista de reuniões do painel; os pontos aparecem
-- acima da transcrição. Uma única chamada de LLM produz os dois (a transcrição
-- é ~13k tokens de ENTRADA e o texto gerado ~250 de saída — duas chamadas
-- dobrariam o custo dominante e fariam card e lista discordarem entre si).

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS summary_points JSONB,
  ADD COLUMN IF NOT EXISTS summary_model TEXT,
  ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ;

-- Fila de geração. Existe (em vez de um scan de `episodes WHERE summary IS NULL`)
-- porque retry com backoff, dead-lettering e claim concorrente já estão resolvidos
-- no molde de `transcription_jobs` (migration 041).
CREATE TABLE IF NOT EXISTS meeting_summary_jobs (
  id BIGSERIAL PRIMARY KEY,
  episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,

  -- Revisão do episódio que ESTE job deve resumir.
  --
  -- Sem ela existe um clobber real: `insertEpisodeWithTurns(force)` substitui os
  -- turnos e bumpa `episodes.revision`, e reativa a MESMA row de job (o UNIQUE
  -- abaixo). Se o poller já estava processando a revisão anterior, ele termina
  -- depois, grava o digest VELHO por cima e marca a row `done` — a revisão nova
  -- fica com resumo errado e sem job pendente, em silêncio. Com a coluna, a
  -- escrita final casa a revisão claimada e a execução obsoleta é descartada.
  episode_revision INT NOT NULL DEFAULT 0,

  -- pending | processing | done | failed. Sem CHECK, igual a transcription_jobs.
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Início do LEASE. `transcription_jobs` devolve o job a 'pending' com
  -- scheduled_at+5min, o que é lease só implícito: uma chamada pendurada além
  -- disso é reivindicada de novo e as duas execuções competem pela mesma escrita.
  -- Aqui o claim marca 'processing' + claimed_at, e só volta a ser reivindicável
  -- quando o lease expira de fato.
  claimed_at TIMESTAMPTZ,

  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotência do enfileiramento: um job por episódio. Reimportação com `force`
-- faz ON CONFLICT DO UPDATE (reativa com a revisão nova) em vez de criar outro.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_summary_jobs_episode
  ON meeting_summary_jobs (episode_id);

-- Parcial de propósito: a tabela acumula rows 'done' que o claim nunca olha, e o
-- índice parcial fica pequeno o bastante para viver em cache. Mesma estratégia de
-- idx_transcription_jobs_due.
CREATE INDEX IF NOT EXISTS idx_meeting_summary_jobs_due
  ON meeting_summary_jobs (scheduled_at) WHERE status IN ('pending', 'processing');
