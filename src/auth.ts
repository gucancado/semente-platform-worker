import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { resolveAgentFromToken, type AgentConfig } from './config.js';

declare module 'fastify' {
  interface FastifyRequest {
    agent: { name: string; cfg: AgentConfig };
  }
}

/**
 * Pre-handler que valida X-Agent-Token e popula request.agent.
 * Rejeita 401 se token ausente ou inválido.
 */
export const requireAgentToken: preHandlerHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply
) => {
  const token = req.headers['x-agent-token'];
  if (typeof token !== 'string' || !token) {
    return reply.code(401).send({ error: 'missing X-Agent-Token' });
  }
  const resolved = resolveAgentFromToken(token);
  if (!resolved) {
    return reply.code(401).send({ error: 'invalid X-Agent-Token' });
  }
  req.agent = resolved;
};
