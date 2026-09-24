import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { CloudSendResult, CloudTemplateMessage } from '../webhook-cloud/send.js';
import {
  OPS_ALERT_TEMPLATE,
  opsAlertTemplateParams,
  renderOpsAlertText,
} from '../webhook-cloud/templates.js';

/**
 * POST /ops-notify — aviso de OPERAÇÃO do painel (beeads-central-de-dados).
 *
 * Por que uma rota nova em vez de /send-cloud: aquela é text-only, é do
 * orquestrador e recebe `phone_number_id` e `to` do chamador. Aqui o painel não
 * conhece (nem deve conhecer) credencial de WABA, template nem destino — manda
 * só `{titulo, detalhe}` e o worker decide o resto. Isso também impede que um
 * token vazado vire um canal de envio para número arbitrário.
 *
 * Auth: segredo dedicado `OPS_NOTIFY_TOKEN` no header X-Ops-Notify-Token, no
 * molde do X-Evolution-Secret do /webhook. NÃO reusa X-Agent-Token (exigiria
 * mexer em AGENT_TOKENS_JSON, cujo parse malformado derruba o boot) nem
 * PANEL_TOKEN (alargaria o poder de um token que vive no app web).
 *
 * Envio: template primeiro — é o único que chega fora da janela de 24h, e
 * ninguém conversa com o número Cloud. Se ele falhar (o template está PENDING na
 * Meta enquanto isto é escrito), cai no texto livre com o MESMO corpo
 * renderizado: custa uma chamada e é a única chance de entrega no período de
 * aprovação. Mesmo padrão do aviso de queda (down-notify-sender.ts).
 */

export type OpsNotifyDeps = {
  /** OPS_NOTIFY_TOKEN. Ausente = rota declarada mas 503. */
  token: string | undefined;
  /** OPS_NOTIFY_TO — destino E.164 sem '+' (ex.: 553196039118). */
  to: string | undefined;
  /** Remetente Cloud: o MESMO phone_number_id do aviso de queda. Nunca vem do chamador. */
  phoneNumberId: string | null;
  /** WHATSAPP_CLOUD_ACCESS_TOKEN presente. */
  cloudConfigured: boolean;
  /**
   * Injetados pelo index.ts (sendCloudTemplate/sendCloudText). Obrigatórios de
   * propósito: sem eles este módulo importaria send.js, que importa config.js,
   * e o teste da rota passaria a exigir o .env inteiro só para existir.
   */
  sendTemplate: (pnid: string, to: string, t: CloudTemplateMessage) => Promise<CloudSendResult>;
  sendText: (pnid: string, to: string, text: string) => Promise<CloudSendResult>;
};

/** Comparação de tempo constante — o header é um segredo, não um id. */
function secretMatches(received: unknown, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerOpsNotifyRoute(app: FastifyInstance, deps: OpsNotifyDeps) {
  const { sendTemplate, sendText } = deps;

  app.post('/ops-notify', async (req, reply) => {
    // Sem o segredo não há como autenticar ninguém: 503 antes do 401, senão a
    // rota responderia 401 para o próprio painel e o operador procuraria o
    // token errado. O que vaza a um anônimo é só "não configurado".
    if (!deps.token) {
      return reply.code(503).send({ error: 'ops-notify not configured (no OPS_NOTIFY_TOKEN)' });
    }
    if (!secretMatches(req.headers['x-ops-notify-token'], deps.token)) {
      req.log.warn({ hasHeader: !!req.headers['x-ops-notify-token'] }, 'ops-notify: token ausente ou inválido');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!deps.to) {
      return reply.code(503).send({ error: 'ops-notify not configured (no OPS_NOTIFY_TO)' });
    }
    if (!deps.cloudConfigured) {
      return reply.code(503).send({ error: 'cloud not configured (no access token)' });
    }
    if (!deps.phoneNumberId) {
      return reply.code(503).send({ error: 'ops-notify not configured (no cloud phone_number_id)' });
    }

    const body = req.body as { titulo?: unknown; detalhe?: unknown } | undefined;
    const titulo = typeof body?.titulo === 'string' ? body.titulo : '';
    const detalhe = typeof body?.detalhe === 'string' ? body.detalhe : null;
    if (!titulo.trim()) {
      return reply.code(400).send({ error: 'titulo obrigatório' });
    }

    const pnid = deps.phoneNumberId;
    const to = deps.to;
    const input = { titulo, detalhe };

    const viaTemplate = await attempt(() =>
      sendTemplate(pnid, to, {
        name: OPS_ALERT_TEMPLATE.name,
        language: OPS_ALERT_TEMPLATE.language,
        ...opsAlertTemplateParams(input),
      }),
    );
    if (viaTemplate.ok) {
      req.log.info({ via: 'template', send_id: viaTemplate.sendId }, 'ops-notify enviado');
      return reply.code(200).send({ ok: true, via: 'template', send_id: viaTemplate.sendId });
    }
    req.log.warn(
      { status: viaTemplate.status, detail: viaTemplate.detail, template: OPS_ALERT_TEMPLATE.name },
      'ops-notify: template falhou — tentando texto livre',
    );

    const viaText = await attempt(() => sendText(pnid, to, renderOpsAlertText(input)));
    if (viaText.ok) {
      req.log.info({ via: 'text', send_id: viaText.sendId }, 'ops-notify enviado');
      return reply.code(200).send({ ok: true, via: 'text', send_id: viaText.sendId });
    }

    req.log.error(
      { templateFailure: viaTemplate.detail, textFailure: viaText.detail },
      'ops-notify: template E texto livre falharam',
    );
    return reply.code(502).send({
      error: 'ops-notify send failed',
      template: { status: viaTemplate.status, detail: viaTemplate.detail },
      text: { status: viaText.status, detail: viaText.detail },
    });
  });
}

type Outcome =
  | { ok: true; sendId: string | null }
  | { ok: false; status?: number; detail?: unknown };

/** Exceção de rede nunca escapa: o canal de aviso não pode derrubar quem avisa. */
async function attempt(fn: () => Promise<CloudSendResult>): Promise<Outcome> {
  try {
    const r = await fn();
    return r.ok ? { ok: true, sendId: r.send_id } : { ok: false, status: r.status, detail: r.detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
