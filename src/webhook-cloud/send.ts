import { config } from '../config.js';

/**
 * Envio via WhatsApp Cloud API. Extraído da rota /send-cloud pra ser reusado
 * pelo dispatcher de comandos e pelo aviso de queda de conexão.
 *
 * `to` aceita com ou sem '+'. Texto (type:text) só é entregue dentro da janela
 * de 24h de atendimento; fora dela a Meta exige TEMPLATE aprovado — ver
 * `sendCloudTemplate`. Erro de rede/timeout LANÇA (os chamadores antigos
 * dependem disso); erro HTTP volta como `ok:false` com status e corpo.
 */
export type CloudSendResult = {
  ok: boolean;
  send_id: string | null;
  status?: number;
  detail?: unknown;
};

/** Injetável nos testes; o default lê do config a cada chamada. */
export type CloudDeps = { token: string | undefined; graphVersion: string; fetch?: typeof fetch };

function defaultDeps(): CloudDeps {
  return { token: config.WHATSAPP_CLOUD_ACCESS_TOKEN, graphVersion: config.WHATSAPP_CLOUD_GRAPH_VERSION };
}

/** phone_number_id Cloud do agente no mapa `WHATSAPP_CLOUD_NUMBERS_JSON`. */
export function cloudPhoneNumberIdForAgent(
  map: Record<string, { agent: string; project: string }>,
  agent: string,
): string | null {
  return Object.keys(map).find((id) => map[id]?.agent === agent) ?? null;
}

export type CloudTemplateMessage = {
  name: string;
  language: string;
  bodyParams: string[];
  /** Sufixo do botão de URL dinâmico (índice 0). Ausente = template sem botão. */
  urlButtonParam?: string;
};

export function buildCloudTemplatePayload(to: string, t: CloudTemplateMessage) {
  const components: any[] = [
    { type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text })) },
  ];
  if (t.urlButtonParam !== undefined) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: t.urlButtonParam }],
    });
  }
  return {
    messaging_product: 'whatsapp' as const,
    to: to.replace(/^\+/, ''),
    type: 'template' as const,
    template: { name: t.name, language: { code: t.language }, components },
  };
}

async function postMessage(phoneNumberId: string, payload: unknown, deps: CloudDeps): Promise<CloudSendResult> {
  if (!deps.token) return { ok: false, send_id: null, detail: 'no access token' };
  const f = deps.fetch ?? fetch;
  const url = `https://graph.facebook.com/${deps.graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
  const r = await f(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const respBody: any = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, send_id: null, status: r.status, detail: respBody };

  const sendId = respBody?.messages?.[0]?.id || respBody?.message_id || null;
  return { ok: true, send_id: sendId };
}

export async function sendCloudText(
  phoneNumberId: string,
  to: string,
  text: string,
  deps: CloudDeps = defaultDeps(),
): Promise<CloudSendResult> {
  return postMessage(
    phoneNumberId,
    { messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'text', text: { body: text } },
    deps,
  );
}

export async function sendCloudTemplate(
  phoneNumberId: string,
  to: string,
  t: CloudTemplateMessage,
  deps: CloudDeps = defaultDeps(),
): Promise<CloudSendResult> {
  return postMessage(phoneNumberId, buildCloudTemplatePayload(to, t), deps);
}
