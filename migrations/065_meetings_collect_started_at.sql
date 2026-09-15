-- migrations/065_meetings_collect_started_at.sql
-- 065: instante em que a coleta ganhou vaga e o bot foi enviado. O timeout de
-- admissão media desde created_at (= instante do PEDIDO), então uma coleta que
-- esperou vaga na fila (mig 048) era promovida e morria como silent_room no mesmo
-- tick do poller, antes de o bot entrar. Nulo nas rows anteriores: o poller cai
-- em created_at, que era a âncora correta quando a coleta nascia 'collecting'.
ALTER TABLE collected_meetings ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
