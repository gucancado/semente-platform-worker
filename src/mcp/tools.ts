import { z } from 'zod';
import type { McpServer, CallToolResult } from './sdk.js';
import {
  lookupContact,
  upsertContact,
  listContactsByWorkspace,
  deleteContact,
  listUnreadInbox,
  markInboxRead,
} from '../db.js';
import { listEpisodes, getEpisode } from '../episodes/db.js';
import { searchMemoria } from '../lua/search.js';
import { getEmbeddingClient } from '../lua/embedding-provider.js';
import { getFatos, getStatusVigente, getRecapByWeek, type FactType } from '../lua/db.js';
import { resolveRecapPeriodStart } from '../lua/narrativa.js';

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

  // ── inbox_list_unread ──────────────────────────────────────────────────
  server.registerTool(
    'inbox_list_unread',
    {
      description:
        'Lista mensagens recebidas via webhook que ainda não foram processadas pelo agente. FIFO (mais antigas primeiro). Filtro opcional por `instance` quando agente quer focar em um projeto específico do tick atual.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        instance: z
          .string()
          .optional()
          .describe('Filtra por instância Evolution (ex: "mercurio-metido-a-gente")'),
      },
    },
    async ({ limit, instance }): Promise<CallToolResult> => {
      const items = await listUnreadInbox(agent, limit ?? 20, instance);
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
}
