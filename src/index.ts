import Fastify from 'fastify';
import { config, assertTranscribeConfig, assertMeetingsCollectConfig, assertMeetingsReadConfig } from './config.js';
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
import { registerGroupReadRoutes } from './whatsapp/group-read-routes.js';
import { registerBoardRoutes } from './whatsapp/board-routes.js';
import { registerWriteRoutes } from './whatsapp/write-routes.js';
import { registerOpportunityRoutes } from './whatsapp/opportunity-routes.js';
import { registerTagRoutes } from './whatsapp/tag-routes.js';
import { registerLossReasonRoutes } from './whatsapp/loss-reason-routes.js';
import { registerSettingsRoutes } from './whatsapp/settings-routes.js';
import { registerSuggestionRoutes } from './whatsapp/suggestion-routes.js';
import { registerMeetingsCollectRoutes } from './meetings-collect/routes.js';
import { registerMeetingsReadRoutes } from './meetings-read/routes.js';
import { registerAttributionRoutes } from './episodes/attribution-routes.js';
import { startMeetingsCollectPoller } from './meetings-collect/poller.js';
import { buildMeetingsCollectDeps } from './meetings-collect/runtime.js';
import { pool } from './db.js';
import { requireAgentToken } from './auth.js';
import { startTriggerPoller } from './triggers/poller.js';
import { startHoldsCleanupCron } from './goals/scheduling/holds-cleanup.js';
import { startReconcileCron } from './goals/scheduling/reconcile-trigger.js';
import { startOutboxDispatcher } from './events/dispatcher.js';
import { startLuaScheduler } from './lua/scheduler.js';
import { startFirefliesImportCron } from './integrations/fireflies/import-cron.js';
import { startProvisioningReaperCron } from './whatsapp/provisioning-reaper.js';
import { startGroupSyncCron } from './whatsapp/group-sync-cron.js';
import { startConnectionAlertSweep } from './whatsapp/connection-alerts.js';
import { startPresenceKeepalive } from './whatsapp/presence-keepalive.js';
import { startTranscriptionPoller } from './transcription/poller.js';
import { r2Configured } from './integrations/r2.js';
import { startCreationPoller } from './whatsapp/opportunity-pipeline.js';
import { startAutoLossPoller } from './whatsapp/auto-loss.js';
import { startJudgmentRunner } from './whatsapp/ai-judgment-runner.js';
import { startPatternPoller } from './whatsapp/ai-pattern-runner.js';
import { OpenAIJudgmentLlm } from './whatsapp/ai-llm.js';

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
    // GET /whatsapp/board (CRM v3 Fase C): projeção das 5 colunas do kanban.
    registerBoardRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
    // Contrato group_v1: conversa de grupo INTERNO no workspace do cliente.
    registerGroupReadRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
  });

  // Contrato de ESCRITA WhatsApp (painel central): auth X-Panel-Token.
  await app.register(async (scope) => {
    registerWriteRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
    registerOpportunityRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
    registerTagRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
    registerLossReasonRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
    registerSettingsRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
    // Sugestões da IA nível 2 (§8) + insights semanais: leitura por membro,
    // aplicar/dispensar por admin — mesmo escopo de escrita das demais rotas
    // deste bloco.
    registerSuggestionRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
  });

  // Coleta de reuniões (Vexa): auth X-Panel-Token. Só registra se VEXA_* presentes.
  const meetingsEnabled = Boolean(config.VEXA_API_URL && config.VEXA_API_KEY);
  assertMeetingsCollectConfig(config, meetingsEnabled);
  if (meetingsEnabled) {
    await app.register(async (scope) => {
      registerMeetingsCollectRoutes(scope, {
        pool,
        panelToken: config.PANEL_TOKEN,
        collectDeps: buildMeetingsCollectDeps(),
      });
    });
  } else {
    app.log.info('meetings-collect: rotas NÃO registradas (VEXA_API_URL/KEY ausentes)');
  }

  // Leitura de reuniões (contrato meetings_read_v1): auth X-Panel-Token. Gate por env.
  assertMeetingsReadConfig(config, config.MEETINGS_READ_ENABLED);
  if (config.MEETINGS_READ_ENABLED) {
    await app.register(async (scope) => {
      registerMeetingsReadRoutes(scope, { pool, panelToken: config.PANEL_TOKEN });
    });
    app.log.info('meetings-read: rotas registradas');
  } else {
    app.log.info('meetings-read: rotas NÃO registradas (MEETINGS_READ_ENABLED != true)');
  }

  // Atribuição de workspace (contrato attribution_v1): o sync de agenda do Bloquim
  // resolve cliente por domínio/título antes da reunião existir. Auth X-Panel-Token.
  // SEM gate de VEXA — atribuição não depende de coleta.
  await app.register(async (scope) => {
    registerAttributionRoutes(scope, { panelToken: config.PANEL_TOKEN });
  });
  app.log.info('attribution: rotas registradas');

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

  // Cron diário do import Fireflies (coleta contínua de transcrições de reunião):
  // tick 60s, claim por data em fireflies_import_runs, ~04:00 America/Sao_Paulo.
  // Self-check de FIREFLIES_IMPORT_ENABLED a cada tick => iniciar sempre é seguro.
  startFirefliesImportCron(app.log);

  // Cron que varre provisionamentos de WhatsApp vencidos (QR não escaneado):
  // remove a instância Evolution órfã + a linha de staging. Rede de segurança
  // anti-órfão (não depende do abort do painel).
  startProvisioningReaperCron(app.log, {
    pool,
    evolution: { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY },
  });

  // Cron diário (04:30 BRT) dos grupos vinculados: subjects + roster + fotos + identidades.
  startGroupSyncCron(app.log, {
    pool,
    evolution: { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY },
    avatarBudget: config.GROUP_AVATAR_BUDGET_PER_RUN,
    identityBudget: 50,
  });

  // Sweep de queda de conexão WhatsApp: alerta (painel + WhatsApp Saturno) quando um
  // número cai de 'connected' e fica fora do ar além do debounce. Idempotente por episódio.
  startConnectionAlertSweep(pool, app.log);

  // Keep-alive de presença: reafirma `unavailable` nas instâncias conectadas. Sem isso
  // o estado decai no servidor do WhatsApp e o CELULAR DO CLIENTE para de receber push
  // (quanto mais estável a sessão, pior — reconexão se auto-cura).
  startPresenceKeepalive(pool, app.log);

  // Serviço de transcrição de áudio (isolado). Pré-requisitos já validados acima.
  if (config.TRANSCRIBE_MODE === 'auto') {
    startTranscriptionPoller(app.log);
  } else {
    app.log.info({ mode: config.TRANSCRIBE_MODE }, 'transcrição: poller NÃO iniciado (modo != auto)');
  }

  // Poller de coleta de reuniões (Vexa): varre collected_meetings ativas, detecta
  // inatividade/conclusão e importa episódio. Pré-requisitos já validados acima.
  if (meetingsEnabled) {
    startMeetingsCollectPoller(app.log);
  } else {
    app.log.info('meetings-collect: poller NÃO iniciado (VEXA_* ausentes)');
  }

  // CRM WhatsApp v3 (Fase B): poller de criação de oportunidade + job de
  // auto-perda por inatividade. Kill-switch CRM_PIPELINE_ENABLED (default ON) —
  // 'false' desliga os dois no boot, sem redeploy de código.
  if (config.CRM_PIPELINE_ENABLED) {
    startCreationPoller(pool);
    startAutoLossPoller(pool);
    app.log.info('crm-pipeline: pollers de criação + auto-perda iniciados');

    // Runner do julgamento IA nível 1 (Fase D): tick horário + gate de janela
    // 03:00–04:00 BRT. Só sobe com OPENAI_API_KEY (mesma chave da transcrição);
    // sem ela, o motor de IA fica desligado sem quebrar o boot dos demais pollers.
    if (config.OPENAI_API_KEY) {
      const provider = new OpenAIJudgmentLlm({ apiKey: config.OPENAI_API_KEY, model: config.CRM_AI_MODEL });
      startJudgmentRunner(pool, provider, { log: app.log });
      app.log.info({ model: config.CRM_AI_MODEL }, 'crm-ai-judgment: runner iniciado (janela 03:00–04:00 BRT)');

      // Runner do motor de PADRÕES IA nível 2 (Fase E): tick horário + gate de janela
      // DOMINGO 04:00–05:00 BRT (pós-julgamento diário). Análise semanal por workspace,
      // 1 call LLM maior/workspace/semana. Modelo próprio (CRM_AI_PATTERN_MODEL, fallback
      // CRM_AI_MODEL). Mesmo kill-switch (CRM_PIPELINE_ENABLED) e mesma OPENAI_API_KEY.
      const patternModel = config.CRM_AI_PATTERN_MODEL ?? config.CRM_AI_MODEL;
      const patternProvider = new OpenAIJudgmentLlm({ apiKey: config.OPENAI_API_KEY, model: patternModel });
      startPatternPoller(pool, patternProvider, { log: app.log });
      app.log.info({ model: patternModel }, 'crm-ai-pattern: poller iniciado (domingo 04:00–05:00 BRT)');
    } else {
      app.log.info('crm-ai-judgment: runner NÃO iniciado (OPENAI_API_KEY ausente)');
    }
  } else {
    app.log.info('crm-pipeline: pollers NÃO iniciados (CRM_PIPELINE_ENABLED=false)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
