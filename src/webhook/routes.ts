import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  enqueuePendingTrigger,
  getAgentProjectConfig,
  insertMessage,
  lookupContact,
  logWebhook,
} from '../db.js';
import { parseEvolutionPayload, shouldCreateTask } from './evolution.js';
import { createTask } from '../bloquim/client.js';
import { computeScheduledAt } from '../triggers/quiet-hours.js';

export async function registerWebhookRoutes(app: FastifyInstance) {
  app.post('/webhook', async (req, reply) => {
    // Auth: shared secret obrigatório no header X-Evolution-Secret.
    const secret = req.headers['x-evolution-secret'];
    if (!secret || secret !== config.EVOLUTION_WEBHOOK_SECRET) {
      req.log.warn(
        { hasHeader: !!secret, secretLen: typeof secret === 'string' ? secret.length : 0 },
        'webhook rejeitado — X-Evolution-Secret ausente ou mismatch'
      );
      return reply.code(401).send({ error: 'invalid evolution secret' });
    }

    const msg = parseEvolutionPayload(req.body);
    if (!msg) {
      return { ignored: true, reason: 'parse-failed-or-irrelevant' };
    }

    // Diagnóstico: quando texto vier null, loga o keyset da envelope pra entender
    // que tipo de mensagem foi enviada. Sem isso a investigação fica cega.
    if (!msg.messageText) {
      const envelope = (req.body as any)?.data?.message;
      const envelopeKeys = envelope && typeof envelope === 'object' ? Object.keys(envelope) : [];
      req.log.warn(
        { agent: msg.agent, identifier: msg.identifier, envelopeKeys, isGroup: msg.isGroup },
        'webhook: mensagem chegou sem texto extraível — checar envelope keys'
      );
    }

    if (!shouldCreateTask(msg)) {
      return { ignored: true, reason: 'not-DM-or-mention' };
    }

    const agentCfg = config.AGENT_TOKENS_JSON[msg.agent];
    if (!agentCfg) {
      req.log.warn({ agent: msg.agent, instance: msg.instance }, 'webhook recebido para agente desconhecido');
      return reply.code(404).send({ error: 'unknown agent' });
    }

    // Resolve workspace por remetente (opcional — só relevante se Bloquim sync ligado)
    const route = await lookupContact(msg.agent, msg.channel, msg.identifier);
    const workspaceId = route?.workspace_id ?? agentCfg.fallback_workspace_id ?? null;
    const fallbackUsed = !route;

    // Bloquim sync é OPCIONAL agora (v0.6). Só roda se agente tem bloquim_token + fallback_workspace_id.
    // Sem Bloquim: webhook_logs vira a inbox, agente lê via MCP `inbox_list_unread`.
    let bloquimTaskId: string | null = null;
    if (agentCfg.bloquim_token && workspaceId) {
      const tagBase = [`canal:${msg.channel}`];
      if (fallbackUsed) tagBase.push('triagem-necessaria');
      const preview = (msg.messageText ?? '').slice(0, 80) || '(sem texto)';
      try {
        const task = await createTask({
          agent: msg.agent,
          bloquim_token: agentCfg.bloquim_token,
          payload: {
            workspaceId,
            title: `WA: ${preview}`,
            description: [
              `**Canal:** ${msg.channel}`,
              `**Instância (persona/projeto):** ${msg.instance}`,
              `**De:** ${msg.identifier}${msg.pushName ? ` (${msg.pushName})` : ''}`,
              `**Fallback workspace:** ${fallbackUsed ? 'sim — triagem necessária' : 'não'}`,
              `**Evolution event id:** ${msg.rawEventId}`,
              '',
              '**Mensagem:**',
              '```',
              msg.messageText ?? '(sem texto)',
              '```',
            ].join('\n'),
            scheduleMode: 'urgente',
            tags: tagBase,
          },
        });
        bloquimTaskId = task?.id ?? null;
      } catch (err) {
        req.log.warn({ err }, 'bloquim sync falhou — inbox no worker continua disponível');
      }
    }

    // Sempre loga no worker (= inbox primária a partir da v0.6)
    const inserted = await logWebhook({
      agent: msg.agent,
      channel: msg.channel,
      instance: msg.instance,
      identifier: msg.identifier,
      push_name: msg.pushName,
      message_text: msg.messageText,
      workspace_id: workspaceId,
      evolution_event_id: msg.rawEventId,
      payload_summary: (msg.messageText ?? '').slice(0, 80) || '(sem texto)',
      bloquim_task_id: bloquimTaskId,
      fallback_used: fallbackUsed,
    });

    // Fase 1: timeline conversacional. Inbound vai pra `messages` em paralelo
    // ao `webhook_logs`. Dedup pelo unique index parcial (agent, evolution_event_id).
    // Falha aqui não interrompe webhook — apenas loga.
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
      req.log.warn({ err: (err as Error).message }, 'insertMessage(inbound) falhou — webhook segue');
    }

    // Webhook duplicado (Evolution re-enviou o mesmo evento). Não dispara
    // trigger — o item original já foi processado ou está na fila.
    if (inserted.duplicate) {
      req.log.info(
        { agent: msg.agent, evolution_event_id: msg.rawEventId, inbox_id: inserted.id },
        'webhook duplicado — ignorando (sem trigger)'
      );
      return {
        ok: true,
        inbox_id: inserted.id,
        duplicate: true,
        trigger_fired: false,
      };
    }

    // v0.8 (mitigação anti-detecção): em vez de fire-and-forget do trigger,
    // enfileiramos em pending_triggers. Burst smoothing: várias msgs em
    // sequência atualizam a MESMA row pending e empurram scheduled_at —
    // mercurio recebe 1 trigger só. Quiet hours: se config tem janela
    // silenciada e o horário cai dentro, scheduled_at vira o fim da janela.
    let triggerQueued = false;
    let triggerError: string | null = null;
    if (!agentCfg.trigger_url) {
      req.log.warn({ agent: msg.agent }, 'agentCfg.trigger_url não está setado em AGENT_TOKENS_JSON');
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
          },
          queued.msg_count > 1 ? 'trigger debounced — burst smoothing' : 'trigger enqueued'
        );
      } catch (err) {
        triggerError = (err as Error).message;
        req.log.warn({ err: triggerError, agent: msg.agent }, 'enqueuePendingTrigger falhou');
      }
    }

    return {
      ok: true,
      inbox_id: inserted.id,
      bloquim_task_id: bloquimTaskId,
      bloquim_sync: bloquimTaskId !== null,
      fallback: fallbackUsed,
      trigger_queued: triggerQueued,
      trigger_error: triggerError,
    };
  });
}
