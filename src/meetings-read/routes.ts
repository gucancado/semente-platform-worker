import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { MeetingDigestView } from './db.js';
import { requirePanelToken } from '../whatsapp/provision-routes.js';
import { listMeetings, getMeetingsStats, getMeetingTranscript, getMeetingDigest } from './db.js';

/**
 * Rotas REST `meetings_read_v1` de leitura de reuniões (listagem, stats, transcrição).
 * Auth: X-Panel-Token (mesmo padrão de src/whatsapp/provision-routes.js e
 * meetings-collect/routes.ts). Gate por MEETINGS_READ_ENABLED em index.ts.
 */
export function registerMeetingsReadRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string },
): void {
  const auth = requirePanelToken(deps.panelToken);

  app.get('/meetings-read', { preHandler: auth }, async (req: any, reply) => {
    const workspaceId = req.query?.workspace_id as string | undefined;
    if (!workspaceId) return reply.code(400).send({ error: 'workspace_id_required' });
    const limit = req.query?.limit ? Math.min(Number(req.query.limit), 500) : 200;
    const meetings = await listMeetings(deps.pool, {
      workspaceId, since: req.query?.since ?? null, until: req.query?.until ?? null, limit,
    });
    return reply.send({
      schema: 'meetings_read_v1',
      meetings: meetings.map((m) => ({
        collected_id: m.collected_id, episode_id: m.episode_id, meet_code: m.meet_code,
        status: m.status, failure_reason: m.failure_reason, title: m.title,
        occurred_at: m.occurred_at ? m.occurred_at.toISOString() : null,
        duration_seconds: m.duration_seconds, participants: m.participants,
        summary: m.summary,
      })),
    });
  });

  app.get('/meetings-read/stats', { preHandler: auth }, async (req: any, reply) => {
    const workspaceId = req.query?.workspace_id as string | undefined;
    const since = req.query?.since as string | undefined;
    const until = req.query?.until as string | undefined;
    if (!workspaceId || !since || !until) return reply.code(400).send({ error: 'params_required' });
    const stats = await getMeetingsStats(deps.pool, { workspaceId, since, until });
    return reply.send({ schema: 'meetings_read_v1', ...stats });
  });

  app.get('/meetings-read/:episodeId/transcript', { preHandler: auth }, async (req: any, reply) => {
    const workspaceId = req.query?.workspace_id as string | undefined;
    const episodeId = Number(req.params?.episodeId);
    if (!workspaceId || !Number.isFinite(episodeId)) return reply.code(400).send({ error: 'params_required' });
    const t = await getMeetingTranscript(deps.pool, { episodeId, workspaceId });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return reply.send({
      schema: 'meetings_read_v1',
      episode: serializeEpisode(t.episode),
      turns: t.turns,
    });
  });

  // Cabeçalho + digest SEM turnos. O digest é visível a qualquer membro do
  // workspace; a transcrição bruta continua restrita a admin. Por isso são duas
  // rotas e não um campo a mais na de transcrição: o conteúdo restrito não pode
  // sequer trafegar até o navegador de quem não pode vê-lo.
  app.get('/meetings-read/:episodeId/digest', { preHandler: auth }, async (req: any, reply) => {
    const workspaceId = req.query?.workspace_id as string | undefined;
    const episodeId = Number(req.params?.episodeId);
    if (!workspaceId || !Number.isFinite(episodeId)) return reply.code(400).send({ error: 'params_required' });
    const d = await getMeetingDigest(deps.pool, { episodeId, workspaceId });
    if (!d) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ schema: 'meetings_read_v1', episode: serializeEpisode(d) });
  });
}

function serializeEpisode(e: MeetingDigestView) {
  return {
    ...e,
    occurred_at: e.occurred_at.toISOString(),
    summary_generated_at: e.summary_generated_at ? e.summary_generated_at.toISOString() : null,
  };
}
