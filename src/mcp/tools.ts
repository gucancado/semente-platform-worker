import { z } from 'zod';
import type { McpServer, CallToolResult } from './sdk.js';
import {
  lookupContact,
  upsertContact,
  listContactsByWorkspace,
  deleteContact,
} from '../db.js';

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
}
