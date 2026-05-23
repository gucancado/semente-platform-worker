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

  // Extrai texto da mensagem (best-effort; tipos diferentes têm payloads diferentes)
  const msg = ev.data.message;
  const messageText =
    typeof (msg as any)?.conversation === 'string'
      ? (msg as any).conversation
      : typeof (msg as any)?.extendedTextMessage?.text === 'string'
      ? (msg as any).extendedTextMessage.text
      : null;

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
 * Filtra mensagens que devem virar tarefa:
 * - DM (não-grupo) sempre.
 * - Em grupo, apenas se mencionado @<número do agente> (futura — placeholder).
 */
export function shouldCreateTask(msg: ParsedMessage, _agentJid: string | null = null): boolean {
  if (!msg.isGroup) return true;
  // TODO: detectar @mention para mensagens em grupo
  return false;
}
