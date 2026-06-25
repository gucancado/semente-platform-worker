-- migrations/036_whatsapp_disqualify_reasons_patient.sql
-- Adiciona razões de desqualificação para PACIENTE REAL (lead qualificável que não
-- pode ser atendido), distintas das 9 categorias de "não-é-paciente" da migration 033.
-- Necessário porque a triagem Luhma produziu desqualificações por motivo
-- clínico/operacional (fora da área geográfica, serviço/especialidade não ofertada)
-- que não tinham code correspondente — o whatsapp_set_lead_status[_bulk] rejeitava o
-- disqualifyReason por não existir na tabela de referência.
--
-- Idempotente: ON CONFLICT DO NOTHING torna re-execução segura.

INSERT INTO whatsapp_disqualify_reasons (code, label) VALUES
  ('fora_area_cobertura',    'Fora da área de cobertura'),
  ('servico_nao_oferecido',  'Serviço/especialidade não oferecido')
ON CONFLICT (code) DO NOTHING;
