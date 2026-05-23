-- Backfill da coluna `project` para mensagens inbound históricas.
--
-- Estratégia: cruza messages.evolution_event_id com webhook_logs.evolution_event_id
-- e extrai o sufixo do webhook_logs.instance (após o primeiro hífen).
--
-- Outbound antigos sem evolution_event_id ficam NULL — aceito conforme spec
-- (afeta apenas histórico; novos outbounds preenchidos quando agentes
-- adotarem o campo via Sub-tarefa A2).
--
-- Idempotente: o WHERE m.project IS NULL garante que rerodar não sobrescreve
-- valores já preenchidos. Migration_runner aplica em transação.

UPDATE messages m
SET project = SUBSTRING(wl.instance FROM POSITION('-' IN wl.instance) + 1)
FROM webhook_logs wl
WHERE m.evolution_event_id = wl.evolution_event_id
  AND m.agent = wl.agent
  AND m.project IS NULL
  AND m.direction = 'inbound'
  AND wl.instance IS NOT NULL
  AND POSITION('-' IN wl.instance) > 0;
