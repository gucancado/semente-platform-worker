-- migrations/059_whatsapp_group_participants_lid.sql
-- LID (Linked ID) de privacidade do WhatsApp do participante, guardado à parte
-- do telefone. `whatsapp_group_participants.phone` já podia SER um LID quando
-- a Evolution não trazia o `*Alt`/`phoneNumber` (ver `is_lid` na mig 058) —
-- mas quando o telefone real É conhecido (`phone` populado, `is_lid=false`),
-- o LID daquela pessoa se perdia: `parseParticipants` descartava o `id` cru
-- assim que resolvia o telefone via `phoneNumber`/`jidAlt`.
--
-- As menções `@<numero>` no TEXTO das mensagens usam o LID (não o telefone) —
-- é o identificador de privacidade que o WhatsApp embute no corpo da mensagem
-- quando o participante mencionado tem LID ativo. Sem esta coluna não dá pra
-- resolver `@<lid>` → nome nem alinhar a cor da menção com a do autor: o único
-- payload que traz o par (LID, telefone) junto é o roster de participantes
-- (`GET /group/participants/{instance}`), então o mapeamento só pode ser
-- persistido no momento do sync, não recalculado depois a partir da mensagem.
--
-- Guardamos só os dígitos (sem o sufixo '@lid'), mesmo padrão de `phone`
-- (que guarda sem '@s.whatsapp.net'/'@g.us').

ALTER TABLE whatsapp_group_participants ADD COLUMN IF NOT EXISTS lid TEXT;
