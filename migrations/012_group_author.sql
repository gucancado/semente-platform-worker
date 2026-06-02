-- Coluna `author`: em mensagens de GRUPO, quem de fato enviou (Baileys
-- `data.key.participant`), já que `identifier` passa a ser o JID do grupo.
-- NULL em DMs (identifier já é a pessoa). Usada pelo agente auditor (modo sweep)
-- pra saber quem falou em cada mensagem do grupo.

ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE messages     ADD COLUMN IF NOT EXISTS author TEXT;
