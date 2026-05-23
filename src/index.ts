import Fastify from 'fastify';
import { config } from './config.js';
import { registerContactsRoutes } from './contacts/routes.js';
import { registerWebhookRoutes } from './webhook/routes.js';
import { registerMcpRoutes } from './mcp/server.js';
import { registerDebugRoutes } from './debug/routes.js';
import { registerSdrRoutes } from './sdr/routes.js';
import { registerTimelineRoutes } from './timeline/routes.js';
import { registerWebhookCloudRoutes, registerSendCloudRoute } from './webhook-cloud/routes.js';
import { requireAgentToken } from './auth.js';

async function main() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 5 * 1024 * 1024, // 5MB — Evolution webhooks podem ser grandes com metadados
  });

  // Pra validar HMAC do Cloud webhook, precisamos do body bruto.
  // Fastify por default consome o JSON; este hook substitui o parser pra
  // todos os JSON, lê body como buffer e preserva uma cópia em req.rawBody
  // SEMPRE (não condicional por URL). Custo: ~bytes do request, irrelevante.
  // Cobre `application/json` com ou sem charset.
  app.addContentTypeParser(/^application\/json/, { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    (req as any).rawBody = body;
    try {
      const parsed = body.length ? JSON.parse(body.toString('utf8')) : {};
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Health: público, sem auth
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Webhook (Evolution): auth por shared secret no handler
  await app.register(registerWebhookRoutes);

  // Webhook Cloud (Meta WhatsApp Business Platform): GET verify + POST HMAC.
  // Público (sem X-Agent-Token), validado por HMAC dentro do handler.
  await app.register(registerWebhookCloudRoutes);

  // POST /send-cloud — chamado pelo orquestrador pra enviar via Cloud API.
  // Auth: X-Agent-Token (qualquer agente reconhecido pode usar).
  await app.register(async (scope) => {
    scope.addHook('preHandler', requireAgentToken);
    await registerSendCloudRoute(scope);
  });

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

  // Timeline (Fase 1 plano de ação): messages + llm_metrics. Auth por X-Agent-Token.
  await app.register(async (scope) => {
    await registerTimelineRoutes(scope);
  });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info({ port: config.PORT }, 'semente-platform-worker up');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
