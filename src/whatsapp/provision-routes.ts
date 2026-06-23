import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { createNumber, getNumber, updateNumberStatus } from './numbers.js';
import { createEvolutionInstance, getQrCode, logoutInstance, deleteInstance, type EvolutionDeps } from '../evolution/client.js';
import { syncGroupSubjects } from './group-sync.js';
import { backfillNumber } from './backfill.js';

export function generateInstanceName(workspaceId: string) {
  return `ws-${workspaceId.replace(/-/g, '').slice(0, 8)}-${randomBytes(4).toString('hex')}`;
}

export function requirePanelToken(panelToken: string) {
  return async (req: any, reply: any) => {
    if (req.headers['x-panel-token'] !== panelToken) return reply.code(401).send({ error: 'unauthorized' });
    req.actingUser = req.headers['x-acting-user'] ?? null; // auditoria
  };
}

export function registerProvisionRoutes(app: FastifyInstance, deps: { pool: Pool; evolution: EvolutionDeps; panelToken: string; webhook: { url: string; secret: string } }) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/admin/whatsapp/')) return requirePanelToken(deps.panelToken)(req, reply);
  });

  app.post('/admin/whatsapp/numbers', async (req: any, reply) => {
    const { workspace_id, label } = req.body ?? {};
    if (!workspace_id || typeof workspace_id !== 'string') return reply.code(400).send({ error: 'workspace_id required' });
    const instance = generateInstanceName(workspace_id);
    // INSERT primeiro (P0.3): garante que connection.update encontre a linha.
    const n = await createNumber(deps.pool, { workspaceId: workspace_id, evolutionInstance: instance, label: label ?? null, createdBy: req.actingUser });
    await updateNumberStatus(deps.pool, instance, { status: 'connecting' });
    try { await createEvolutionInstance(deps.evolution, instance, deps.webhook); }
    catch (e) { await updateNumberStatus(deps.pool, instance, { status: 'disconnected' }); throw e; }
    return reply.code(201).send({ id: n.id, evolution_instance: instance, status: 'connecting' });
  });

  app.get('/admin/whatsapp/numbers/:id/qr', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    return reply.send(await getQrCode(deps.evolution, n.evolutionInstance));
  });

  app.delete('/admin/whatsapp/numbers/:id', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    try { await logoutInstance(deps.evolution, n.evolutionInstance); await deleteInstance(deps.evolution, n.evolutionInstance); } catch { /* idempotente */ }
    await updateNumberStatus(deps.pool, n.evolutionInstance, { status: 'disconnected' });
    return reply.send({ status: 'disconnected' });
  });

  app.post('/admin/whatsapp/numbers/:id/sync-groups', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    const out = await syncGroupSubjects(deps.pool, deps.evolution, n.id);
    return reply.send({ schema: 'whatsapp_v1', ...out });
  });

  app.post('/admin/whatsapp/numbers/:id/backfill', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    const days = Number(req.body?.days ?? 30);
    const maxPages = Number(req.body?.maxPages ?? 200);
    const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
    // Background fire-and-forget — pode demorar (muitas páginas). Idempotente (dedup), pode re-disparar.
    backfillNumber(deps.pool, deps.evolution, n.id, { sinceTs, maxPages, log: (m) => req.log.info(m) })
      .catch((err) => req.log.error({ err: (err as Error).message }, '[backfill] falhou'));
    return reply.send({ schema: 'whatsapp_v1', started: true, numberId: n.id, days, maxPages, sinceTs });
  });
}
