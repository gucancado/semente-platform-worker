import { z } from 'zod';
import type { McpServer, CallToolResult } from './sdk.js';
import type { Pool } from 'pg';
import {
  lookupContact,
  upsertContact,
  listContactsByWorkspace,
  deleteContact,
  listUnreadInbox,
  markInboxRead,
  pool,
} from '../db.js';
import { listNumbers } from '../whatsapp/numbers.js';
import { listThreads, listThreadMessages } from '../whatsapp/read-queries.js';
import { listEpisodes, getEpisode } from '../episodes/db.js';
import { resolveByWhatsapp } from '../commands/identity.js';
import { sendCloudText } from '../webhook-cloud/send.js';
import { config } from '../config.js';
import { searchMemoria } from '../lua/search.js';
import { getEmbeddingClient } from '../lua/embedding-provider.js';
import { getFatos, getStatusVigente, getRecapByWeek, getActiveConduta, type FactType } from '../lua/db.js';
import { resolveRecapPeriodStart } from '../lua/narrativa.js';

export async function whatsappListNumbersHandler(p: Pool, input: { workspace_id: string }) {
  if (!input?.workspace_id) throw new Error('workspace_id required');
  return { schema: 'whatsapp_v1', numbers: await listNumbers(p, input.workspace_id) };
}

export async function whatsappListThreadsHandler(p: Pool, input: { workspace_id: string; number_id: number; limit?: number; cursor?: string }) {
  if (!input?.workspace_id) throw new Error('workspace_id required');
  if (!input?.number_id) throw new Error('number_id required');
  return { schema: 'whatsapp_v1', ...await listThreads(p, { workspaceId: input.workspace_id, numberId: Number(input.number_id), limit: input.limit ?? 30, cursor: input.cursor }) };
}

export async function whatsappThreadMessagesHandler(p: Pool, input: { workspace_id: string; number_id: number; identifier: string; limit?: number; cursor?: string }) {
  if (!input?.workspace_id) throw new Error('workspace_id required');
  if (!input?.number_id || !input?.identifier) throw new Error('number_id and identifier required');
  return { schema: 'whatsapp_v1', ...await listThreadMessages(p, { numberId: Number(input.number_id), identifier: input.identifier, limit: input.limit ?? 50, cursor: input.cursor }) };
}

/**
 * Registra todas as tools no `server` com o `agent` baked-in via closure.
 *
 * Chamado pelo `buildServerForAgent` factory no server.ts (uma instância por
 * request HTTP em modo stateless).
 *
 * McpServer.registerTool aceita Zod shape (objeto de campos), não z.object(...);
 * o SDK converte internamente para JSON Schema.
 */
export function registerTools(server: McpServer, agent: string): void {
  // ── lookup_contact ─────────────────────────────────────────────────────
  server.registerTool(
    'lookup_contact',
    {
      description:
        'Procura uma route remetente→workspace. Retorna a route ou null. Use antes de enviar mensagem para saber em qual workspace logar.',
      inputSchema: {
        channel: z.enum(['whatsapp', 'email']),
        identifier: z.string().describe('E.164 (+5531...) ou email'),
      },
    },
    async ({ channel, identifier }): Promise<CallToolResult> => {
      const route = await lookupContact(agent, channel, identifier);
      return {
        content: [{ type: 'text', text: route ? JSON.stringify(route) : 'null' }],
      };
    }
  );

  // ── add_contact_route ──────────────────────────────────────────────────
  server.registerTool(
    'add_contact_route',
    {
      description:
        'Cria ou atualiza um vínculo remetente→workspace. Use durante triagem ou pré-registro.',
      inputSchema: {
        channel: z.enum(['whatsapp', 'email']),
        identifier: z.string(),
        workspace_id: z.string(),
        display_name: z.string().nullish(),
        notes: z.string().nullish(),
      },
    },
    async (input): Promise<CallToolResult> => {
      const route = await upsertContact({ agent, ...input });
      return { content: [{ type: 'text', text: JSON.stringify(route) }] };
    }
  );

  // ── list_contacts_by_workspace ────────────────────────────────────────
  server.registerTool(
    'list_contacts_by_workspace',
    {
      description: 'Lista todos os remetentes cadastrados para um workspace específico.',
      inputSchema: {
        workspace_id: z.string(),
      },
    },
    async ({ workspace_id }): Promise<CallToolResult> => {
      const list = await listContactsByWorkspace(agent, workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify(list) }] };
    }
  );

  // ── delete_contact_route ───────────────────────────────────────────────
  server.registerTool(
    'delete_contact_route',
    {
      description: 'Remove um vínculo remetente→workspace por id.',
      inputSchema: {
        id: z.number(),
      },
    },
    async ({ id }): Promise<CallToolResult> => {
      const deleted = await deleteContact(agent, id);
      return { content: [{ type: 'text', text: JSON.stringify({ deleted }) }] };
    }
  );

  // ── resolve_whatsapp_identity ──────────────────────────────────────────
  server.registerTool(
    'resolve_whatsapp_identity',
    {
      description:
        'Resolve um número WhatsApp → identidade Bloquim (userId, nome, email, whatsapp e workspaces com role). Use pra decidir se um remetente do grupo é membro da equipe (membro do workspace do projeto) ou cliente. Retorna a string "null" se o número não estiver cadastrado em nenhum usuário Bloquim.',
      inputSchema: {
        phone: z
          .string()
          .describe('Telefone em E.164 ou só dígitos (ex: "+5531999594121" ou "5531999594121"). A resolução compara apenas dígitos.'),
      },
    },
    async ({ phone }): Promise<CallToolResult> => {
      const user = await resolveByWhatsapp(phone);
      return {
        content: [{ type: 'text', text: user ? JSON.stringify(user) : 'null' }],
      };
    }
  );

  // ── send_whatsapp_dm ───────────────────────────────────────────────────
  server.registerTool(
    'send_whatsapp_dm',
    {
      description:
        'Envia uma mensagem de texto (DM) via número B (WhatsApp Cloud) DESTE agente para um indivíduo. NUNCA envia para grupo (o número B não está em grupos). Só funciona dentro da janela de 24h (o destinatário precisa ter mandado msg pro número B nas últimas 24h); fora dela exige template (não suportado aqui) e a API retorna erro. Resolve o phone_number_id do agente automaticamente. Retorna {ok, send_id, status?, detail?}.',
      inputSchema: {
        to: z
          .string()
          .describe('Telefone destino em E.164 ou só dígitos (ex: "5531999594121"). NUNCA um JID de grupo.'),
        text: z.string().min(1).describe('Texto da mensagem.'),
      },
    },
    async ({ to, text }): Promise<CallToolResult> => {
      const map = (config.WHATSAPP_CLOUD_NUMBERS_JSON ?? {}) as Record<
        string,
        { agent: string; project: string }
      >;
      const phoneNumberId = Object.keys(map).find((id) => map[id]?.agent === agent);
      if (!phoneNumberId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, send_id: null, detail: `sem phone_number_id Cloud p/ agente ${agent}` }),
            },
          ],
        };
      }
      const res = await sendCloudText(phoneNumberId, to, text);
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    }
  );

  // ── inbox_list_unread ──────────────────────────────────────────────────
  server.registerTool(
    'inbox_list_unread',
    {
      description:
        'Lista mensagens recebidas via webhook que ainda não foram processadas pelo agente. FIFO (mais antigas primeiro). Filtros opcionais: `instance` (instância Evolution) e `identifier` (remetente/grupo). Use `identifier` no sweep p/ pegar só as mensagens do grupo do projeto do tick — evita a fila global encher o teto com outros grupos.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        instance: z
          .string()
          .optional()
          .describe('Filtra por instância Evolution (ex: "mercurio-metido-a-gente")'),
        identifier: z
          .string()
          .optional()
          .describe(
            'Filtra por identifier do remetente/grupo (ex: "+120363308683104573" p/ um grupo WhatsApp). No sweep, passe o grupo do projeto p/ limitar a fila ao escopo do tick.'
          ),
      },
    },
    async ({ limit, instance, identifier }): Promise<CallToolResult> => {
      const items = await listUnreadInbox(agent, limit ?? 20, instance, identifier);
      return { content: [{ type: 'text', text: JSON.stringify(items) }] };
    }
  );

  // ── inbox_mark_read ────────────────────────────────────────────────────
  server.registerTool(
    'inbox_mark_read',
    {
      description:
        'Marca uma mensagem da inbox como processada. Chame DEPOIS de ter executado a ação (responder, criar tarefa Bloquim, escalonar, etc). Idempotente.',
      inputSchema: {
        id: z.number().int(),
        processed_by: z
          .string()
          .optional()
          .describe('Identificador de quem processou (ex: TICK_ID); aparece no log.'),
      },
    },
    async ({ id, processed_by }): Promise<CallToolResult> => {
      const updated = await markInboxRead(agent, id, processed_by ?? 'agent');
      return {
        content: [{ type: 'text', text: JSON.stringify({ marked: updated }) }],
      };
    }
  );

  // ── episodes_list ──────────────────────────────────────────────────────
  server.registerTool(
    'episodes_list',
    {
      description: 'Lista episódios de conversa (reuniões/WhatsApp) por workspace/período. Retorna cabeçalhos sem turnos; use episodes_get pro conteúdo.',
      inputSchema: {
        workspace_id: z.string().nullish(),
        fonte: z.enum(['reuniao', 'whatsapp']).nullish(),
        since: z.string().nullish().describe('ISO date'),
        until: z.string().nullish().describe('ISO date'),
        orphans: z.boolean().nullish().describe('true = só episódios sem projeto'),
        limit: z.number().int().positive().max(200).nullish(),
        cursor: z.string().nullish(),
      },
    },
    async (input): Promise<CallToolResult> => {
      const page = await listEpisodes({
        workspace_id: input.workspace_id ?? undefined, fonte: input.fonte ?? undefined,
        since: input.since ? new Date(input.since) : undefined, until: input.until ? new Date(input.until) : undefined,
        orphans: input.orphans ?? undefined, limit: input.limit ?? undefined, cursor: input.cursor ?? undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ schema: 'episodio_v1', ...page }) }] };
    }
  );

  // ── episodes_get ───────────────────────────────────────────────────────
  server.registerTool(
    'episodes_get',
    {
      description: 'Busca um episódio completo (turnos nomeados + proveniência) pelo id.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }): Promise<CallToolResult> => {
      const ep = await getEpisode(id);
      return { content: [{ type: 'text', text: ep ? JSON.stringify({ schema: 'episodio_v1', ...ep }) : 'null' }] };
    }
  );

  // ── search_memoria ─────────────────────────────────────────────────────
  server.registerTool(
    'search_memoria',
    {
      description:
        'Busca híbrida (vetorial + lexical, fusão RRF) na memória de um workspace. Retorna chunks de episódios e/ou fatos com proveniência. Tudo filtrado por workspace_id. Sem OPENAI_API_KEY degrada para lexical_only.',
      inputSchema: {
        workspace_id: z.string(),
        query: z.string(),
        k: z.number().int().optional(),
        scope: z.enum(['episodios', 'fatos', 'ambos']).optional(),
        since: z.string().optional().describe('ISO date'),
        until: z.string().optional().describe('ISO date'),
      },
    },
    async ({ workspace_id, query, k, scope, since, until }): Promise<CallToolResult> => {
      const result = await searchMemoria(
        { workspaceId: workspace_id, query },
        { k, scope, since, until },
        { embeddingClient: getEmbeddingClient() }
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // ── get_fatos ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_fatos',
    {
      description:
        'Lista fatos tipados de um workspace (memória semântica). As-of bi-temporal: por padrão só os vigentes agora; `vigente_em` consulta "o que valia em T"; `include_invalid` traz o histórico. Cada fato carrega proveniência, `needs_review` (suspeita) e `superseded_by_fact_id` (cadeia). Keyset cursor para paginar.',
      inputSchema: {
        workspace_id: z.string(),
        types: z.array(z.string()).optional(),
        vigente_em: z.string().optional().describe('ISO timestamp (as-of)'),
        include_invalid: z.boolean().optional(),
        q: z.string().optional().describe('filtro lexical (tsquery PT-BR)'),
        episode_id: z.number().int().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
      },
    },
    async (input): Promise<CallToolResult> => {
      const { fatos, next_cursor } = await getFatos(input.workspace_id, {
        types: input.types as FactType[] | undefined,
        vigenteEm: input.vigente_em,
        includeInvalid: input.include_invalid,
        q: input.q,
        episodeId: input.episode_id,
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ schema: 'memoria_fatos_v1', fatos, next_cursor }),
          },
        ],
      };
    }
  );

  // ── get_status ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_status',
    {
      description:
        'Status descritivo vigente do projeto (poucas frases, objetivo — onde o projeto está agora). Consumo: visão geral da Central. Retorna content_md null quando o workspace ainda não tem status.',
      inputSchema: { workspace_id: z.string() },
    },
    async ({ workspace_id }): Promise<CallToolResult> => {
      const status = await getStatusVigente(workspace_id);
      const payload = status
        ? {
            schema: 'status_v1',
            workspace_id: status.workspace_id,
            content_md: status.content_md,
            generated_at: status.generated_at,
            sources: status.sources,
          }
        : {
            schema: 'status_v1',
            workspace_id,
            content_md: null,
            generated_at: null,
            sources: [],
          };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  );

  // ── get_condutas ───────────────────────────────────────────────────────
  server.registerTool(
    'get_condutas',
    {
      description:
        'Conduta ativa (memória procedural) de um workspace: o documento de modo de agir INJETADO no contexto do agente ao iniciar trabalho no projeto. Retorna version, content_md e rules[] (cada regra com proveniência: fact_id + episódio + janela de turnos). content_md/version null quando não há conduta ativa.',
      inputSchema: { workspace_id: z.string() },
    },
    async ({ workspace_id }): Promise<CallToolResult> => {
      const conduta = await getActiveConduta(workspace_id);
      const payload = conduta
        ? {
            schema: 'conduta_v1',
            workspace_id: conduta.workspace_id,
            version: conduta.version,
            approved_at: conduta.approved_at,
            content_md: conduta.content_md,
            rules: conduta.rules,
          }
        : {
            schema: 'conduta_v1',
            workspace_id,
            version: null,
            content_md: null,
            rules: [],
          };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  );

  // ── get_recap ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_recap',
    {
      description:
        'Recap semanal (narradora) de um workspace. `week` (YYYY-Www) ou `start` (YYYY-MM-DD da segunda); default: semana ISO anterior. Retorna recap_v1 com content_md e sources (episode_ids); content_md null quando não gerado.',
      inputSchema: {
        workspace_id: z.string(),
        week: z.string().optional().describe('semana ISO (YYYY-Www)'),
        start: z.string().optional().describe('segunda-feira da semana (YYYY-MM-DD)'),
      },
    },
    async ({ workspace_id, week, start }): Promise<CallToolResult> => {
      const periodStart = resolveRecapPeriodStart({ week, start });
      const recap = await getRecapByWeek(workspace_id, periodStart);
      const payload = recap
        ? {
            schema: 'recap_v1',
            workspace_id: recap.workspace_id,
            period_start: recap.period_start,
            period_end: recap.period_end,
            content_md: recap.content_md,
            sources: recap.sources,
          }
        : {
            schema: 'recap_v1',
            workspace_id,
            period_start: periodStart,
            period_end: null,
            content_md: null,
            sources: [],
          };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  );

  // ── whatsapp_list_numbers ──────────────────────────────────────────────
  server.registerTool(
    'whatsapp_list_numbers',
    {
      description: 'Lista os números WhatsApp de um workspace (contrato whatsapp_v1).',
      inputSchema: { workspace_id: z.string() },
    },
    async (input): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify(await whatsappListNumbersHandler(pool, input)) }],
    })
  );

  // ── whatsapp_list_threads ──────────────────────────────────────────────
  server.registerTool(
    'whatsapp_list_threads',
    {
      description: 'Lista as conversas (threads) de um número, paginadas por keyset.',
      inputSchema: {
        workspace_id: z.string(),
        number_id: z.number(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
    },
    async (input): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify(await whatsappListThreadsHandler(pool, input)) }],
    })
  );

  // ── whatsapp_thread_messages ───────────────────────────────────────────
  server.registerTool(
    'whatsapp_thread_messages',
    {
      description: 'Lista as mensagens de uma thread (número + identifier), paginadas por keyset.',
      inputSchema: {
        workspace_id: z.string(),
        number_id: z.number(),
        identifier: z.string(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
    },
    async (input): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify(await whatsappThreadMessagesHandler(pool, input)) }],
    })
  );
}
