import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Urgency } from './queue.js';

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
 * Envio: desde 2026-10-07 a rota NÃO envia — ENFILEIRA em `ops_notify_queue`
 * (mig 070) e responde 202. Quem envia é o `flusher.ts`, em lote: `urgencia`
 * "urgente" (default, compatível com chamador antigo) sai em minutos junto com o
 * que mais estiver na fila; "resumo" espera o horário fixo (09:00/16:00 SP).
 * Cada aviso virava uma mensagem cobrada, espalhada pela madrugada. A fila é
 * durável, então 202 continua significando "não vai se perder" — o painel pode
 * seguir marcando `notified_at` no 2xx.
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
   * Grava na fila. Injetado pelo index.ts (pool real) — sem ele o teste da rota
   * passaria a exigir banco. Os 503 de config continuam ANTES do enfileirar: um
   * aviso aceito que nunca poderá sair seria pior que a recusa.
   */
  enqueue: (n: { titulo: string; detalhe: string | null; urgency: Urgency }) => Promise<number>;
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

    const urgencia = (body as { urgencia?: unknown } | undefined)?.urgencia;
    if (urgencia !== undefined && urgencia !== 'urgente' && urgencia !== 'resumo') {
      return reply.code(400).send({ error: "urgencia deve ser 'urgente' ou 'resumo'" });
    }
    const urgency: Urgency = urgencia === 'resumo' ? 'digest' : 'urgent';

    try {
      const id = await deps.enqueue({ titulo, detalhe, urgency });
      req.log.info({ id, urgency }, 'ops-notify enfileirado');
      return reply.code(202).send({ ok: true, queued: true, id, urgency, via: 'queue' });
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'ops-notify: falha ao enfileirar');
      return reply.code(500).send({ error: 'ops-notify enqueue failed' });
    }
  });
}
