import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listLinkedGroups, resolveLinkedGroup, type LinkedGroup } from './group-links.js';
import { listThreadMessages } from './read-queries.js';
import { listGroupMessagesByAgent } from './group-agent-messages.js';
import { exportConversation } from './export.js';
import { listParticipants, type GroupParticipant } from './group-participants.js';
import { presignGet, whatsappMediaBucket } from '../integrations/r2.js';
import { requirePanelToken } from './provision-routes.js';
import { defaultRouteAuthz, gateAdmin, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { emptyToUndefined } from './query-coerce.js';
import { searchGroupMessages, resolveAnchor, listMessagesAround } from './group-search.js';

/**
 * Contrato `group_v1` — leitura READ-ONLY da conversa de um grupo de WhatsApp
 * INTERNO da equipe, no contexto do workspace do CLIENTE sobre o qual o grupo
 * conversa. NÃO é o CRM de atendimento (esse é `read-routes.ts`, number-centric,
 * com triagem/oportunidades): aqui um único número/agente interno serve N
 * workspaces, e quem autoriza é o VÍNCULO grupo→workspace.
 *
 * Ordem de checagem, em TODA rota com :jid (a ordem é o gate de privacidade):
 *   1. workspace_id ausente        → 400
 *   2. x-acting-user ausente       → 400
 *   3. gateAdmin(workspace_id)     → 401/403/500
 *   4. vínculo (jid, workspace)    → 404 group_not_linked
 *   5. dados
 * O gate ANTES da resolução é deliberado: um não-admin recebe 403 sem descobrir
 * se aquele grupo existe.
 *
 * ⚠️ GATE 2 REMOVIDO (decisão de produto, 2026-08-11): havia um segundo gate
 * aqui ("é membro do workspace do NÚMERO ⇒ é da equipe") que barrava um admin
 * do workspace do CLIENTE de ler a conversa interna sobre ele — só que o
 * número real que monitora os grupos é da ORGANIZAÇÃO, não tem workspace
 * próprio, e não vai ganhar um tão cedo. Sem um "workspace do número" pra
 * checar, o gate não tinha mais como funcionar. A autorização hoje é SÓ
 * admin do workspace vinculado (gate 1 acima) — o dono do produto aceitou
 * conscientemente o risco de um admin do cliente ver essa conversa. Não
 * reintroduzir sem uma decisão de produto nova (ver `group-links.ts`).
 */

/**
 * Envelope comum. `numberId` é informativo (não é escopo de autz) e só existe
 * no escopo 'number' — no escopo 'agent' (grupo da organização, sem número)
 * fica `null`. `scope` deixa explícito pro consumidor (painel) qual dos dois
 * é, já que EXPORT tem disponibilidade diferente por escopo (roster não —
 * `listParticipants` funciona igual nos dois, ver /participants abaixo).
 */
function groupContext(g: LinkedGroup) {
  return {
    workspaceId: g.linkedWorkspaceId,
    group: { jid: g.jid, subject: g.subject },
    numberId: g.scope.kind === 'number' ? g.scope.numberId : null,
    scope: g.scope.kind,
  };
}

type ParticipantView = Awaited<ReturnType<typeof withAvatarUrls>>[number];

/**
 * Roster com `avatarKey` (interno) trocado por `avatarUrl` presigned (público).
 * Presign curto (120s) — o mesmo TTL da rota de áudio. Falha de R2 não derruba
 * o roster: o avatar cai pras iniciais no lugar de quebrar a resposta inteira.
 */
async function withAvatarUrls(raw: GroupParticipant[]) {
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
   * Passos 1-4 comuns. Devolve o grupo, ou null quando a resposta já foi enviada.
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
    return g;
  }

  // ── GET /whatsapp/groups ─────────────────────────────────────────────────────
  // Grupos vinculados ao workspace. Sem vínculo → 200 com lista vazia (é lista).
  app.get('/whatsapp/groups', { preHandler: auth }, async (req: any, reply) => {
    const ws = emptyToUndefined(req.query.workspace_id);
    if (!ws) return reply.code(400).send({ error: 'workspace_id required' });
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    if (!await gateAdmin(req, reply, ws, authz)) return;
    const linked = await listLinkedGroups(deps.pool, ws);
    const groups = [];
    for (const g of linked) {
      // Última mensagem + contagem por grupo. Escopo pela MESMA chave que
      // identifica a conversa daquele grupo (número+workspace, ou agent) — é
      // a mesma fronteira de isolamento da rota de mensagens, não uma
      // otimização. `lastText` é CONTEÚDO de conversa, não metadado.
      const { rows } = g.scope.kind === 'number'
        ? await deps.pool.query(
            `SELECT MAX(created_at) AS last_at, COUNT(*)::int AS count,
                    (ARRAY_AGG(text ORDER BY created_at DESC))[1] AS last_text
               FROM messages
              WHERE whatsapp_number_id = $1 AND workspace_id = $2 AND identifier = $3`,
            [g.scope.numberId, g.scope.numberWorkspaceId, g.jid],
          )
        : await deps.pool.query(
            `SELECT MAX(created_at) AS last_at, COUNT(*)::int AS count,
                    (ARRAY_AGG(text ORDER BY created_at DESC))[1] AS last_text
               FROM messages
              WHERE agent = $1 AND whatsapp_number_id IS NULL AND identifier = $2`,
            [g.scope.agent, g.jid],
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
    const result = g.scope.kind === 'number'
      ? await listThreadMessages(deps.pool, {
          workspaceId: g.scope.numberWorkspaceId,   // DADOS: workspace do número
          numberId: g.scope.numberId,
          identifier: g.jid,
          limit: Number(limit ?? 50),
          cursor: emptyToUndefined(cursor),
        })
      : await listGroupMessagesByAgent(deps.pool, {
          agent: g.scope.agent,
          identifier: g.jid,
          limit: Number(limit ?? 50),
          cursor: emptyToUndefined(cursor),
        });
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_messages',
      workspaceId: g.linkedWorkspaceId,   // AUDITORIA: workspace do cliente
      numberId: g.scope.kind === 'number' ? g.scope.numberId : null,
      identifier: g.jid,
    });
    return reply.send({ schema: 'group_v1', context: groupContext(g), ...result });
  });

  // ── GET /whatsapp/groups/:jid/export ─────────────────────────────────────────
  app.get('/whatsapp/groups/:jid/export', { preHandler: auth }, async (req: any, reply) => {
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    if (g.scope.kind === 'agent') {
      // exportConversation (export.ts) é number-scoped por construção (usa
      // isGroupThread + listThreadMessages com numberId/workspaceId — nenhum
      // dos dois existe pra um grupo da organização). Adaptá-la pro escopo
      // 'agent' seria invasivo numa feature que, além de nova, ainda está
      // INERTE em produção (zero vínculos criados). Preferimos um erro
      // explícito a inventar um export que leia o escopo errado ou finja
      // sucesso com transcript vazio.
      return reply.code(501).send({ error: 'export_nao_suportado_para_grupo_da_organizacao' });
    }
    const { since, until, max_messages, order } = req.query;
    const ord = order === 'head' || order === 'tail' ? order : undefined;
    const out = await exportConversation(deps.pool, {
      workspaceId: g.scope.numberWorkspaceId,
      numberId: g.scope.numberId,
      identifier: g.jid,
      since: emptyToUndefined(since),
      until: emptyToUndefined(until),
      maxMessages: max_messages ? Number(max_messages) : undefined,
      order: ord,
    });
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_export',
      workspaceId: g.linkedWorkspaceId, numberId: g.scope.numberId, identifier: g.jid,
      meta: { messageCount: out.messageCount },
    });
    return reply.send({ schema: 'group_v1', context: groupContext(g), ...out });
  });

  // ── GET /whatsapp/groups/:jid/participants ───────────────────────────────────
  app.get('/whatsapp/groups/:jid/participants', { preHandler: auth }, async (req: any, reply) => {
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    // Roster é chaveado por `whatsapp_group_participants.group_id`, que
    // aponta pro `id` (PK surrogate, mig 030) de `whatsapp_groups` — a linha
    // existe IGUAL nos dois escopos, então `listParticipants(g.id)` funciona
    // pra 'number' e pra 'agent' sem distinção. O escopo 'agent' é
    // sincronizado por `syncAgentGroupParticipants` (agent-group-sync.ts),
    // não pelo `syncGroupSubjects` do escopo 'number' — mas grava na MESMA
    // tabela.
    const participants: ParticipantView[] = await withAvatarUrls(await listParticipants(deps.pool, g.id));
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_participants',
      workspaceId: g.linkedWorkspaceId, numberId: g.scope.kind === 'number' ? g.scope.numberId : null, identifier: g.jid,
    });
    return reply.send({ schema: 'group_v1', context: groupContext(g), participants });
  });

  // ── GET /whatsapp/groups/:jid/search ─────────────────────────────────────────
  // Busca ILIKE na conversa do grupo. Validação de INPUT (q) roda ANTES do
  // gate — mesma classe do `workspace_id required`: 400 de formato não revela
  // nada. Access log NUNCA grava o q cru (PII), só o tamanho.
  app.get('/whatsapp/groups/:jid/search', { preHandler: auth }, async (req: any, reply) => {
    const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (rawQ.length < 2) return reply.code(400).send({ error: 'q_too_short' });
    if (rawQ.length > 200) return reply.code(400).send({ error: 'q_too_long' });
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    const parsed = Number.parseInt(req.query.limit, 10);
    const limit = Number.isNaN(parsed) ? 30 : Math.min(100, Math.max(1, parsed));
    const { hits, truncated } = await searchGroupMessages(deps.pool, {
      scope: g.scope, identifier: g.jid, q: rawQ, limit,
    });
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_search',
      workspaceId: g.linkedWorkspaceId,
      numberId: g.scope.kind === 'number' ? g.scope.numberId : null,
      identifier: g.jid,
      meta: { qLength: rawQ.length, hitCount: hits.length },
    });
    return reply.send({ schema: 'group_v1', context: groupContext(g), hits, truncated });
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
    const around = emptyToUndefined(req.query.around);
    if (around !== undefined && !/^\d+$/.test(around)) {
      return reply.code(400).send({ error: 'around_invalid' });
    }
    const g = await gateAndResolve(req, reply);
    if (!g) return;
    if (around) {
      const anchor = await resolveAnchor(deps.pool, { scope: g.scope, identifier: g.jid, id: around });
      if (!anchor) return reply.code(404).send({ error: 'message_not_in_group' });
      const [m, rawParticipants] = await Promise.all([
        listMessagesAround(deps.pool, { scope: g.scope, identifier: g.jid, anchor }),
        listParticipants(deps.pool, g.id),
      ]);
      logAccess(deps.pool, {
        actor: req.actingUser, action: 'group_messages',
        workspaceId: g.linkedWorkspaceId, numberId: g.scope.kind === 'number' ? g.scope.numberId : null, identifier: g.jid,
      });
      return reply.send({
        schema: 'group_v1', context: groupContext(g),
        group: { jid: g.jid, subject: g.subject },
        ...m, participants: await withAvatarUrls(rawParticipants),
        anchorId: Number(around),
      });
    }
    const limit = Number(req.query.limit ?? 50);
    const cursor = emptyToUndefined(req.query.cursor);
    let msgs: { messages: unknown[]; nextCursor: string | null };
    let participants: ParticipantView[];
    // Roster vem de `listParticipants(g.id)` nos DOIS escopos (ver comentário
    // na rota /participants acima) — só as MENSAGENS divergem por escopo.
    if (g.scope.kind === 'number') {
      const [m, rawParticipants] = await Promise.all([
        listThreadMessages(deps.pool, { workspaceId: g.scope.numberWorkspaceId, numberId: g.scope.numberId, identifier: g.jid, limit, cursor }),
        listParticipants(deps.pool, g.id),
      ]);
      msgs = m;
      participants = await withAvatarUrls(rawParticipants);
    } else {
      const [m, rawParticipants] = await Promise.all([
        listGroupMessagesByAgent(deps.pool, { agent: g.scope.agent, identifier: g.jid, limit, cursor }),
        listParticipants(deps.pool, g.id),
      ]);
      msgs = m;
      participants = await withAvatarUrls(rawParticipants);
    }
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'group_messages',
      workspaceId: g.linkedWorkspaceId, numberId: g.scope.kind === 'number' ? g.scope.numberId : null, identifier: g.jid,
    });
    return reply.send({
      schema: 'group_v1', context: groupContext(g),
      group: { jid: g.jid, subject: g.subject },
      ...msgs, participants,
    });
  });
}
