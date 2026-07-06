import Fastify from 'fastify';
import { config, assertTranscribeConfig } from './config.js';
import { registerAdminRoutes } from './admin/routes.js';
import { registerContactsRoutes } from './contacts/routes.js';
import { registerWebhookRoutes } from './webhook/routes.js';
import { registerMcpRoutes } from './mcp/server.js';
import { registerDebugRoutes } from './debug/routes.js';
import { registerSdrRoutes } from './sdr/routes.js';
import { registerTimelineRoutes } from './timeline/routes.js';
import { registerProjectsRoutes } from './projects/routes.js';
import { registerWebhookCloudRoutes, registerSendCloudRoute } from './webhook-cloud/routes.js';
import { registerEpisodesRoutes } from './episodes/routes.js';
import { registerMemoriaRoutes } from './lua/routes.js';
import { registerProvisionRoutes } from './whatsapp/provision-routes.js';
import { registerReadRoutes } from './whatsapp/read-routes.js';
import { registerWriteRoutes } from './whatsapp/write-routes.js';
import { pool } from './db.js';
import { requireAgentToken } from './auth.js';
import { startTriggerPoller } from './triggers/poller.js';
import { startHoldsCleanupCron } from './goals/scheduling/holds-cleanup.js';
import { startReconcileCron } from './goals/scheduling/reconcile-trigger.js';
import { startOutboxDispatcher } from './events/dispatcher.js';
import { startLuaScheduler } from './lua/scheduler.js';
import { startProvisioningReaperCron } from './whatsapp/provisioning-reaper.js';
import { startTranscriptionPoller } from './transcription/poller.js';
import { r2Configured } from './integrations/r2.js';

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

  // Episódios (transcrições): leitura por X-Agent-Token + admin por X-Owner-Token.
  await app.register(async (scope) => {
    await registerEpisodesRoutes(scope);
  });

  // Memória da Lua (busca híbrida): leitura por X-Agent-Token.
  await app.register(async (scope) => {
    await registerMemoriaRoutes(scope);
  });

  // Admin endpoints: CRUD de projects/goals/agendas. Auth: X-Owner-Token (env OWNER_ADMIN_TOKEN).
  // Consumido pela GUI agentes.beeads.com.br.
  await app.register(async (scope) => {
    await registerAdminRoutes(scope);
  });

  // Provisionamento WhatsApp (painel central): auth X-Panel-Token.
  await app.register(async (scope) => {
    registerProvisionRoutes(scope, {
      pool,
      evolution: { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY },
      panelToken: config.PANEL_TOKEN,
      webhook: { url: config.WORKER_WEBHOOK_URL, secret: config.EVOLUTION_WEBHOOK_SECRET },
    });
  });

  // Contrato de leitura WhatsApp (painel central): auth X-Panel-Token.
  await app.register(async (scope) => {
    registerReadRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
  });

  // Contrato de ESCRITA WhatsApp (painel central): auth X-Panel-Token.
  await app.register(async (scope) => {
    registerWriteRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
  });

  // Fail-fast ANTES de bindar/subir pollers: TRANSCRIBE_MODE≠off exige OPENAI + R2.
  // Se inválido, o processo sai limpo aqui (sem servidor no ar nem crons rodando).
  assertTranscribeConfig(config, r2Configured());

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info({ port: config.PORT }, 'semente-platform-worker up');

  if (!config.INTERNAL_API_SECRET) {
    app.log.warn('INTERNAL_API_SECRET ausente — escrita de lead/exposição via MCP será SEMPRE recusada (fail-closed).');
  }

  // Poller que processa pending_triggers (burst smoothing + quiet hours).
  // Substitui o trigger fire-and-forget inline do webhook handler.
  startTriggerPoller(app.log);

  // Dispatcher do outbox de eventos (expansão + entrega HTTP com retry/dead-letter).
  startOutboxDispatcher(app.log);

  // Cron que limpa holds expirados a cada 5 minutos.
  startHoldsCleanupCron(app.log);

  // Cron que reconcilia meetings com Google Calendar a cada 1h (detecta cancel/move pelo closer).
  startReconcileCron(app.log);

  // Scheduler noturno da Lua (memória): setInterval 60s, janela America/Sao_Paulo.
  // Self-check de LUA_ENABLED + janela a cada tick => iniciar sempre é seguro
  // (no-op enquanto desligado ou fora da janela 02h-05h local).
  startLuaScheduler(app.log);

  // Cron que varre provisionamentos de WhatsApp vencidos (QR não escaneado):
  // remove a instância Evolution órfã + a linha de staging. Rede de segurança
  // anti-órfão (não depende do abort do painel).
  startProvisioningReaperCron(app.log, {
    pool,
    evolution: { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY },
  });

  // Serviço de transcrição de áudio (isolado). Pré-requisitos já validados acima.
  if (config.TRANSCRIBE_MODE === 'auto') {
    startTranscriptionPoller(app.log);
  } else {
    app.log.info({ mode: config.TRANSCRIBE_MODE }, 'transcrição: poller NÃO iniciado (modo != auto)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
