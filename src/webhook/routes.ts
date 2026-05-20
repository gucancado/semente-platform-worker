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
      // Evento ignorado (ack=200 pra Evolution não reprocessar)
      return { ignored: true, reason: 'parse-failed-or-irrelevant' };
    }

    if (!shouldCreateTask(msg)) {
      return { ignored: true, reason: 'not-DM-or-mention' };
    }

    const agentCfg = config.AGENT_TOKENS_JSON[msg.agent];
    if (!agentCfg) {
      req.log.warn({ agent: msg.agent }, 'webhook recebido para agente desconhecido');
      return reply.code(404).send({ error: 'unknown agent' });
    }

    // Resolve workspace por remetente
    const route = await lookupContact(msg.agent, msg.channel, msg.identifier);
    const workspaceId = route?.workspace_id ?? agentCfg.fallback_workspace_id;
    const fallbackUsed = !route;

    // Cria tarefa Bloquim
    const tagBase = [`canal:${msg.channel}`];
    if (fallbackUsed) tagBase.push('triagem-necessaria');

    const preview = (msg.messageText ?? '').slice(0, 80) || '(sem texto)';
    const task = await createTask({
      agent: msg.agent,
      bloquim_token: agentCfg.bloquim_token,
      payload: {
        workspaceId,
        title: `WA: ${preview}`,
        description: [
          `**Canal:** ${msg.channel}`,
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
    }).catch((err) => {
      req.log.error({ err }, 'falhou criar tarefa Bloquim');
      return null;
    });

    await logWebhook({
      agent: msg.agent,
      channel: msg.channel,
      identifier: msg.identifier,
      evolution_event_id: msg.rawEventId,
      payload_summary: preview,
      bloquim_task_id: task?.id ?? null,
      fallback_used: fallbackUsed,
    });

    return { ok: true, task_id: task?.id, fallback: fallbackUsed };
  });
}
