import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import { searchMemoria } from './search.js';
import { getEmbeddingClient } from './embedding-provider.js';

// Espelho REST de `search_memoria` (spec §8.6). Auth: X-Agent-Token (Lua,
// Saturno, GUI). `q` e `workspace_id` obrigatorios; o resto opcional.
const SearchQuery = z.object({
  workspace_id: z.string().min(1),
  q: z.string().min(1),
  k: z.coerce.number().int().optional(),
  scope: z.enum(['episodios', 'fatos', 'ambos']).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

export async function registerMemoriaRoutes(app: FastifyInstance): Promise<void> {
  // ── Leitura: X-Agent-Token (Lua, Saturno, GUI) ──────────────────────────
  app.register(async (scope) => {
    scope.addHook('preHandler', requireAgentToken);

    scope.get('/memoria/search', async (req, reply) => {
      const parsed = SearchQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { workspace_id, q, k, scope: searchScope, since, until } = parsed.data;
      const result = await searchMemoria(
        { workspaceId: workspace_id, query: q },
        { k, scope: searchScope, since, until },
        { embeddingClient: getEmbeddingClient() }
      );
      return result;
    });
  });
}
