import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    isOwner?: true;
  }
}

/**
 * Pre-handler que valida X-Owner-Token contra OWNER_ADMIN_TOKEN do env.
 * Lido do env por chamada (não cacheado) pra facilitar testes que mudam o token.
 * Em produção isso é env var fixa lida no startup — custo de re-acessar é zero.
 */
export const requireOwnerToken: preHandlerHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply
) => {
  const expected = process.env.OWNER_ADMIN_TOKEN;
  if (!expected) {
    return reply.code(500).send({ error: 'OWNER_ADMIN_TOKEN not configured' });
  }
  const got = req.headers['x-owner-token'];
  if (typeof got !== 'string' || !got) {
    return reply.code(401).send({ error: 'missing X-Owner-Token' });
  }
  if (got !== expected) {
    return reply.code(401).send({ error: 'invalid X-Owner-Token' });
  }
  req.isOwner = true;
};
