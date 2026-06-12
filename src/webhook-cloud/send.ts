import { config } from '../config.js';

/**
 * Envio de texto via WhatsApp Cloud API (número B). Extraído da rota /send-cloud
 * pra ser reusado pelo dispatcher de comandos (resposta a `!comando`).
 *
 * `to` aceita com ou sem '+'. Envia type:text — só funciona dentro da janela de
 * 24h de atendimento; fora dela, exige template (não coberto aqui).
 */
export type CloudSendResult = {
  ok: boolean;
  send_id: string | null;
  status?: number;
  detail?: unknown;
};

export async function sendCloudText(
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<CloudSendResult> {
  const token = config.WHATSAPP_CLOUD_ACCESS_TOKEN;
  if (!token) return { ok: false, send_id: null, detail: 'no access token' };

  const url = `https://graph.facebook.com/${config.WHATSAPP_CLOUD_GRAPH_VERSION}/${encodeURIComponent(
    phoneNumberId,
  )}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: to.replace(/^\+/, ''),
    type: 'text',
    text: { body: text },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const respBody: any = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, send_id: null, status: r.status, detail: respBody };

  const sendId = respBody?.messages?.[0]?.id || respBody?.message_id || null;
  return { ok: true, send_id: sendId };
}
