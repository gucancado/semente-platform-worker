import Fastify from 'fastify';
import { config } from './config.js';
import { registerContactsRoutes } from './contacts/routes.js';
import { registerWebhookRoutes } from './webhook/routes.js';
import { registerMcpRoutes } from './mcp/server.js';
import { registerDebugRoutes } from './debug/routes.js';
import { registerSdrRoutes } from './sdr/routes.js';
import { registerTimelineRoutes } from './timeline/routes.js';
import { registerProjectsRoutes } from './projects/routes.js';
import { registerWebhookCloudRoutes, registerSendCloudRoute } from './webhook-cloud/routes.js';
import { requireAgentToken } from './auth.js';
import { startTriggerPoller } from './triggers/poller.js';

async function main() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 5 * 1024 * 1024, // 5MB — Evolution webhooks podem ser grandes com metadados
  });

  // Pra validar HMAC do Cloud webhook, precisamos do body bruto.
  // Fastify v5 registra um parser default pra application/json — precisamos
  // remover ANTES de adicionar o nosso (senão o default ganha precedência).
  app.removeContentTypeParser(['application/json']);

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, function (req, body: Buffer, done) {
    // Atribuição em req e em req.raw (alguns paths checam um ou outro)
    (req as any).rawBody = body;
    if ((req as any).raw) (req as any).raw.rawBody = body;
    req.log.info(
      { len: body.length, url: req.url, contentType: req.headers['content-type'] },
      'content-type-parser: JSON received, rawBody set'
    );
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

  // Config por (agent, project) — quiet_hours etc. Auth por X-Agent-Token.
  await app.register(async (scope) => {
    await registerProjectsRoutes(scope);
  });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info({ port: config.PORT }, 'semente-platform-worker up');

  // Poller que processa pending_triggers (burst smoothing + quiet hours).
  // Substitui o trigger fire-and-forget inline do webhook handler.
  startTriggerPoller(app.log);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
