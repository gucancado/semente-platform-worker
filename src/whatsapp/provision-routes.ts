import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { getNumber, renameNumberLabel, getNumberByInstance, setNumberLifecycle, normalizePhone } from './numbers.js';
import { createProvisioning, getProvisioning, deleteProvisioning } from './provisioning.js';
import { createProvisionLink, createReconnectLink, getProvisionLink, computeLinkState, incrementLinkClick, refundLinkClick, markLinkConsumed, generateLinkToken } from './provision-links.js';
import { createEvolutionInstance, ensureEvolutionInstance, getQrCode, getConnectionState, setInstanceWebhook, logoutInstance, deleteInstance, type EvolutionDeps } from '../evolution/client.js';
import { syncGroupSubjects } from './group-sync.js';
import { backfillNumber } from './backfill.js';
import { setGroupExposure } from './thread-meta.js';
import { tenantContext } from './tenant-context.js';

const PROVISION_TTL_SECONDS = 90;
const LINK_MAX_CLICKS = 10;
const LINK_TTL_DAYS = 7;

// O client da Evolution lança Error('Evolution GET /x → 404') — é o que dá pra
// inspecionar sem mudar o contrato dele.
function isEvolution404(e: unknown): boolean {
  return String((e as Error)?.message ?? e).includes('→ 404');
}

// Rate limit best-effort por token no GET de QR (defesa em profundidade sobre um
// token de 256 bits; polling legítimo = 24/min). Em memória, por processo — zera
// no deploy, e é isso mesmo: é teto contra polling eterno, não contabilidade.
const qrRate = new Map<string, { windowStart: number; count: number }>();
const QR_RATE_LIMIT = 40;
const QR_RATE_WINDOW_MS = 60_000;
export function qrRateExceeded(token: string, now = Date.now()): boolean {
  if (qrRate.size > 1000) qrRate.clear();
  const cur = qrRate.get(token);
  if (!cur || now - cur.windowStart >= QR_RATE_WINDOW_MS) {
    qrRate.set(token, { windowStart: now, count: 1 });
    return false;
  }
  cur.count += 1;
  return cur.count > QR_RATE_LIMIT;
}

// Nome de instância entra interpolado em paths do client da Evolution (sem
// encodeURIComponent — bug pré-existente). A allowlist impede esta rota de ampliá-lo.
const INSTANCE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

  // Cria instância Evolution + staging. Rollback do staging se a Evolution falhar.
  async function startProvision(workspaceId: string, createdBy: string | null, linkToken: string | null) {
    const instance = generateInstanceName(workspaceId);
    const prov = await createProvisioning(deps.pool, { evolutionInstance: instance, workspaceId, createdBy, ttlSeconds: PROVISION_TTL_SECONDS, provisionLinkToken: linkToken });
    try {
      await createEvolutionInstance(deps.evolution, instance, deps.webhook);
    } catch (e) {
      await deleteProvisioning(deps.pool, instance);
      try { await deleteInstance(deps.evolution, instance); } catch { /* idempotente */ }
      throw e;
    }
    return { instance, expiresAt: prov.expiresAt };
  }

  // Máquina de estados do status/QR, escopada a um workspace.
  // Anotação explícita: sem ela, o TS não preserva o literal `404` na narrowing
  // via `'code' in r` (o campo volta como `number | undefined`, não `404`).
  async function provisionStatus(instance: string, ws: string): Promise<{ code: 404 } | { body: Record<string, unknown> }> {
    const num = await getNumberByInstance(deps.pool, instance);
    if (num) {
      if (num.workspaceId !== ws) return { code: 404 as const };
      if (num.status === 'connected') return { body: { state: 'connected', numberId: num.id, phone: num.phone } };
    }
    const prov = await getProvisioning(deps.pool, instance);
    if (prov) {
      if (prov.workspaceId !== ws) return { code: 404 as const };
      if (prov.blockedWorkspaceId) return { body: { state: 'blocked', blockedWorkspaceId: prov.blockedWorkspaceId } };
      if (new Date(prov.expiresAt).getTime() < Date.now()) return { body: { state: 'expired' } };
      const qr = await getQrCode(deps.evolution, instance);
      return { body: { state: 'awaiting_scan', qr: qr.base64, pairingCode: qr.pairingCode } };
    }
    return { body: { state: 'gone' } };
  }

  // Onboarding QR-first: provisiona instância Evolution + staging (NÃO grava número).
  app.post('/admin/whatsapp/provision', async (req: any, reply) => {
    const { workspace_id } = req.body ?? {};
    if (!workspace_id || typeof workspace_id !== 'string') return reply.code(400).send({ error: 'workspace_id required' });
    return reply.send(await startProvision(workspace_id, req.actingUser, null));
  });

  // Status do provisionamento: QR enquanto aguarda; connected após o webhook commitar.
  app.get('/admin/whatsapp/provision/:instance', async (req: any, reply) => {
    const ws = req.query.workspace_id;
    if (!ws) return reply.code(400).send({ error: 'workspace_id required' });
    const r = await provisionStatus(String(req.params.instance), String(ws));
    if ('code' in r) return reply.code(r.code).send({ error: 'not found' });
    return reply.send(r.body);
  });

  // Abort: dropa staging + remove instância Evolution. Idempotente.
  app.delete('/admin/whatsapp/provision/:instance', async (req: any, reply) => {
    const instance = String(req.params.instance);
    try { await logoutInstance(deps.evolution, instance); await deleteInstance(deps.evolution, instance); } catch { /* idempotente */ }
    await deleteProvisioning(deps.pool, instance);
    return reply.send({ ok: true });
  });

  // Link de uso único: cria (painel logado; BCD já validou SSO+admin).
  app.post('/admin/whatsapp/provision-links', async (req: any, reply) => {
    const { workspace_id } = req.body ?? {};
    if (!workspace_id || typeof workspace_id !== 'string') return reply.code(400).send({ error: 'workspace_id required' });
    const token = generateLinkToken();
    const link = await createProvisionLink(deps.pool, { token, workspaceId: workspace_id, createdBy: req.actingUser, maxClicks: LINK_MAX_CLICKS, ttlDays: LINK_TTL_DAYS });
    return reply.send({ token: link.token, expiresAt: link.expiresAt, maxClicks: link.maxClicks });
  });

  /**
   * Emite link de RECONEXÃO. Exatamente UMA forma por chamada:
   *  - { number_id, workspace_id } → número de workspace. O proxy do painel valida
   *    admin via SSO; AQUI se confere que o número pertence ao workspace (autoridade
   *    final — sem isso, admin do workspace A emitiria link deslogado pra número do B).
   *  - { instance, label?, expected_phone } → instância de SISTEMA (ex.: saturno).
   *    Não exposta por proxy nenhum do painel; só o CLI a alcança.
   */
  app.post('/admin/whatsapp/reconnect-links', async (req: any, reply) => {
    const { number_id, workspace_id, instance, label, expected_phone } = req.body ?? {};
    if (number_id != null && instance != null) {
      return reply.code(400).send({ error: 'exactly_one_of_number_id_or_instance' });
    }

    let targetInstance: string;
    let targetLabel: string | null;
    let workspaceId: string | null;
    let expectedPhone: string | undefined;

    if (number_id != null) {
      // Obrigatório, não opcional: omitir não pode pular o controle de posse.
      if (typeof workspace_id !== 'string' || !workspace_id) {
        return reply.code(400).send({ error: 'workspace_id required' });
      }
      const n = await getNumber(deps.pool, Number(number_id));
      if (!n || n.workspaceId !== workspace_id) return reply.code(404).send({ error: 'not found' });
      expectedPhone = normalizePhone(n.phone);
      // Número que nunca conectou não tem telefone pra travar — e reconectar o
      // que nunca conectou é o fluxo de CONEXÃO, não este.
      if (!expectedPhone) return reply.code(409).send({ error: 'number_never_connected' });
      targetInstance = n.evolutionInstance;
      targetLabel = n.label ?? n.phone ?? null;
      workspaceId = n.workspaceId;
    } else if (typeof instance === 'string' && INSTANCE_NAME_RE.test(instance.trim())) {
      expectedPhone = normalizePhone(typeof expected_phone === 'string' ? expected_phone : undefined);
      if (!expectedPhone) return reply.code(400).send({ error: 'expected_phone required' });
      targetInstance = instance.trim();
      targetLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
      workspaceId = null;
    } else {
      return reply.code(400).send({ error: 'number_id or valid instance required' });
    }

    const token = generateLinkToken();
    const row = await createReconnectLink(deps.pool, {
      token, targetInstance, targetLabel, expectedPhone, workspaceId,
      createdBy: req.actingUser ?? null, maxClicks: LINK_MAX_CLICKS, ttlDays: LINK_TTL_DAYS,
    });
    return reply.send({ token, expiresAt: row.expiresAt, maxClicks: row.maxClicks });
  });

  // Estado do link (a página pública valida antes de renderizar o QR).
  app.get('/admin/whatsapp/provision-links/:token', async (req: any, reply) => {
    const link = await getProvisionLink(deps.pool, String(req.params.token));
    if (!link) return reply.code(404).send({ error: 'not found' });
    return reply.send({
      status: computeLinkState(link, Date.now()),
      workspaceId: link.workspaceId,
      clicksUsed: link.clicksUsed,
      maxClicks: link.maxClicks,
      expiresAt: link.expiresAt,
      targetInstance: link.targetInstance,
      targetLabel: link.targetLabel,
    });
  });

  // Provisiona VIA link: consome 1 clique e cria instância+staging no workspace do link.
  app.post('/admin/whatsapp/link/:token/provision', async (req: any, reply) => {
    const token = String(req.params.token);
    const link = await getProvisionLink(deps.pool, token);
    // Token de reconexão não entra aqui — e o guard precisa vir ANTES do clique,
    // senão queimaria orçamento de um link que esta rota nunca vai atender.
    if (!link || link.targetInstance) return reply.code(404).send({ error: 'not found' });
    const click = await incrementLinkClick(deps.pool, token);
    if (!click.ok) {
      const code = click.state === 'not_found' ? 404 : 409;
      return reply.code(code).send({ error: 'link_unavailable', state: click.state });
    }
    if (!click.workspaceId) return reply.code(404).send({ error: 'not found' }); // narrowing p/ TS; inalcançável com o guard acima
    try {
      return reply.send(await startProvision(click.workspaceId, req.actingUser, token));
    } catch (e) {
      // Evolution falhou após o clique já ter sido contado → devolve o clique ao orçamento.
      await refundLinkClick(deps.pool, token).catch(() => {});
      throw e;
    }
  });

  // Status/QR do provisionamento via link (workspace derivado do token).
  app.get('/admin/whatsapp/link/:token/provision/:instance', async (req: any, reply) => {
    const link = await getProvisionLink(deps.pool, String(req.params.token));
    if (!link) return reply.code(404).send({ error: 'not found' });
    if (link.targetInstance || !link.workspaceId) return reply.code(404).send({ error: 'not found' });
    const r = await provisionStatus(String(req.params.instance), link.workspaceId);
    if ('code' in r) return reply.code(r.code).send({ error: 'not found' });
    // Link expirado por TEMPO não serve mais QR novo, mesmo que o staging (TTL 90s) siga vivo.
    // 'exhausted' NÃO bloqueia: o 10º QR é válido e pode conectar. 'connected' sempre passa.
    if (computeLinkState(link, Date.now()) === 'expired' && (r.body as any)?.state === 'awaiting_scan') {
      return reply.send({ state: 'expired' });
    }
    return reply.send(r.body);
  });

  // Abort do provisionamento via link. Só aborta um staging que pertence a ESTE link/workspace
  // (senão qualquer token válido + um instance adivinhado abortaria provisionamento alheio — IDOR).
  app.delete('/admin/whatsapp/link/:token/provision/:instance', async (req: any, reply) => {
    const token = String(req.params.token);
    const instance = String(req.params.instance);
    const link = await getProvisionLink(deps.pool, token);
    if (!link) return reply.code(404).send({ error: 'not found' });
    // Esta rota DELETA instância quando o staging casa — token de reconexão
    // (que aponta pra instância viva do cliente) jamais pode alcançá-la.
    if (link.targetInstance || !link.workspaceId) return reply.code(404).send({ error: 'not found' });
    const prov = await getProvisioning(deps.pool, instance);
    // No-op idempotente se o staging não é deste link (não vaza existência de instances alheios).
    if (prov && prov.workspaceId === link.workspaceId && prov.provisionLinkToken === token) {
      try { await logoutInstance(deps.evolution, instance); await deleteInstance(deps.evolution, instance); } catch { /* idempotente */ }
      await deleteProvisioning(deps.pool, instance);
    }
    return reply.send({ ok: true });
  });

  // ── Reconexão por link: serve o QR de uma instância QUE JÁ EXISTE ──────────
  // Nunca cria (ensureEvolutionInstance criaria uma se o token apontasse pra uma
  // morta) e nunca deleta (não há abort — a instância é a do cliente, com histórico).
  // O consumo definitivo do link acontece no WEBHOOK (connection-events); aqui só o
  // atalho inequívoco de instância já open, onde não há pareamento novo a validar.
  app.post('/admin/whatsapp/link/:token/reconnect', async (req: any, reply) => {
    const token = String(req.params.token);
    const link = await getProvisionLink(deps.pool, token);
    // Cross-type é 404 (não 409): não vaza que o token existe com outro tipo.
    if (!link || !link.targetInstance) return reply.code(404).send({ error: 'not found' });
    const state = computeLinkState(link, Date.now());
    if (state !== 'active') return reply.code(409).send({ error: 'link_unavailable', state });

    let conn: 'open' | 'connecting' | 'close';
    try {
      conn = await getConnectionState(deps.evolution, link.targetInstance);
    } catch (e) {
      if (isEvolution404(e)) return reply.code(404).send({ error: 'instance_not_found' });
      return reply.code(502).send({ error: 'evolution_unavailable' });
    }
    if (conn === 'open') {
      await markLinkConsumed(deps.pool, token, null);
      return reply.send({ state: 'connected' });
    }

    const inc = await incrementLinkClick(deps.pool, token);
    if (!inc.ok) {
      const code = inc.state === 'not_found' ? 404 : 409;
      return reply.code(code).send({ error: 'link_unavailable', state: inc.state });
    }
    try {
      // Reafirma URL + secret + eventos — inclusive CONNECTION_UPDATE, que é o
      // pré-requisito de o webhook conseguir consumir este link. (O saturno hoje
      // só tem MESSAGES_UPSERT registrado; sem esta chamada, nada o liquidaria.)
      await setInstanceWebhook(deps.evolution, link.targetInstance, deps.webhook);
    } catch {
      await refundLinkClick(deps.pool, token).catch(() => {});
      return reply.code(502).send({ error: 'evolution_unavailable' });
    }
    return reply.send({ instance: link.targetInstance });
  });

  app.get('/admin/whatsapp/link/:token/reconnect/:instance', async (req: any, reply) => {
    const token = String(req.params.token);
    const instance = String(req.params.instance);
    const link = await getProvisionLink(deps.pool, token);
    // O path não endereça recurso fora do escopo do token (anti-IDOR).
    if (!link || !link.targetInstance || link.targetInstance !== instance) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (qrRateExceeded(token)) return reply.code(429).send({ error: 'rate_limited' });

    const state = computeLinkState(link, Date.now());
    // consumed ⇒ a instância conectou (é o ÚNICO caminho que consome reconexão) — sucesso, não erro.
    if (state === 'consumed') return reply.send({ state: 'connected' });
    if (state === 'blocked' || state === 'expired') return reply.send({ state });
    // active e exhausted seguem: o clique é gasto no POST, o GET serve a sessão
    // em andamento (paridade deliberada com o GET do provisionamento — o 10º QR vale).

    try {
      if ((await getConnectionState(deps.evolution, instance)) === 'open') {
        await markLinkConsumed(deps.pool, token, null);
        return reply.send({ state: 'connected' });
      }
      const qr = await getQrCode(deps.evolution, instance);
      return reply.send({ state: 'awaiting_scan', qr: qr.base64, pairingCode: qr.pairingCode });
    } catch {
      return reply.code(502).send({ error: 'evolution_unavailable' });
    }
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
    const ws = req.query.workspace_id;
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    if (ws && n.workspaceId !== ws) return reply.code(404).send({ error: 'not found' });
    try { await logoutInstance(deps.evolution, n.evolutionInstance); await deleteInstance(deps.evolution, n.evolutionInstance); } catch { /* idempotente */ }
    await setNumberLifecycle(deps.pool, n.id, { status: 'disconnected', removed: true });
    return reply.send({ id: n.id, status: 'disconnected', removed: true });
  });

  // Desconectar: encerra a sessão mas MANTÉM a instância (pra reconectar sem perder histórico).
  app.post('/admin/whatsapp/numbers/:id/disconnect', async (req: any, reply) => {
    const ws = req.body?.workspace_id;
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    if (ws && n.workspaceId !== ws) return reply.code(404).send({ error: 'not found' });
    try { await logoutInstance(deps.evolution, n.evolutionInstance); } catch { /* idempotente — fica disconnected mesmo assim */ }
    await setNumberLifecycle(deps.pool, n.id, { status: 'disconnected', removed: false });
    return reply.send({ id: n.id, status: 'disconnected' });
  });

  // Reconectar: garante instância + webhook; o painel puxa o QR via :id/qr e faz poll.
  app.post('/admin/whatsapp/numbers/:id/reconnect', async (req: any, reply) => {
    const ws = req.body?.workspace_id;
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    if (ws && n.workspaceId !== ws) return reply.code(404).send({ error: 'not found' });
    await ensureEvolutionInstance(deps.evolution, n.evolutionInstance, deps.webhook);
    return reply.send({ id: n.id, instance: n.evolutionInstance });
  });

  app.post('/admin/whatsapp/numbers/:id/sync-groups', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    const out = await syncGroupSubjects(deps.pool, deps.evolution, n.id);
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(n), ...out });
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
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(n), started: true, numberId: n.id, days, maxPages, sinceTs });
  });

  app.post('/admin/whatsapp/numbers/:id/group-exposure', async (req: any, reply) => {
    const n = await getNumber(deps.pool, Number(req.params.id));
    if (!n) return reply.code(404).send({ error: 'not found' });
    const expose = req.body?.expose === true;
    await setGroupExposure(deps.pool, { numberId: n.id, expose });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(n), id: n.id, expose_groups_in_mcp: expose });
  });
}
