-- 069: diagnóstico das coletas Vexa + digest estruturado (decisões/ações/pendências).
--
-- Por quê: em 75 dias, 89 coletas falharam (silent_room 39, vexa_failed 36) e o
-- worker não guardava nem o status que o Vexa reportava nem o texto do erro — a
-- causa era indeterminável. As colunas abaixo gravam o que o poller VIU:
--   - vexa_status / vexa_status_at: último status do Vexa e quando foi lido
--     (distingue bot preso na sala de espera × sala ativa muda);
--   - status_log: trilha das MUDANÇAS de status ({at, status, segments}), com
--     teto (~50) aplicado pelo worker, não aqui;
--   - failure_detail: mensagem do erro (vexa_send_failed), status + motivo do
--     Vexa (vexa_failed) ou último status + tempo esperado (silent_room).
ALTER TABLE collected_meetings
  ADD COLUMN IF NOT EXISTS vexa_status TEXT,
  ADD COLUMN IF NOT EXISTS vexa_status_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_detail TEXT,
  ADD COLUMN IF NOT EXISTS status_log JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Digest estruturado: mesma chamada de LLM do 063, chaves novas no mesmo JSON.
-- NULL = digest antigo (anterior a esta migration) ou o modelo não trouxe a chave;
-- '[]' = o modelo disse que não há. A diferença chega ao consumidor (MCP).
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS summary_decisions JSONB,
  ADD COLUMN IF NOT EXISTS summary_actions JSONB,
  ADD COLUMN IF NOT EXISTS summary_open_questions JSONB;

-- Reprocessa os digests dos últimos 120 dias para preencher as colunas novas.
-- Mesmo molde de enqueuePendingEpisodes(redo): um job por episódio (UNIQUE em
-- episode_id), revisão atual do episódio. Duas guardas no ON CONFLICT:
--   - só reativa job TERMINAL (done/failed). 'pending' já vai rodar com o código
--     novo (reativar só zeraria attempts); 'processing' pode ser do container
--     antigo no meio do rolling deploy — reativar faria o finish dele (mesma
--     revisão) marcar 'done' por cima e o reprocessamento sumiria em silêncio,
--     e ainda abriria duas execuções na mesma row;
--   - o WHERE do SELECT pula episódio que já tem qualquer campo novo (rerun manual
--     deste SQL não recobra digest já estruturado).
-- scheduled_at adiado 10 min: a migration roda no boot do container NOVO com o
-- antigo ainda servindo; se o poller antigo claimasse estes jobs, gravaria o
-- digest sem as chaves novas e marcaria 'done' — reprocessamento perdido.
-- Custo: ~13k tokens de entrada por reunião no gpt-5.4-mini ≈ US$ 0,01 cada.
INSERT INTO meeting_summary_jobs (episode_id, episode_revision, scheduled_at)
SELECT e.id, e.revision, NOW() + INTERVAL '10 minutes'
  FROM episodes e
 WHERE e.fonte = 'reuniao'
   AND e.turn_count > 0
   AND e.occurred_at >= NOW() - INTERVAL '120 days'
   AND e.summary_decisions IS NULL
   AND e.summary_actions IS NULL
   AND e.summary_open_questions IS NULL
ON CONFLICT (episode_id) DO UPDATE
   SET episode_revision = EXCLUDED.episode_revision,
       status = 'pending', attempts = 0, scheduled_at = EXCLUDED.scheduled_at,
       claimed_at = NULL, last_error = NULL, updated_at = NOW()
 WHERE meeting_summary_jobs.status IN ('done', 'failed');
