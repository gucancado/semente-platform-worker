import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from '../whatsapp/provision-routes.js';
import type { VexaClient } from '../integrations/vexa/client.js';
import type { MeetingsCollectDeps } from './service.js';
import { importCollectedMeeting } from './service.js';
import {
  createCollectedMeeting, getActiveCollectedMeeting, getCollectedMeeting,
  updateCollectedMeeting, isEpisodeFrozen, reattributeEpisode,
} from './db.js';

const MEET_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * Rotas REST `meetings_v1` de coleta manual de reuniões (Vexa). Auth: X-Panel-Token
 * (mesmo padrão de src/whatsapp/provision-routes.js). Vexa Lite = 1 coleta simultânea
 * (GLOBAL, qualquer workspace) → 409 collection_active. Re-atribuição congela após
 * destilação Lua (existência de facts) → 409 attribution_frozen.
 */
export function registerMeetingsCollectRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string; vexa: Pick<VexaClient, 'sendBot' | 'getTranscript' | 'stopBot'>; collectDeps: MeetingsCollectDeps; botName?: string },
): void {
  const auth = requirePanelToken(deps.panelToken);
  const botName = deps.botName ?? 'BeeAds Notetaker';

  app.post('/meetings-collect', { preHandler: auth }, async (req: any, reply) => {
    const meetCode: string | undefined = req.body?.meetCode;
    const workspaceId: string | null = req.body?.workspaceId ?? null;
    if (!meetCode || !MEET_RE.test(meetCode)) return reply.code(400).send({ error: 'invalid_meet_code' });
    const active = await getActiveCollectedMeeting(deps.pool);
    if (active) return reply.code(409).send({ error: 'collection_active', message: 'Já existe uma reunião sendo coletada.' });

    const row = await createCollectedMeeting(deps.pool, { meetCode, workspaceId, requestedBy: req.actingUser ?? 'unknown' });
    try {
      const meeting = await deps.vexa.sendBot(meetCode, botName, 'pt');
      await updateCollectedMeeting(deps.pool, row.id, { vexaMeetingId: meeting.id });
      return reply.send({ schema: 'meetings_v1', id: row.id, status: 'collecting', meet_code: meetCode, vexa_meeting_id: meeting.id });
    } catch (err) {
      // Falha ao mandar o bot pro Meet: best-effort — a row já foi criada; marca failed
      // em vez de deixar 'collecting' pendurada bloqueando o slot global.
      await updateCollectedMeeting(deps.pool, row.id, { status: 'failed', failureReason: 'vexa_send_failed' });
      return reply.code(502).send({ error: 'vexa_send_failed', message: (err as Error).message });
    }
  });

  app.get('/meetings-collect/:id', { preHandler: auth }, async (req: any, reply) => {
    const row = await getCollectedMeeting(deps.pool, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    let segment_count: number | null = null;
    let speakers: string[] | null = null;
    let participants: Array<{ name: string; segments: number }> | null = null;
    let occurred_at: string | null = null;
    let duration_seconds: number | null = null;

    if (row.status === 'collecting' || row.status === 'stopping') {
      try {
        const m = await deps.vexa.getTranscript(row.meet_code);
        segment_count = m.segments?.length ?? 0;
        speakers = [...new Set((m.segments ?? []).map((s) => s.speaker).filter(Boolean) as string[])];
      } catch {
        // Vexa indisponível — devolve snapshot parcial (sem segment_count/speakers ao vivo).
      }
    } else if (row.status === 'imported' && row.episode_id) {
      const ep = await deps.pool.query('SELECT metadata, occurred_at, duration_seconds FROM episodes WHERE id=$1', [row.episode_id]);
      const meta = (ep.rows[0]?.metadata ?? {}) as { speaker_counts?: Record<string, number> };
      const counts = meta.speaker_counts ?? {};
      participants = Object.entries(counts).map(([name, segments]) => ({ name, segments }));
      occurred_at = ep.rows[0]?.occurred_at ? new Date(ep.rows[0].occurred_at).toISOString() : null;
      duration_seconds = ep.rows[0]?.duration_seconds ?? null;
    }

    return reply.send({
      schema: 'meetings_v1', id: row.id, status: row.status, meet_code: row.meet_code,
      vexa_meeting_id: row.vexa_meeting_id, episode_id: row.episode_id, failure_reason: row.failure_reason,
      segment_count, speakers, participants, occurred_at, duration_seconds,
    });
  });

  app.post('/meetings-collect/:id/stop', { preHandler: auth }, async (req: any, reply) => {
    const row = await getCollectedMeeting(deps.pool, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.status !== 'collecting' && row.status !== 'stopping') {
      return reply.send({ schema: 'meetings_v1', id: row.id, status: row.status });
    }
    await updateCollectedMeeting(deps.pool, row.id, { status: 'stopping' });
    await deps.vexa.stopBot(row.meet_code).catch(() => {});
    let meeting: Awaited<ReturnType<typeof deps.vexa.getTranscript>> | null;
    try { meeting = await deps.vexa.getTranscript(row.meet_code); } catch { meeting = null; }
    if (meeting && (meeting.segments?.length ?? 0) > 0) {
      await importCollectedMeeting(deps.collectDeps, row, meeting);
    } else {
      await updateCollectedMeeting(deps.pool, row.id, { status: 'canceled', failureReason: 'stopped_empty' });
    }
    const updated = await getCollectedMeeting(deps.pool, row.id);
    return reply.send({ schema: 'meetings_v1', id: updated!.id, status: updated!.status, episode_id: updated!.episode_id });
  });

  app.patch('/meetings-collect/:id/attribution', { preHandler: auth }, async (req: any, reply) => {
    const row = await getCollectedMeeting(deps.pool, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const workspaceId: string | null = req.body?.workspaceId ?? null;

    if (row.episode_id) {
      if (workspaceId && (await isEpisodeFrozen(deps.pool, row.episode_id))) {
        return reply.code(409).send({ error: 'attribution_frozen', message: 'Reunião já destilada; atribuição congelada.' });
      }
      if (workspaceId) await reattributeEpisode(deps.pool, row.episode_id, workspaceId);
    }
    // `updateCollectedMeeting` não tem coluna workspace_id no patch (W3) — toca updated_at
    // e grava workspace_id à parte. Ver nota do brief da task W5.
    await updateCollectedMeeting(deps.pool, row.id, {});
    await deps.pool.query('UPDATE collected_meetings SET workspace_id=$2 WHERE id=$1', [row.id, workspaceId]);
    const updated = await getCollectedMeeting(deps.pool, row.id);
    return reply.send({ schema: 'meetings_v1', id: updated!.id, status: updated!.status, workspace_id: updated!.workspace_id, episode_id: updated!.episode_id });
  });
}
