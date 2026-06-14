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
import { resolveByWhatsapp } from '../commands/identity.js';
import { sendCloudText } from '../webhook-cloud/send.js';
import { config } from '../config.js';

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
}
