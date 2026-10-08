-- 071: resiliência das reuniões a falha de transcrição ao vivo (STT).
--
-- Por quê: entre 29/09 e 02/10/2026 a conta OpenAI ficou sem crédito. A
-- transcrição ao vivo do Vexa falhou em 100% das coletas, toda reunião virou
-- `silent_room` (o timeout de 20 min sem segmento derrubava o bot com gente
-- falando) e 8 reuniões só foram recuperadas à mão a partir da gravação do bot.
-- Este schema sustenta três peças:
--
--   1. openai_health — UMA linha com o estado da conta (sonda periódica). Lido
--      pelo poller de coleta (não derrubar o bot com STT fora), pela recuperação
--      (não rodar com a conta fora) e pelo aviso ao operador (só na TRANSIÇÃO —
--      persistido para o deploy não reavisar).
--   2. meeting_speaker_activity — quem falou quando, enviado pelo próprio bot
--      (preload no launcher). É o que permite pôr NOME nos falantes de uma
--      reunião transcrita depois, pela gravação mixada (que não tem nomes).
--   3. meeting_recovery_jobs — fila da transcrição pela gravação.

CREATE TABLE IF NOT EXISTS openai_health (
  id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state         TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'ok', 'down')),
  since         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Último instante em que a conta foi vista FORA. Fica depois de voltar: a
  -- coleta compara com o início da reunião para saber se a transcrição ao vivo
  -- dela foi afetada.
  last_down_at  TIMESTAMPTZ,
  checked_at    TIMESTAMPTZ,
  last_error    TEXT
);
INSERT INTO openai_health (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS meeting_speaker_activity (
  id               BIGSERIAL PRIMARY KEY,
  vexa_meeting_id  INTEGER NOT NULL,
  speaker          TEXT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS idx_meeting_speaker_activity_meeting
  ON meeting_speaker_activity (vexa_meeting_id, started_at);

CREATE TABLE IF NOT EXISTS meeting_recovery_jobs (
  collected_meeting_id  UUID PRIMARY KEY REFERENCES collected_meetings(id) ON DELETE CASCADE,
  -- 'silent_room': coleta falhou sem fala transcrita; 'partial': importou, mas a
  -- conta caiu durante a reunião (transcrição incompleta) — substitui o episódio.
  reason         TEXT NOT NULL CHECK (reason IN ('silent_room', 'partial')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'done', 'no_speech', 'failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at     TIMESTAMPTZ,
  last_error     TEXT,
  episode_id     BIGINT,
  speech_seconds NUMERIC,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_recovery_due
  ON meeting_recovery_jobs (scheduled_at) WHERE status = 'pending';
