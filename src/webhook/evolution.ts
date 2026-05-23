import { z } from 'zod';

/**
 * Payload do Evolution API (subset relevante). Estrutura confirmada com
 * versão atual do Evolution; ajustar conforme breaking changes.
 */
export const EvolutionMessageSchema = z.object({
  event: z.string(),                              // 'messages.upsert'
  instance: z.string(),                           // nome da instância = agente
  data: z.object({
    key: z.object({
      remoteJid: z.string(),                      // '5531999998888@s.whatsapp.net' ou '...@g.us' (grupo)
      fromMe: z.boolean(),
      id: z.string(),
    }),
    message: z.record(z.string(), z.unknown()).nullable().optional(),
    pushName: z.string().nullable().optional(),
    messageTimestamp: z.union([z.number(), z.string()]).optional(),
  }),
});
export type EvolutionMessage = z.infer<typeof EvolutionMessageSchema>;

export type ParsedMessage = {
  agent: string;             // nome técnico do agente (mercurio)
  project: string | null;    // slug do projeto (sufixo da instance após o primeiro '-'); null se instance não tiver hífen
  instance: string;          // nome bruto da instância (mercurio-metido-a-gente)
  channel: 'whatsapp';
  identifier: string;        // E.164: '+5531999998888'
  isGroup: boolean;
  fromMe: boolean;
  pushName: string | null;
  messageText: string | null;
  rawEventId: string;
};

export function parseEvolutionPayload(raw: unknown): ParsedMessage | null {
  const parse = EvolutionMessageSchema.safeParse(raw);
  if (!parse.success) return null;
  const ev = parse.data;

  if (ev.event !== 'messages.upsert') return null;
  if (ev.data.key.fromMe) return null;

  const jid = ev.data.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const phonePart = jid.split('@')[0] ?? '';
  const identifier = phonePart ? `+${phonePart}` : '';

  if (!identifier) return null;

  // Extrai texto da mensagem cobrindo os envelopes mais comuns do Baileys.
  // Cobertura best-effort; tipos não cobertos ficam null e disparam warning no
  // webhook handler.
  const messageText = extractMessageText(ev.data.message);

  // Convenção: instância Evolution = `<agente>-<projeto>` (ex: mercurio-metido-a-gente).
  // `agent` = prefixo até o primeiro hífen; `project` = sufixo após o primeiro hífen.
  // Sem hífen: agent = instância inteira, project = null (compat com nomes legados).
  const hyphenIdx = ev.instance.indexOf('-');
  const agent = hyphenIdx > 0 ? ev.instance.slice(0, hyphenIdx) : ev.instance;
  const project = hyphenIdx > 0 ? ev.instance.slice(hyphenIdx + 1) : null;

  return {
    agent,
    project,
    instance: ev.instance,
    channel: 'whatsapp',
    identifier,
    isGroup,
    fromMe: false,
    pushName: ev.data.pushName ?? null,
    messageText,
    rawEventId: ev.data.key.id,
  };
}

/**
 * Extrai texto da mensagem cobrindo os envelopes comuns do Baileys/WhatsApp.
 * Ordem de tentativa importa: envelopes "container" (ephemeral, edited,
 * viewOnce) são desempacotados recursivamente.
 */
export function extractMessageText(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, any>;

  // 1) Envelopes container — desempacotar e tentar de novo
  if (m.ephemeralMessage?.message) return extractMessageText(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return extractMessageText(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return extractMessageText(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension?.message) return extractMessageText(m.viewOnceMessageV2Extension.message);
  if (m.editedMessage?.message) return extractMessageText(m.editedMessage.message);
  if (m.protocolMessage?.editedMessage) return extractMessageText(m.protocolMessage.editedMessage);
  if (m.documentWithCaptionMessage?.message) return extractMessageText(m.documentWithCaptionMessage.message);

  // 2) Texto puro
  if (typeof m.conversation === 'string' && m.conversation.length) return m.conversation;
  if (typeof m.extendedTextMessage?.text === 'string') return m.extendedTextMessage.text;

  // 3) Captions de mídia
  if (typeof m.imageMessage?.caption === 'string' && m.imageMessage.caption.length)
    return m.imageMessage.caption;
  if (typeof m.videoMessage?.caption === 'string' && m.videoMessage.caption.length)
    return m.videoMessage.caption;
  if (typeof m.documentMessage?.caption === 'string' && m.documentMessage.caption.length)
    return m.documentMessage.caption;

  // 4) Botão/lista (raros mas existem)
  if (typeof m.buttonsResponseMessage?.selectedDisplayText === 'string')
    return m.buttonsResponseMessage.selectedDisplayText;
  if (typeof m.listResponseMessage?.title === 'string')
    return m.listResponseMessage.title;
  if (typeof m.templateButtonReplyMessage?.selectedDisplayText === 'string')
    return m.templateButtonReplyMessage.selectedDisplayText;

  return null;
}

/**
 * Filtra mensagens que devem virar tarefa:
 * - DM (não-grupo) sempre.
 * - Em grupo, apenas se mencionado @<número do agente> (futura — placeholder).
 */
export function shouldCreateTask(msg: ParsedMessage, _agentJid: string | null = null): boolean {
  if (!msg.isGroup) return true;
  // TODO: detectar @mention para mensagens em grupo
  return false;
}
