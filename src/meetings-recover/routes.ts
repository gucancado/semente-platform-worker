import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { insertSpeakerActivity } from './db.js';
import { parseSpeakerActivityBody } from './speaker-activity.js';

function tokenOk(got: unknown, want: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  // Tamanho ANTES: timingSafeEqual lança com buffers de tamanhos diferentes.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `POST /meetings-collect/speaker-activity` — o bot da Vexa (preload no launcher,
 * ops/vexa/) envia "NOME falou de T1 a T2". Auth própria (`X-Speaker-Token`),
 * não o token do painel: quem chama é o container da Vexa, e ele não deve poder
 * fazer mais nada no worker.
 */
export function registerSpeakerActivityRoute(app: FastifyInstance, deps: { pool: Pool; token: string }): void {
  app.post('/meetings-collect/speaker-activity', async (req: any, reply) => {
    if (!tokenOk(req.headers['x-speaker-token'], deps.token)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = parseSpeakerActivityBody(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    let vexaId = parsed.meetingId;
    if (vexaId == null && parsed.nativeMeetingId) {
      const r = await deps.pool.query<{ vexa_meeting_id: number }>(
        `SELECT vexa_meeting_id FROM collected_meetings
          WHERE meet_code = $1 AND vexa_meeting_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [parsed.nativeMeetingId],
      );
      vexaId = r.rows[0]?.vexa_meeting_id ?? null;
    }
    if (vexaId == null) return reply.code(404).send({ error: 'meeting_not_found' });
    const n = await insertSpeakerActivity(deps.pool, vexaId, parsed.events);
    return reply.send({ ok: true, inserted: n });
  });
}
