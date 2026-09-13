import {
  sendCloudTemplate,
  sendCloudText,
  type CloudSendResult,
  type CloudTemplateMessage,
} from '../webhook-cloud/send.js';
import { connectionDownTemplateParams, renderConnectionDownText } from '../webhook-cloud/templates.js';
import { isRetryableSendFailure, type SendOutcome } from './down-notify.js';

export type DownNotifyTarget = {
  phone: string;
  /** Destinatário, quando diferente do número exibido (envio de teste). Ausente = o próprio número. */
  to?: string;
  /** Nome exibido: o do workspace, ou o rótulo quando não há workspace/resolução. */
  name: string | null;
  downSince: Date;
  token: string;
  link: string;
};

export type DownSendResult = SendOutcome & { via: 'template' | 'text' | null };
export type DownSender = (t: DownNotifyTarget) => Promise<DownSendResult>;

/**
 * Remetente do aviso pelo Cloud API — que não tem sessão para cair, ao contrário
 * de qualquer instância Baileys (inclusive o próprio saturno da Evolution).
 *
 * Template primeiro: é o único que chega fora da janela de 24h. Se falhar (ainda
 * não aprovado, por exemplo), tenta o texto livre — que só chega se a pessoa
 * escreveu para o número nas últimas 24h, mas custa uma chamada e cobre o
 * período de aprovação, com o MESMO corpo do template (o encaminhado é igual ao
 * aprovado). Exceção de rede nunca escapa: vira `networkError`.
 */
export function makeCloudDownSender(opts: {
  phoneNumberId: string;
  templateName: string | undefined;
  templateLang: string;
  sendTemplate?: (pnid: string, to: string, t: CloudTemplateMessage) => Promise<CloudSendResult>;
  sendText?: (pnid: string, to: string, text: string) => Promise<CloudSendResult>;
}): DownSender {
  const sendTemplate =
    opts.sendTemplate ?? ((pnid: string, to: string, t: CloudTemplateMessage) => sendCloudTemplate(pnid, to, t));
  const sendText = opts.sendText ?? ((pnid: string, to: string, text: string) => sendCloudText(pnid, to, text));

  return async (t) => {
    let templateFailure: SendOutcome | null = null;

    if (opts.templateName) {
      const params = connectionDownTemplateParams({
        name: t.name, phone: t.phone, downSince: t.downSince, token: t.token,
      });
      const name = opts.templateName;
      const r = await attempt(() =>
        sendTemplate(opts.phoneNumberId, t.to ?? t.phone, { name, language: opts.templateLang, ...params }),
      );
      if (r.ok) return { ...r, via: 'template' };
      templateFailure = r;
    }

    const text = renderConnectionDownText({ name: t.name, phone: t.phone, downSince: t.downSince, token: t.token });
    const r = await attempt(() => sendText(opts.phoneNumberId, t.to ?? t.phone, text));
    if (r.ok) return { ...r, via: 'text' };

    // Uma falha transitória no template não pode ser mascarada pelo 4xx do
    // texto (que é o esperado fora da janela): senão o aviso esperaria o
    // re-aviso em vez de tentar de novo no próximo tick.
    const failure = templateFailure && isRetryableSendFailure(templateFailure) ? templateFailure : r;
    return { ...failure, via: null };
  };
}

async function attempt(fn: () => Promise<CloudSendResult>): Promise<SendOutcome> {
  try {
    const r = await fn();
    return r.ok ? { ok: true, sendId: r.send_id } : { ok: false, status: r.status, detail: r.detail };
  } catch (err) {
    return { ok: false, networkError: true, detail: (err as Error).message };
  }
}
