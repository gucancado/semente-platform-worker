import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { MeetingDigestView } from './db.js';
import { requirePanelToken } from '../whatsapp/provision-routes.js';
import { listMeetings, getMeetingsStats, getMeetingTranscript, getMeetingDigest, listFailedCollections, renameEpisodeSpeaker } from './db.js';
import { failureLabel } from './failure-label.js';
import { getEpisodeAudio } from '../meetings-audio/db.js';
import { AUDIO_URL_TTL_S, audioDownloadName } from '../meetings-audio/core.js';
import { presignGet } from '../integrations/r2.js';

/**
 * Rotas REST `meetings_read_v1` de leitura de reuniões (listagem, stats, transcrição).
 * Auth: X-Panel-Token (mesmo padrão de src/whatsapp/provision-routes.js e
 * meetings-collect/routes.ts). Gate por MEETINGS_READ_ENABLED em index.ts.
 */
export function registerMeetingsReadRoutes(
  app: FastifyInstance,
  // admissionTimeoutMin entra no rótulo do silent_room (o número está na frase).
  deps: { pool: Pool; panelToken: string; admissionTimeoutMin?: number },
): void {
  const auth = requirePanelToken(deps.panelToken);

  app.get('/meetings-read', { preHandler: auth }, async (req: any, reply) => {
    const workspaceId = req.query?.workspace_id as string | undefined;
    if (!workspaceId) return reply.code(400).send({ error: 'workspace_id_required' });
    const limit = req.query?.limit ? Math.min(Number(req.query.limit), 500) : 200;
    const since = req.query?.since ?? null;
    const until = req.query?.until ?? null;
    const includeFailed = req.query?.include_failed === '1' || req.query?.include_failed === 'true';
    const [meetings, failed] = await Promise.all([
      listMeetings(deps.pool, { workspaceId, since, until, limit }),
      includeFailed ? listFailedCollections(deps.pool, { workspaceId, since, until, limit }) : Promise.resolve(null),
    ]);
    const timeout = { admissionTimeoutMin: deps.admissionTimeoutMin ?? 10 };
    return reply.send({
      schema: 'meetings_read_v1',
      meetings: meetings.map((m) => ({
        collected_id: m.collected_id, episode_id: m.episode_id, meet_code: m.meet_code,
        status: m.status, failure_reason: m.failure_reason, title: m.title,
        occurred_at: m.occurred_at ? m.occurred_at.toISOString() : null,
        duration_seconds: m.duration_seconds, participants: m.participants,
        summary: m.summary, speakers: m.speakers,
      })),
      // Chave só existe com include_failed: consumidor antigo não vê mudança.
      ...(failed ? {
        failed: failed.map((f) => ({
          collected_id: f.collected_id, meet_code: f.meet_code, title: f.title,
          status: f.status, failure_reason: f.failure_reason,
          failure_label: failureLabel(f.failure_reason, timeout),
          failure_detail: f.failure_detail, vexa_status: f.vexa_status,
          requested_at: new Date(f.requested_at).toISOString(),
          started_at: f.started_at ? new Date(f.started_at).toISOString() : null,
          ended_at: new Date(f.ended_at).toISOString(),
        })),
      } : {}),
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

  // Nomear falante: troca o nome em TODOS os turnos do episódio. Única escrita
  // deste contrato; quem decide que só admin nomeia é o painel (mesmo critério
  // de quem vê a transcrição).
  app.patch('/meetings-read/:episodeId/speakers', { preHandler: auth }, async (req: any, reply) => {
    const episodeId = Number(req.params?.episodeId);
    const workspaceId = req.body?.workspace_id;
    const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!Number.isFinite(episodeId) || typeof workspaceId !== 'string' || !workspaceId) {
      return reply.code(400).send({ error: 'params_required' });
    }
    if (!from || !to || to.length > 120 || from === to) return reply.code(400).send({ error: 'invalid_names' });
    const r = await renameEpisodeSpeaker(deps.pool, { episodeId, workspaceId, from, to });
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ schema: 'meetings_read_v1', ok: true, turns: r.turns });
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

  // Link assinado do áudio. Visível a qualquer membro do workspace, como o digest
  // (decisão do owner, 2026-09-24); a autorização por usuário é do painel, e aqui
  // vale a de tenant. `download=1` assina com Content-Disposition de anexo.
  app.get('/meetings-read/:episodeId/audio', { preHandler: auth }, async (req: any, reply) => {
    const workspaceId = req.query?.workspace_id as string | undefined;
    const episodeId = Number(req.params?.episodeId);
    if (!workspaceId || !Number.isFinite(episodeId)) return reply.code(400).send({ error: 'params_required' });
    const a = await getEpisodeAudio(deps.pool, { episodeId, workspaceId });
    if (!a) return reply.code(404).send({ error: 'not_found' });
    const download = req.query?.download === '1';
    const url = await presignGet(a.key, AUDIO_URL_TTL_S, undefined, download
      ? { contentDisposition: `attachment; filename="${audioDownloadName(episodeId, a.occurredAt, a.key)}"` }
      : undefined);
    return reply.send({ schema: 'meetings_read_v1', url });
  });
}

function serializeEpisode(e: MeetingDigestView) {
  return {
    ...e,
    occurred_at: e.occurred_at.toISOString(),
    summary_generated_at: e.summary_generated_at ? e.summary_generated_at.toISOString() : null,
  };
}
