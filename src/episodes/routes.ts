import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import { requireOwnerToken } from '../admin/auth.js';
import { getEpisode, listEpisodes, updateEpisodeAttribution } from './db.js';
import { listDeadDeliveries, requeueDelivery } from '../events/outbox.js';
import { pool } from '../db.js';

const ListQuery = z.object({
  workspace_id: z.string().optional(),
  fonte: z.enum(['reuniao', 'whatsapp']).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  q: z.string().optional(),
  orphans: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
});

export async function registerEpisodesRoutes(app: FastifyInstance): Promise<void> {
  // ── Leitura: X-Agent-Token (Lua, Saturno, GUI) ──────────────────────────

  app.register(async (scope) => {
    scope.addHook('preHandler', requireAgentToken);

    scope.get('/episodes', async (req, reply) => {
      const q = ListQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: q.error.message });
      try {
        const page = await listEpisodes(q.data);
        return { schema: 'episodio_v1', ...page };
      } catch (err) {
        if (err instanceof Error && err.message === 'cursor inválido') {
          return reply.code(400).send({ error: 'cursor inválido' });
        }
        throw err;
      }
    });

    scope.get('/episodes/:id', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const id = Number(rawId);
      const ep = await getEpisode(id);
      if (!ep) return reply.code(404).send({ error: 'episódio não encontrado' });
      const { external_source, external_id, raw_r2_key, audio_r2_key, ...rest } = ep;
      return {
        schema: 'episodio_v1',
        ...rest,
        provenance: { external_source, external_id, raw_r2_key, audio_r2_key },
      };
    });

    scope.get('/episodes/:id/turns', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const id = Number(rawId);
      const { from, to } = req.query as { from?: string; to?: string };
      const { rows } = await pool.query(
        `SELECT turn_index, speaker_name, speaker_label, started_at_ms, ended_at_ms, text
           FROM episode_turns WHERE episode_id=$1
             AND turn_index >= COALESCE($2::int, 0)
             AND turn_index <= COALESCE($3::int, 2147483647)
           ORDER BY turn_index`,
        [id, from ?? null, to ?? null]
      );
      if (!rows.length) return reply.code(404).send({ error: 'sem turnos nessa janela' });
      return { schema: 'episodio_v1', episode_id: id, turns: rows };
    });
  });

  // ── Admin: X-Owner-Token ─────────────────────────────────────────────────

  app.register(async (scope) => {
    scope.addHook('preHandler', requireOwnerToken);

    scope.patch('/admin/episodes/:id/attribution', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const Body = z.object({
        workspace_id: z.string().min(1),
        project_slug: z.string().nullish(),
      });
      const b = Body.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: b.error.message });
      const ok = await updateEpisodeAttribution(
        Number(rawId),
        { ...b.data, by: 'owner' }
      );
      if (!ok) return reply.code(404).send({ error: 'episódio não encontrado' });
      return { ok: true };
    });

    scope.get('/admin/outbox/dead', async () => ({
      items: await listDeadDeliveries(),
    }));

    scope.post('/admin/outbox/deliveries/:id/replay', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const ok = await requeueDelivery(Number(rawId));
      if (!ok) return reply.code(404).send({ error: 'delivery não encontrada ou não está dead' });
      return { ok: true };
    });
  });
}
