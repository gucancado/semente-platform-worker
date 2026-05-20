import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import {
  lookupContact,
  upsertContact,
  listContactsByWorkspace,
  deleteContact,
  type ContactRoute,
} from '../db.js';

const ChannelEnum = z.enum(['whatsapp', 'email']);

export async function registerContactsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgentToken);

  // Lookup por identifier ou listar por workspace
  app.get('/contacts', async (req, reply) => {
    const query = z
      .object({
        channel: ChannelEnum.optional(),
        identifier: z.string().optional(),
        workspace_id: z.string().optional(),
      })
      .parse(req.query);

    if (query.channel && query.identifier) {
      const route = await lookupContact(req.agent.name, query.channel, query.identifier);
      return route ?? reply.code(404).send({ error: 'not found' });
    }

    if (query.workspace_id) {
      const list = await listContactsByWorkspace(req.agent.name, query.workspace_id);
      return { contacts: list };
    }

    return reply.code(400).send({ error: 'pass channel+identifier OR workspace_id' });
  });

  // Criar ou atualizar route (upsert)
  app.post<{ Body: unknown }>('/contacts', async (req) => {
    const body = z
      .object({
        channel: ChannelEnum,
        identifier: z.string().min(1),
        workspace_id: z.string().min(1),
        display_name: z.string().nullish(),
        notes: z.string().nullish(),
      })
      .parse(req.body);

    const route = await upsertContact({ agent: req.agent.name, ...body });
    return { route };
  });

  // Patch parcial (mesmo upsert mas mantendo campos não enviados)
  app.patch<{ Params: { id: string }; Body: unknown }>('/contacts/:id', async (req, reply) => {
    // Por enquanto, patch é o mesmo que POST por identifier — implementação
    // completa requer SELECT + UPDATE por id. Stub: rejeita até implementar.
    return reply.code(501).send({ error: 'PATCH not implemented; use POST (upsert by identifier)' });
  });

  app.delete<{ Params: { id: string } }>('/contacts/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const ok = await deleteContact(req.agent.name, id);
    return ok ? { deleted: true } : reply.code(404).send({ error: 'not found' });
  });
}
