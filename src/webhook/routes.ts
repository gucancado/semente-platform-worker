import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { lookupContact, logWebhook } from '../db.js';
import { parseEvolutionPayload, shouldCreateTask } from './evolution.js';
import { createTask } from '../bloquim/client.js';

export async function registerWebhookRoutes(app: FastifyInstance) {
  app.post('/webhook', async (req, reply) => {
    // Auth do webhook é por shared secret no header (não X-Agent-Token,
    // pois Evolution não conhece nosso esquema de agentes).
    const secret = req.headers['x-evolution-secret'];
    if (secret !== config.EVOLUTION_WEBHOOK_SECRET) {
      return reply.code(401).send({ error: 'invalid evolution secret' });
    }

    const msg = parseEvolutionPayload(req.body);
    if (!msg) {
      return { ignored: true, reason: 'parse-failed-or-irrelevant' };
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

    // v0.7 trigger-based: notifica o container do agente que tem mensagem nova.
    // Fire-and-forget — falha do trigger não impede ack do webhook.
    let triggerFired = false;
    if (agentCfg.trigger_url) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (agentCfg.trigger_secret) headers['X-Trigger-Secret'] = agentCfg.trigger_secret;
      try {
        const r = await fetch(agentCfg.trigger_url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ inbox_id: inserted.id, agent: msg.agent }),
          signal: AbortSignal.timeout(5000),
        });
        triggerFired = r.ok;
        if (!r.ok) {
          req.log.warn({ status: r.status, agent: msg.agent }, 'trigger non-ok');
        }
      } catch (err) {
        req.log.warn({ err, agent: msg.agent }, 'trigger fetch falhou');
      }
    }

    return {
      ok: true,
      inbox_id: inserted.id,
      bloquim_task_id: bloquimTaskId,
      bloquim_sync: bloquimTaskId !== null,
      fallback: fallbackUsed,
      trigger_fired: triggerFired,
    };
  });
}
