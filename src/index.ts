import Fastify from 'fastify';
import { config } from './config.js';
import { registerContactsRoutes } from './contacts/routes.js';
import { registerWebhookRoutes } from './webhook/routes.js';
import { registerMcpRoutes } from './mcp/server.js';
import { registerDebugRoutes } from './debug/routes.js';
import { registerSdrRoutes } from './sdr/routes.js';

async function main() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 5 * 1024 * 1024, // 5MB — Evolution webhooks podem ser grandes com metadados
  });

  // Health: público, sem auth
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Webhook (Evolution): auth por shared secret no handler
  await app.register(registerWebhookRoutes);

  // REST /contacts: auth por X-Agent-Token (registrado dentro do plugin)
  await app.register(async (scope) => {
    await registerContactsRoutes(scope);
  });

  // MCP /mcp: auth por X-Agent-Token (registrado dentro do plugin)
  await app.register(async (scope) => {
    await registerMcpRoutes(scope);
  });

  // Debug logs: agente posta texto livre, owner lê. Auth por X-Agent-Token.
  await app.register(async (scope) => {
    await registerDebugRoutes(scope);
  });

  // SDR: lead-state, handoff, meetings simulados. Auth por X-Agent-Token.
  await app.register(async (scope) => {
    await registerSdrRoutes(scope);
  });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info({ port: config.PORT }, 'semente-platform-worker up');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
