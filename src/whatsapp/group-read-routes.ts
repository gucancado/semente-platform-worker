import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listLinkedGroups, resolveLinkedGroup, type LinkedGroup } from './group-links.js';
import { listThreadMessages } from './read-queries.js';
import { exportConversation } from './export.js';
import { listParticipants } from './group-participants.js';
import { presignGet, whatsappMediaBucket } from '../integrations/r2.js';
import { requirePanelToken } from './provision-routes.js';
import { defaultRouteAuthz, gateAdmin, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { emptyToUndefined } from './query-coerce.js';

/**
 * Contrato `group_v1` — leitura READ-ONLY da conversa de um grupo de WhatsApp
 * INTERNO da equipe, no contexto do workspace do CLIENTE sobre o qual o grupo
 * conversa. NÃO é o CRM de atendimento (esse é `read-routes.ts`, number-centric,
 * com triagem/oportunidades): aqui um único número (saturno) serve N workspaces,
 * e quem autoriza é o VÍNCULO grupo→workspace, não a membership no workspace do
 * número.
 *
 * Ordem de checagem, em TODA rota com :jid (a ordem é o gate de privacidade):
 *   1. workspace_id ausente        → 400
 *   2. x-acting-user ausente       → 400
 *   3. gateAdmin(workspace_id)     → 401/403/500
 *   4. vínculo (jid, workspace)    → 404 group_not_linked
 *   5. dados
 * O gate ANTES da resolução é deliberado: um não-admin recebe 403 sem descobrir
 * se aquele grupo existe.
 */

/** Envelope comum; `number` é o do saturno (informativo, não é escopo de autz). */
function groupContext(g: LinkedGroup) {
  return { workspaceId: g.linkedWorkspaceId, group: { jid: g.jid, subject: g.subject }, numberId: g.numberId };
}

/**
 * Roster com `avatarKey` (interno) trocado por `avatarUrl` presigned (público).
 * Presign curto (120s) — o mesmo TTL da rota de áudio. Falha de R2 não derruba
 * o roster: o avatar cai pras iniciais no lugar de quebrar a resposta inteira.
 */
async function withAvatarUrls(raw: Awaited<ReturnType<typeof listParticipants>>) {
  return Promise.all(raw.map(async (p) => {
    let avatarUrl: string | null = null;
    if (p.avatarKey) {
      try { avatarUrl = await presignGet(p.avatarKey, 120, whatsappMediaBucket()!); } catch { avatarUrl = null; }
    }
    const { avatarKey: _omit, ...rest } = p;
    return { ...rest, avatarUrl };
  }));
}

export function registerGroupReadRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string; authz?: RouteAuthz; logAccess?: LogAccessFn },
) {
  const authz = deps.authz ?? defaultRouteAuthz;
  const logAccess = deps.logAccess ?? defaultLogAccess;
  const auth = requirePanelToken(deps.panelToken);

  /**
   * Passos 1-5 comuns. Devolve o grupo, ou null quando a resposta já foi enviada.
   *
   * O gate roda no `workspace_id` que o CALLER alegou (query param) — não no
   * `linkedWorkspaceId` do banco, que só existe depois de resolver. A igualdade
   * entre os dois é garantida pelo predicado de `resolveLinkedGroup`, não pelo
   * gate. Gatear no valor do banco inverteria a ordem e revelaria a existência
   * do grupo a quem não pode lê-lo.
   */
  async function gateAndResolve(req: any, reply: any): Promise<LinkedGroup | null> {
    const ws = emptyToUndefined(req.query.workspace_id);
    if (!ws) { reply.code(400).send({ error: 'workspace_id required' }); return null; }
    if (!req.actingUser) { reply.code(400).send({ error: 'x-acting-user required' }); return null; }
    if (!await gateAdmin(req, reply, ws, authz)) return null;
    const g = await resolveLinkedGroup(deps.pool, ws, req.params.jid);
    if (!g) { reply.code(404).send({ error: 'group_not_linked' }); return null; }
    // Gate 2 — EQUIPE. Ver comentário de `assertTeamMember`.
    if (!await gateTeam(req, reply, g, authz)) return null;
    return g;
  }

  /**
   * Segundo gate: o ator também precisa ser MEMBRO do workspace do NÚMERO.
   *
   * Por que não basta "admin do workspace do cliente": o workspace do cliente no
   * Bloquim pode ter pessoas do próprio cliente, inclusive como admin — e o que
   * esta rota devolve é a conversa INTERNA da equipe *sobre* esse cliente.
   * Sozinho, o gate de admin entregaria essa conversa exatamente a quem ela
   * discute. Ser membro do workspace do número interno (saturno) é a definição
   * operacional de "é da equipe", e o cliente nunca é.
   *
   * 403 sem distinguir de "não é admin": quem não passa aqui não deve aprender
   * que o vínculo existe.
   */
  async function gateTeam(req: any, reply: any, g: LinkedGroup, authzImpl: RouteAuthz): Promise<boolean> {
    try {
      await authzImpl.assertMember(req.actingUser, g.numberWorkspaceId);
      return true;
    } catch {
      reply.code(403).send({ error: 'forbidden' });
      return false;
    }
  }

  // ── GET /whatsapp/groups ─────────────────────────────────────────────────────
  // Grupos vinculados ao workspace. Sem vínculo → 200 com lista vazia (é lista).
  app.get('/whatsapp/groups', { preHandler: auth }, async (req: any, reply) => {
    const ws = emptyToUndefined(req.query.workspace_id);
    if (!ws) return reply.code(400).send({ error: 'workspace_id required' });
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    if (!await gateAdmin(req, reply, ws, authz)) return;
    const linked = await listLinkedGroups(deps.pool, ws);
    // Gate 2 (equipe) por grupo: sem ser membro do workspace do número, o grupo
    // simplesmente não entra na lista — mesma política do gateTeam das rotas
    // individuais, sem revelar nada por diferença de resposta.
    const allowed = [];
    for (const g of linked) {
      try {
        await authz.assertMember(req.actingUser, g.numberWorkspaceId);
        allowed.push(g);
      } catch { /* não é da equipe → o grupo não existe pra ele */ }
    }
    const groups = [];
    for (const g of allowed) {
      // Última mensagem + contagem por grupo. Escopo pelo NÚMERO (é onde as
      // mensagens vivem), nunca por workspace_id = <cliente>. `lastText` é
      // CONTEÚDO de conversa, não metadado: o filtro triplo aqui é a mesma
      // fronteira de isolamento da rota de mensagens, não uma otimização.
      const { rows } = await deps.pool.query(
        `SELECT MAX(created_at) AS last_at, COUNT(*)::int AS count,
                (ARRAY_AGG(text ORDER BY created_at DESC))[1] AS last_text
           FROM messages
          WHERE whatsapp_number_id = $1 AND workspace_id = $2 AND identifier = $3`,
        [g.numberId, g.numberWorkspaceId, g.jid],
      );
      const r = rows[0] ?? {};
      groups.push({
        jid: g.jid,
        subject: g.subject,
        lastAt: r.last_at ? r.last_at.toISOString() : null,
        lastText: r.last_text ?? null,
        messageCount: Number(r.count ?? 0),
      });
    }
    groups.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
    logAccess(deps.pool, { actor: req.actingUser, action: 'group_list', workspaceId: ws });
    return reply.send({ schema: 'group_v1', context: { workspaceId: ws }, groups });
  });

  // ── GET /whatsapp/groups/:jid/messages ───────────────────────────────────────
  app.get('/whatsapp/groups/:jid/messages', { preHandler: auth }, async (req: any, reply) => {
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    const { limit, cursor } = req.query;
    const result = await listThreadMessages(deps.pool, {
      workspaceId: g.numberWorkspaceId,   // DADOS: workspace do número
      numberId: g.numberId,
      identifier: g.jid,
      limit: Number(limit ?? 50),
      cursor: emptyToUndefined(cursor),
    });
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_messages',
      workspaceId: g.linkedWorkspaceId,   // AUDITORIA: workspace do cliente
      numberId: g.numberId, identifier: g.jid,
    });
    return reply.send({ schema: 'group_v1', context: groupContext(g), ...result });
  });

  // ── GET /whatsapp/groups/:jid/export ─────────────────────────────────────────
  app.get('/whatsapp/groups/:jid/export', { preHandler: auth }, async (req: any, reply) => {
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    const { since, until, max_messages, order } = req.query;
    const ord = order === 'head' || order === 'tail' ? order : undefined;
    const out = await exportConversation(deps.pool, {
      workspaceId: g.numberWorkspaceId,
      numberId: g.numberId,
      identifier: g.jid,
      since: emptyToUndefined(since),
      until: emptyToUndefined(until),
      maxMessages: max_messages ? Number(max_messages) : undefined,
      order: ord,
    });
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_export',
      workspaceId: g.linkedWorkspaceId, numberId: g.numberId, identifier: g.jid,
      meta: { messageCount: out.messageCount },
    });
    return reply.send({ schema: 'group_v1', context: groupContext(g), ...out });
  });

  // ── GET /whatsapp/groups/:jid/participants ───────────────────────────────────
  app.get('/whatsapp/groups/:jid/participants', { preHandler: auth }, async (req: any, reply) => {
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    const raw = await listParticipants(deps.pool, g.id);
    const participants = await withAvatarUrls(raw);
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_participants',
      workspaceId: g.linkedWorkspaceId, numberId: g.numberId, identifier: g.jid,
    });
    return reply.send({ schema: 'group_v1', context: groupContext(g), participants });
  });

  // ── GET /whatsapp/groups/:jid/view ───────────────────────────────────────────
  // Agregador do que a PÁGINA precisa: mensagens + roster num gate só.
  //
  // Não é açúcar: `assertActorAdmin` é deliberadamente NÃO-cacheado
  // (`src/whatsapp/authz.ts` — "Intentionally bypass and do not populate the
  // shared cache"), então cada rota chamada custa um POST fresco ao bloquim-api.
  // A página precisa de grupo + mensagens + participantes; em rotas separadas
  // seriam 3 pares de gates por render, somados ao que o layout já faz.
  app.get('/whatsapp/groups/:jid/view', { preHandler: auth }, async (req: any, reply) => {
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    const [msgs, rawParticipants] = await Promise.all([
      listThreadMessages(deps.pool, {
        workspaceId: g.numberWorkspaceId, numberId: g.numberId, identifier: g.jid,
        limit: Number(req.query.limit ?? 50), cursor: emptyToUndefined(req.query.cursor),
      }),
      listParticipants(deps.pool, g.id),
    ]);
    const participants = await withAvatarUrls(rawParticipants);
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_messages',
      workspaceId: g.linkedWorkspaceId, numberId: g.numberId, identifier: g.jid,
    });
    return reply.send({
      schema: 'group_v1', context: groupContext(g),
      group: { jid: g.jid, subject: g.subject },
      ...msgs, participants,
    });
  });
}
