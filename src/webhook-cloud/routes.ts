import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  enqueuePendingTrigger,
  getAgentProjectConfig,
  insertMessage,
  logWebhook,
} from '../db.js';
import { computeScheduledAt } from '../triggers/quiet-hours.js';
import { parseCloudPayload, verifyHmacSignature } from './parser.js';

/**
 * Rotas do webhook WhatsApp Cloud API (Meta).
 *
 * - GET /webhook-cloud — verificação inicial (Meta envia hub.mode=subscribe
 *   com hub.verify_token; respondemos hub.challenge se token bater).
 * - POST /webhook-cloud — eventos. Validamos HMAC com WHATSAPP_CLOUD_APP_SECRET,
 *   parseamos, dedupamos via webhook_logs/messages, disparamos trigger do
 *   agente correspondente.
 *
 * Auth: o "secret" do Cloud API é o HMAC do body (X-Hub-Signature-256), não
 * um header custom como o Evolution. Implementação separada por isso.
 */
export async function registerWebhookCloudRoutes(app: FastifyInstance) {
  // ── GET — verificação inicial (Meta chama 1x ao registrar webhook) ────
  app.get('/webhook-cloud', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];

    if (mode === 'subscribe' && token && token === config.WHATSAPP_CLOUD_VERIFY_TOKEN) {
      req.log.info('cloud webhook: verify token bateu, devolvendo challenge');
      return reply.type('text/plain').send(challenge);
    }

    req.log.warn({ mode, hasToken: !!token }, 'cloud webhook: verify falhou');
    return reply.code(403).send({ error: 'verify_token mismatch' });
  });

  // ── POST — eventos do Cloud API ────────────────────────────────────────
  app.post('/webhook-cloud', async (req, reply) => {
    const appSecret = config.WHATSAPP_CLOUD_APP_SECRET;
    if (!appSecret) {
      req.log.error('cloud webhook recebido mas WHATSAPP_CLOUD_APP_SECRET não setado');
      return reply.code(503).send({ error: 'cloud not configured' });
    }

    // Valida HMAC. Cloud assina o body bruto. Fastify por default já leu o body
    // como objeto; precisamos do raw pra HMAC. Fix: usar `rawBody` (precisa
    // configurar Fastify pra preservar). Fallback: re-serializar JSON.
    const rawBody = (req as any).rawBody as Buffer | string | undefined;
    const bodyForHmac = rawBody ?? JSON.stringify(req.body);
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const usingRaw = !!rawBody;
    const bodyLen = Buffer.isBuffer(bodyForHmac) ? bodyForHmac.length : bodyForHmac.length;

    req.log.info(
      { usingRaw, bodyLen, hasSig: !!sigHeader, sigPrefix: sigHeader?.slice(0, 20) },
      'cloud webhook: validando HMAC'
    );

    if (!verifyHmacSignature(bodyForHmac, sigHeader, appSecret)) {
      // Computa o hash esperado pra debug. Não vaza o secret.
      const { createHmac } = await import('node:crypto');
      const hmac = createHmac('sha256', appSecret);
      hmac.update(bodyForHmac);
      const computed = hmac.digest('hex').slice(0, 16);
      req.log.warn(
        {
          hasSig: !!sigHeader,
          sigReceivedPrefix: sigHeader?.slice(0, 20),
          computedPrefix: 'sha256=' + computed + '...',
          usingRaw,
          bodyLen,
          appSecretLen: appSecret.length,
        },
        'cloud webhook HMAC mismatch — rejeitando'
      );
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const numberMap = config.WHATSAPP_CLOUD_NUMBERS_JSON as Record<
      string,
      { agent: string; project: string }
    >;
    const parsed = parseCloudPayload(req.body, numberMap);

    if (parsed.length === 0) {
      // Pode ser status update, ack, ou número desconhecido.
      // Cloud API espera 200 sempre (senão re-envia repetidamente).
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const results: Array<{ inbox_id: number; duplicate: boolean; trigger_queued?: boolean; trigger_error?: string | null }> = [];

    for (const msg of parsed) {
      const agentCfg = config.AGENT_TOKENS_JSON[msg.agent];
      if (!agentCfg) {
        req.log.warn({ agent: msg.agent, phoneNumberId: msg.phoneNumberId }, 'cloud webhook: agente desconhecido');
        continue;
      }

      // Log em webhook_logs (audit). Convenção: instance = `${agent}-${project}`
      // pra ficar compatível com tick.sh/process-tick-message que esperam isso.
      const instance = msg.project ? `${msg.agent}-${msg.project}` : msg.agent;
      const inserted = await logWebhook({
        agent: msg.agent,
        channel: msg.channel,
        instance,
        identifier: msg.identifier,
        push_name: msg.pushName,
        message_text: msg.messageText,
        workspace_id: null,
        evolution_event_id: msg.rawEventId, // reusa coluna; é unique partial index
        payload_summary: (msg.messageText ?? '').slice(0, 80) || '(sem texto)',
        bloquim_task_id: null,
        fallback_used: true,
      });

      // messages timeline (inbound)
      try {
        if (msg.messageText && msg.identifier) {
          await insertMessage({
            agent: msg.agent,
            project: msg.project,
            channel: msg.channel,
            identifier: msg.identifier,
            direction: 'inbound',
            text: msg.messageText,
            evolution_event_id: msg.rawEventId,
          });
        }
      } catch (err) {
        req.log.warn(
          { err: (err as Error).message },
          'cloud webhook insertMessage(inbound) falhou — segue'
        );
      }

      if (inserted.duplicate) {
        req.log.info(
          { agent: msg.agent, wamid: msg.rawEventId, inbox_id: inserted.id },
          'cloud webhook duplicado — sem trigger'
        );
        results.push({ inbox_id: inserted.id, duplicate: true });
        continue;
      }

      // Enfileira pending_trigger em vez de fire-and-forget. Burst smoothing
      // (várias msgs em sequência → 1 trigger), quiet hours (config DB
      // empurra scheduled_at pro fim da janela) e retry com backoff (poller)
      // ficam disponíveis pro Cloud path igual o Evolution path.
      let triggerQueued = false;
      let triggerError: string | null = null;
      if (!agentCfg.trigger_url) {
        triggerError = 'no trigger_url configured';
      } else if (!msg.identifier) {
        triggerError = 'missing identifier';
      } else {
        try {
          const projectConfig = msg.project
            ? await getAgentProjectConfig(msg.agent, msg.project).catch(() => null)
            : null;
          const scheduledAt = computeScheduledAt(projectConfig, config.TRIGGER_DEBOUNCE_MS);
          const queued = await enqueuePendingTrigger({
            agent: msg.agent,
            project: msg.project,
            identifier: msg.identifier,
            inbox_id: inserted.id,
            scheduled_at: scheduledAt,
          });
          triggerQueued = true;
          req.log.info(
            {
              agent: msg.agent,
              identifier: msg.identifier,
              pending_id: queued.id,
              msg_count: queued.msg_count,
              scheduled_at: scheduledAt.toISOString(),
              quiet_active: projectConfig?.quiet_hours_enabled === true,
              source: 'cloud',
            },
            queued.msg_count > 1 ? 'cloud trigger debounced — burst smoothing' : 'cloud trigger enqueued'
          );
        } catch (err) {
          triggerError = (err as Error).message;
          req.log.warn({ err: triggerError, agent: msg.agent }, 'cloud enqueuePendingTrigger falhou');
        }
      }

      results.push({ inbox_id: inserted.id, duplicate: false, trigger_queued: triggerQueued, trigger_error: triggerError });
    }

    return reply.code(200).send({ ok: true, processed: results.length, results });
  });
}

// ── POST /send-cloud — abstração de envio (chamado pelo orquestrador) ───
// Mantida em arquivo separado pra clareza, mas registrada no mesmo plugin.

export async function registerSendCloudRoute(app: FastifyInstance) {
  app.post('/send-cloud', async (req, reply) => {
    const token = config.WHATSAPP_CLOUD_ACCESS_TOKEN;
    if (!token) {
      return reply.code(503).send({ error: 'cloud not configured (no access token)' });
    }

    const body = req.body as {
      phone_number_id: string;
      to: string; // sem '+', formato '5531...'
      text: string;
    };

    if (!body?.phone_number_id || !body?.to || !body?.text) {
      return reply.code(400).send({ error: 'phone_number_id, to, text obrigatórios' });
    }

    const url = `https://graph.facebook.com/${config.WHATSAPP_CLOUD_GRAPH_VERSION}/${encodeURIComponent(body.phone_number_id)}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: body.to.replace(/^\+/, ''),
      type: 'text',
      text: { body: body.text },
    };

    try {
      const t0 = Date.now();
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const respBody = await r.json().catch(() => ({}));
      const latencyMs = Date.now() - t0;

      if (!r.ok) {
        req.log.warn({ status: r.status, respBody }, 'cloud sendText falhou');
        return reply.code(502).send({ error: 'cloud send failed', status: r.status, detail: respBody });
      }

      const sendId =
        (respBody as any)?.messages?.[0]?.id ||
        (respBody as any)?.message_id ||
        null;

      return reply.code(200).send({ ok: true, send_id: sendId, latency_ms: latencyMs });
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'cloud send exception');
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
