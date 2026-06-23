import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAgentToken } from '../auth.js';
import { McpServer, StreamableHTTPServerTransport } from './sdk.js';
import { registerTools } from './tools.js';
import { config } from '../config.js';

/**
 * Cria um McpServer com tools registrados em closure sobre o agentName.
 * Factory-per-request (recomendado pelo SDK em modo stateless).
 */
function buildServerForAgent(agentName: string): McpServer {
  const server = new McpServer(
    { name: 'semente-platform', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  const cfg = config.AGENT_TOKENS_JSON[agentName] ?? { worker_token: '', mode: 'reactive' as const, can_write_whatsapp_meta: false };
  registerTools(server, agentName, cfg);
  return server;
}

/**
 * Monta o endpoint MCP no Fastify. Modo stateless: cada request HTTP cria
 * server + transport novos, fechados ao final. Multi-tenant: o nome do
 * agente é resolvido pela auth (X-Agent-Token) e baked nos handlers via
 * closure.
 */
export async function registerMcpRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgentToken);

  // POST /mcp — handshake + tools/list + tools/call. Único método suportado em stateless.
  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const agentName = req.agent.name;
    const server = buildServerForAgent(agentName);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    // Cleanup quando a conexão fecha (cliente desconecta, timeout, etc.)
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    // Hijack: o transport escreve direto em reply.raw; Fastify não deve auto-send.
    reply.hijack();

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err, agent: agentName }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end(JSON.stringify({ error: 'mcp internal error' }));
      }
    }
  });

  // GET /mcp e DELETE /mcp são usados em modo stateful (sessões persistentes
  // com SSE para server→client events). Em stateless, retornamos 405.
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.code(405).send({ error: 'method not allowed in stateless mode' });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
