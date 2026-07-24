-- migrations/050_drop_thread_meta_stage_coherente.sql
-- O CHECK thread_meta_stage_coherente (033) acoplava is_lead ao lead_stage.
-- Com o funil movido pra whatsapp_opportunities (049) e lead_stage congelado
-- como legado, a regra ficou obsoleta E perigosa: re-triagem status='lead'
-- numa row legada com lead_stage='desqualificado' violaria o CHECK (23514 →
-- 500), já que o novo write path nunca mais toca lead_stage. A coerência do
-- funil novo é garantida por opp_ganho_qualificado + camada de aplicação.
ALTER TABLE whatsapp_thread_meta
  DROP CONSTRAINT IF EXISTS thread_meta_stage_coherente;
