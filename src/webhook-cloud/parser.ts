import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Payload do webhook do WhatsApp Cloud API (Meta).
 * Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *
 * Estrutura:
 *   {
 *     "object": "whatsapp_business_account",
 *     "entry": [{
 *       "id": "<WABA_ID>",
 *       "changes": [{
 *         "value": {
 *           "messaging_product": "whatsapp",
 *           "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
 *           "contacts": [{ "profile": { "name": "..." }, "wa_id": "55..." }],
 *           "messages": [{
 *             "from": "55...",
 *             "id": "wamid....",
 *             "timestamp": "...",
 *             "type": "text" | "image" | "audio" | ...,
 *             "text": { "body": "..." }
 *           }]
 *         },
 *         "field": "messages"
 *       }]
 *     }]
 *   }
 *
 * Cloud API entrega potencialmente MÚLTIPLAS mensagens em um único POST
 * (batch em entry[].changes[].value.messages[]). Parser retorna array.
 */

export const CloudWebhookSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: z.object({
            messaging_product: z.string().optional(),
            metadata: z
              .object({
                display_phone_number: z.string().optional(),
                phone_number_id: z.string().optional(),
              })
              .optional(),
            contacts: z
              .array(
                z.object({
                  profile: z.object({ name: z.string().optional() }).optional(),
                  wa_id: z.string(),
                })
              )
              .optional(),
            messages: z
              .array(
                z.object({
                  from: z.string(),
                  id: z.string(),
                  timestamp: z.string().optional(),
                  type: z.string(),
                  text: z.object({ body: z.string() }).optional(),
                  image: z
                    .object({ caption: z.string().optional(), id: z.string().optional() })
                    .optional(),
                  video: z
                    .object({ caption: z.string().optional(), id: z.string().optional() })
                    .optional(),
                  document: z
                    .object({ caption: z.string().optional(), id: z.string().optional() })
                    .optional(),
                  audio: z.object({ id: z.string().optional() }).optional(),
                  button: z.object({ text: z.string().optional() }).optional(),
                  interactive: z.unknown().optional(),
                  context: z.unknown().optional(),
                })
              )
              .optional(),
            statuses: z
              .array(z.object({ id: z.string(), status: z.string() }))
              .optional(),
          }),
          field: z.string(),
        })
      ),
    })
  ),
});

export type CloudWebhookPayload = z.infer<typeof CloudWebhookSchema>;

export type ParsedCloudMessage = {
  agent: string;             // resolvido por convenção a partir de mapeamento phone_number_id → agent (env)
  project: string | null;    // resolvido idem (mapping phone_number_id → project)
  channel: 'whatsapp';
  identifier: string;        // E.164: '+5531...'
  isGroup: false;            // Cloud API não envia mensagens de grupo no webhook por enquanto
  fromMe: false;             // Cloud API webhook só recebe inbound
  pushName: string | null;
  messageText: string | null;
  rawEventId: string;        // wamid....
  phoneNumberId: string;     // do `metadata.phone_number_id`
  wabaId: string;            // entry.id
};

/**
 * Mapping phone_number_id → { agent, project }.
 * Lê de env JSON. Ex (defaults pra test number da BeeAds):
 *   WHATSAPP_CLOUD_NUMBERS_JSON = {"1152130677980438":{"agent":"mercurio","project":"metido-a-gente"}}
 */
export type CloudNumberMap = Record<string, { agent: string; project: string }>;

/**
 * Extrai texto da mensagem cobrindo os tipos comuns do Cloud API.
 * Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components#messages-object
 */
export function extractCloudMessageText(msg: any): string | null {
  if (!msg) return null;
  if (msg.type === 'text' && typeof msg.text?.body === 'string') return msg.text.body;
  if (msg.type === 'image' && typeof msg.image?.caption === 'string' && msg.image.caption) return msg.image.caption;
  if (msg.type === 'video' && typeof msg.video?.caption === 'string' && msg.video.caption) return msg.video.caption;
  if (msg.type === 'document' && typeof msg.document?.caption === 'string' && msg.document.caption) return msg.document.caption;
  if (msg.type === 'button' && typeof msg.button?.text === 'string') return msg.button.text;
  if (msg.type === 'interactive') {
    const intr = msg.interactive;
    if (intr?.button_reply?.title) return intr.button_reply.title;
    if (intr?.list_reply?.title) return intr.list_reply.title;
  }
  return null;
}

/**
 * Parsea um payload completo do Cloud webhook. Pode retornar 0..N mensagens
 * porque uma entrega pode trazer várias.
 *
 * @param raw — body recebido
 * @param numberMap — mapping phone_number_id → { agent, project }
 */
export function parseCloudPayload(
  raw: unknown,
  numberMap: CloudNumberMap
): ParsedCloudMessage[] {
  const parse = CloudWebhookSchema.safeParse(raw);
  if (!parse.success) return [];
  const payload = parse.data;
  if (payload.object !== 'whatsapp_business_account') return [];

  const out: ParsedCloudMessage[] = [];

  for (const entry of payload.entry) {
    const wabaId = entry.id;
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const mapping = numberMap[phoneNumberId];
      if (!mapping) {
        // Mensagem chegou pra phone_number_id desconhecido — ignorar.
        // Worker loga warning antes de chamar isso.
        continue;
      }

      const messages = value.messages || [];
      const contacts = value.contacts || [];

      for (const msg of messages) {
        if (!msg.from || !msg.id) continue;
        const contact = contacts.find((c) => c.wa_id === msg.from);
        out.push({
          agent: mapping.agent,
          project: mapping.project,
          channel: 'whatsapp',
          identifier: `+${msg.from}`,
          isGroup: false,
          fromMe: false,
          pushName: contact?.profile?.name ?? null,
          messageText: extractCloudMessageText(msg),
          rawEventId: msg.id,
          phoneNumberId,
          wabaId,
        });
      }
    }
  }

  return out;
}

/**
 * Helper pra validar HMAC do header X-Hub-Signature-256.
 * Cloud API assina o body bruto com o App Secret usando HMAC-SHA256.
 * Formato do header: "sha256=<hex>"
 */
export function verifyHmacSignature(rawBody: Buffer | string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = signatureHeader.slice('sha256='.length);

  const hmac = createHmac('sha256', appSecret);
  hmac.update(rawBody);
  const computedHex = hmac.digest('hex');

  // timing-safe compare
  if (expectedHex.length !== computedHex.length) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(computedHex, 'hex'));
}
