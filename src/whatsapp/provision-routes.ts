import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { getNumber, updateNumberStatus, renameNumberLabel, getNumberByInstance } from './numbers.js';
import { createProvisioning, getProvisioning, deleteProvisioning } from './provisioning.js';
import { createEvolutionInstance, getQrCode, logoutInstance, deleteInstance, type EvolutionDeps } from '../evolution/client.js';
import { syncGroupSubjects } from './group-sync.js';
import { backfillNumber } from './backfill.js';
import { setGroupExposure } from './thread-meta.js';

const PROVISION_TTL_SECONDS = 90;

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

  // Onboarding QR-first: provisiona instância Evolution + staging (NÃO grava número).
  app.post('/admin/whatsapp/provision', async (req: any, reply) => {
    const { workspace_id } = req.body ?? {};
    if (!workspace_id || typeof workspace_id !== 'string') return reply.code(400).send({ error: 'workspace_id required' });
    const instance = generateInstanceName(workspace_id);
    const prov = await createProvisioning(deps.pool, { evolutionInstance: instance, workspaceId: workspace_id, createdBy: req.actingUser, ttlSeconds: PROVISION_TTL_SECONDS });
    try {
      await createEvolutionInstance(deps.evolution, instance, deps.webhook);
    } catch (e) {
      await deleteProvisioning(deps.pool, instance);
      try { await deleteInstance(deps.evolution, instance); } catch { /* idempotente */ }
      throw e;
    }
    return reply.send({ instance, expiresAt: prov.expiresAt });
  });

  // Status do provisionamento: QR enquanto aguarda; connected após o webhook commitar.
  app.get('/admin/whatsapp/provision/:instance', async (req: any, reply) => {
    const instance = String(req.params.instance);
    const ws = req.query.workspace_id;
    if (!ws) return reply.code(400).send({ error: 'workspace_id required' });
    const num = await getNumberByInstance(deps.pool, instance);
    if (num) {
      if (num.workspaceId !== ws) return reply.code(404).send({ error: 'not found' });
      if (num.status === 'connected') return reply.send({ state: 'connected', numberId: num.id, phone: num.phone });
    }
    const prov = await getProvisioning(deps.pool, instance);
    if (prov) {
      if (prov.workspaceId !== ws) return reply.code(404).send({ error: 'not found' });
      if (new Date(prov.expiresAt).getTime() < Date.now()) return reply.send({ state: 'expired' });
      const qr = await getQrCode(deps.evolution, instance);
      return reply.send({ state: 'awaiting_scan', qr: qr.base64, pairingCode: qr.pairingCode });
    }
    return reply.send({ state: 'gone' });
  });

  // Abort: dropa staging + remove instância Evolution. Idempotente.
  app.delete('/admin/whatsapp/provision/:instance', async (req: any, reply) => {
    const instance = String(req.params.instance);
    try { await logoutInstance(deps.evolution, instance); await deleteInstance(deps.evolution, instance); } catch { /* idempotente */ }
    await deleteProvisioning(deps.pool, instance);
    return reply.send({ ok: true });
  });

  // Rename do label. Vazio → label = telefone (nunca null pra número conectado).
  app.patch('/admin/whatsapp/numbers/:id/label', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    const raw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const label = raw || n.phone || null;
    await renameNumberLabel(deps.pool, n.id, label);
    return reply.send({ id: n.id, label });
  });

  // Fluxo antigo (grava-antes-de-conectar) aposentado pelo QR-first.
  app.post('/admin/whatsapp/numbers', async (_req: any, reply) => {
    return reply.code(410).send({ error: 'deprecated', use: 'POST /admin/whatsapp/provision' });
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

  app.post('/admin/whatsapp/numbers/:id/group-exposure', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    const expose = req.body?.expose === true;
    await setGroupExposure(deps.pool, { numberId: n.id, expose });
    return reply.send({ schema: 'whatsapp_v1', id: n.id, expose_groups_in_mcp: expose });
  });
}
