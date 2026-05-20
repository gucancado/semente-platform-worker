/**
 * Encapsula imports do @modelcontextprotocol/sdk em um único módulo.
 *
 * Razão: a v2.0-alpha do SDK divide o pacote em vários (@modelcontextprotocol/server,
 * /node, /express) com paths novos. Concentrar imports aqui torna a migração
 * uma mudança em um único arquivo.
 *
 * Versão alvo atual: 1.29.x.
 */

export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
