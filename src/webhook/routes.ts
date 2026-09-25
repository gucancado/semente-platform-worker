import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  enqueuePendingTrigger,
  getAgentProjectConfig,
  insertMessage,
  insertTranscriptionJob,
  lookupContact,
  logWebhook,
  pool,
} from '../db.js';
import { parseEvolutionPayload, shouldIngest } from './evolution.js';
import { handleConnectionEvent } from '../whatsapp/connection-events.js';
import { resolveIngest } from '../whatsapp/resolve-ingest.js';
import { resolveInboundAgent } from '../whatsapp/ingest-persist.js';
import { createTask } from '../bloquim/client.js';
import { computeScheduledAt } from '../triggers/quiet-hours.js';
import { agentsToTrigger, quarantineUnknownInstance } from '../whatsapp/reaction.js';
import { detectAndTagSource } from '../whatsapp/source-signals.js';
import { mediaIngestPlan, mediaMessageText } from '../whatsapp/media-policy.js';
import { insertWhatsappMediaJob } from '../whatsapp/media-jobs.js';
import { extractProbeCode, ownCloudMatch, ownCloudText } from '../whatsapp/own-cloud.js';

type ProbeKey = { id: string; remoteJid: string; fromMe: boolean };
let ownCloudProbeHandler: ((instance: string, code: string, key: ProbeKey) => Promise<void>) | null = null;
/** Ligado pelo boot (sonda de conexão). null = só descarta. */
export function setOwnCloudProbeHandler(fn: typeof ownCloudProbeHandler): void {
  ownCloudProbeHandler = fn;
}

/**
 * Gate puro de ingestão de áudio (number-path, só DM). `off` ou grupo ou sem
 * mídia → não captura (nem placeholder, nem job). `manual`/`auto` capturam;
 * só `auto` suprime o trigger reativo na chegada (o poller dispara depois de
 * transcrever). Extraído como função pura testável sem precisar de Postgres.
 */
export function audioIngestPlan(mode: 'off' | 'manual' | 'auto', isGroup: boolean, hasAudio: boolean):
  { capture: boolean; suppressTrigger: boolean } {
  if (!hasAudio || isGroup || mode === 'off') return { capture: false, suppressTrigger: false };
  return { capture: true, suppressTrigger: mode === 'auto' };
}

export async function registerWebhookRoutes(app: FastifyInstance) {
  app.post('/webhook', async (req, reply) => {
    // Auth: shared secret obrigatório no header X-Evolution-Secret.
    const secret = req.headers['x-evolution-secret'];
    if (!secret || secret !== config.EVOLUTION_WEBHOOK_SECRET) {
      req.log.warn(
        { hasHeader: !!secret, secretLen: typeof secret === 'string' ? secret.length : 0 },
        'webhook rejeitado — X-Evolution-Secret ausente ou mismatch'
      );
      return reply.code(401).send({ error: 'invalid evolution secret' });
    }

    // Eventos de instância (connection.update/qrcode.updated) atualizam o status
    // do número e NÃO seguem pro ingest de mensagem. Tratar antes do parse.
    if (await handleConnectionEvent(pool, req.body)) {
      return reply.send({ ok: true });
    }

    const msg = parseEvolutionPayload(req.body);
    if (!msg) {
      return { ignored: true, reason: 'parse-failed-or-irrelevant' };
    }

    // Porta anti-CRM (SEMPRE ligada): DM do nosso número Cloud — aviso de queda,
    // cópia ou sonda de conexão — nunca é conversa de lead. Sai antes do
    // resolveIngest: sem webhook_logs, messages, gatilho nem IA.
    const rawData = (req.body as any)?.data;
    const ownRule = !msg.isGroup && !msg.fromMe ? ownCloudMatch(rawData, config.WHATSAPP_CLOUD_OWN_PHONES) : null;
    if (ownRule) {
      const code = extractProbeCode(ownCloudText(rawData?.message));
      if (code && ownCloudProbeHandler) {
        try {
          await ownCloudProbeHandler(msg.instance, code, {
            id: String(rawData?.key?.id ?? ''),
            remoteJid: String(rawData?.key?.remoteJid ?? ''),
            fromMe: false,
          });
        } catch (err) {
          req.log.warn({ instance: msg.instance, err: (err as Error).message }, 'sonda: registrar recebimento falhou');
        }
      }
      req.log.info({ instance: msg.instance, rule: ownRule, probe: code != null }, 'webhook: mensagem do nosso número Cloud — fora do CRM');
      return { ignored: true, reason: 'own_cloud' };
    }

    // Áudio (number-path, só DM): decide se captura (placeholder + job) e se
    // suprime o trigger reativo na chegada (auto → poller dispara pós-transcrição).
    // `kind === 'audio'` e não `!!msg.media`: extractMedia passou a devolver imagem,
    // vídeo, documento e figurinha, que não podem cair no trilho de transcrição.
    const plan = audioIngestPlan(config.TRANSCRIBE_MODE, msg.isGroup, msg.media?.kind === 'audio');

    // Imagem/vídeo/documento/figurinha (number-path, só DM). Com o modo 'off' devolve
    // record=false e o ingest segue idêntico ao de antes desta feature.
    const mediaPlan = mediaIngestPlan({
      mode: config.WHATSAPP_MEDIA_MODE,
      isGroup: msg.isGroup,
      media: msg.media,
      maxBytes: config.WHATSAPP_MEDIA_MAX_BYTES,
      kinds: config.WHATSAPP_MEDIA_KINDS,
    });
    const mediaText = mediaPlan.record && msg.media ? mediaMessageText(msg.media, msg.messageText) : null;

    // Diagnóstico: quando texto vier null (e não for áudio capturado), loga o
    // keyset da envelope pra entender que tipo de mensagem foi enviada. Sem
    // isso a investigação fica cega.
    if (!msg.messageText && !msg.media) {
      const envelope = (req.body as any)?.data?.message;
      const envelopeKeys = envelope && typeof envelope === 'object' ? Object.keys(envelope) : [];
      req.log.warn(
        { agent: msg.agent, identifier: msg.identifier, envelopeKeys, isGroup: msg.isGroup },
        'webhook: mensagem chegou sem texto extraível — checar envelope keys'
      );
    }

    // Resolução de ingestão (inversão): instância → número → workspace.
    const legacyParse = (i: string) => {
      const h = i.indexOf('-');
      return h < 0 ? { agent: i, project: null } : { agent: i.slice(0, h), project: i.slice(h + 1) };
    };
    const resolved = await resolveIngest(pool, msg.instance, {
      legacyEnabled: config.INGEST_LEGACY_PARSE_ENABLED,
      legacyParse,
    });

    if (resolved.source === 'miss') {
      // Fase 2 (flag OFF): instância desconhecida → quarentena (replay admin via webhook_receipts).
      await quarantineUnknownInstance(pool, req.body);
      req.log.warn(
        { instance: msg.instance, evolution_event_id: msg.rawEventId },
        'ingest miss → quarentena (instância sem número e parse legado desligado)'
      );
      return reply.send({ ok: true, quarantined: true, reason: 'unknown_instance' });
    }

    if (resolved.source === 'number') {
      // Caminho NÚMERO (pós-inversão). agent = operador único (agent_operated) ou null (monitored).
      const agent = await resolveInboundAgent(pool, {
        workspaceId: resolved.workspaceId!,
        numberId: resolved.numberId!,
        mode: resolved.mode!,
      });
      const inserted = await logWebhook({
        agent,
        channel: msg.channel,
        instance: msg.instance,
        identifier: msg.identifier,
        author: msg.author,
        push_name: msg.pushName,
        message_text: msg.messageText,
        workspace_id: resolved.workspaceId,
        evolution_event_id: msg.rawEventId,
        payload_summary: plan.capture ? '[áudio]' : ((mediaText ?? msg.messageText ?? '').slice(0, 80) || '(sem texto)'),
        bloquim_task_id: null,
        fallback_used: false,
        whatsapp_number_id: resolved.numberId,
      });
      if (plan.capture) {
        try {
          const audioMsg = await insertMessage({
            agent, channel: msg.channel, identifier: msg.identifier, author: msg.author,
            direction: msg.fromMe ? 'outbound' : 'inbound', text: '[áudio]',
            evolution_event_id: msg.rawEventId, whatsapp_number_id: resolved.numberId, workspace_id: resolved.workspaceId,
            kind: 'audio', media_mime: msg.media!.mime, media_duration_s: msg.media!.durationS, transcription_status: 'pending',
          });
          await insertTranscriptionJob({
            message_id: audioMsg.id, whatsapp_number_id: resolved.numberId!, workspace_id: resolved.workspaceId ?? null,
            instance: msg.instance, evolution_event_id: msg.rawEventId, direction: msg.fromMe ? 'outbound' : 'inbound',
            is_group: false, identifier: msg.identifier, inbox_id: inserted.id, raw_envelope: (req.body as any)?.data ?? {},
          });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'enfileirar áudio falhou — webhook segue');
        }
      } else if (mediaPlan.record && msg.media && mediaText && msg.identifier) {
        // Mídia não-áudio em DM. A mensagem entra SEMPRE (com marcador), mesmo quando
        // o arquivo não vai ser guardado — a conversa não pode perder a bolha.
        try {
          const mediaMsg = await insertMessage({
            agent, channel: msg.channel, identifier: msg.identifier, author: msg.author,
            direction: msg.fromMe ? 'outbound' : 'inbound', text: mediaText,
            evolution_event_id: msg.rawEventId, whatsapp_number_id: resolved.numberId, workspace_id: resolved.workspaceId,
            kind: msg.media.kind, media_mime: msg.media.mime, media_duration_s: msg.media.durationS,
            media_size_bytes: msg.media.sizeBytes, media_filename: msg.media.filename, media_status: mediaPlan.status,
          });
          // Sem checar `duplicate`, igual ao áudio: se a 1ª entrega gravou a mensagem e
          // caiu antes do job, a reentrega precisa criar o job. O ON CONFLICT dedupe.
          if (mediaPlan.status === 'pending') {
            await insertWhatsappMediaJob(pool, {
              message_id: mediaMsg.id, whatsapp_number_id: resolved.numberId!, workspace_id: resolved.workspaceId ?? null,
              instance: msg.instance, evolution_event_id: msg.rawEventId, kind: msg.media.kind,
              raw_envelope: (req.body as any)?.data ?? {},
            });
          }
          // Legenda de foto passava pela detecção de origem quando era gravada como
          // texto puro; continua passando agora que mora numa mensagem de mídia.
          if (!mediaMsg.duplicate && !msg.fromMe && msg.messageText && resolved.workspaceId && resolved.numberId != null) {
            try {
              await detectAndTagSource(pool, {
                workspaceId: resolved.workspaceId, numberId: resolved.numberId,
                identifier: msg.identifier, text: msg.messageText,
              });
            } catch (err) {
              req.log.warn({ err: (err as Error).message }, 'detectAndTagSource(mídia) falhou — webhook segue');
            }
          }
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'gravar mídia falhou — webhook segue');
        }
      } else if (msg.messageText && msg.identifier) {
        try {
          const msgInserted = await insertMessage({
            agent,
            channel: msg.channel,
            identifier: msg.identifier,
            author: msg.author,
            direction: msg.fromMe ? 'outbound' : 'inbound',
            text: msg.messageText,
            evolution_event_id: msg.rawEventId,
            whatsapp_number_id: resolved.numberId,
            workspace_id: resolved.workspaceId,
          });  // dedup próprio por (whatsapp_number_id, evolution_event_id)
          // S4: auto-source só em inbound novo, DM, com número resolvido.
          if (!msgInserted.duplicate && !msg.fromMe && !msg.isGroup && resolved.workspaceId && resolved.numberId != null) {
            try {
              await detectAndTagSource(pool, {
                workspaceId: resolved.workspaceId, numberId: resolved.numberId,
                identifier: msg.identifier, text: msg.messageText,
              });
            } catch (err) {
              req.log.warn({ err: (err as Error).message }, 'detectAndTagSource falhou — webhook segue');
            }
          }
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'insertMessage(number-path) falhou — webhook segue');
        }
      }
      // Reação: agentes reactive que operam o número recebem trigger (debounce/quiet-hours
      // pelo poller). Só DM e só em mensagem nova (não duplicada). Sweep não dispara aqui (cron).
      // Áudio em modo auto suprime o trigger na chegada — o poller dispara pós-transcrição.
      if (!inserted.duplicate && msg.identifier && !msg.isGroup && !msg.fromMe && !plan.suppressTrigger) {
        const toTrigger = await agentsToTrigger(pool, {
          workspaceId: resolved.workspaceId!,
          numberId: resolved.numberId!,
          mode: resolved.mode!,
        });
        for (const ag of toTrigger) {
          try {
            const scheduledAt = computeScheduledAt(null, config.TRIGGER_DEBOUNCE_MS);
            await enqueuePendingTrigger({ agent: ag, project: null, identifier: msg.identifier, inbox_id: inserted.id, scheduled_at: scheduledAt });
          } catch (err) {
            req.log.warn({ err: (err as Error).message, agent: ag }, 'enqueuePendingTrigger (number-path) falhou');
          }
        }
      }
      return {
        ok: true,
        inbox_id: inserted.id,
        number_id: resolved.numberId,
        workspace_id: resolved.workspaceId,
        agent,
        duplicate: inserted.duplicate,
        source: 'number',
      };
    }

    // resolved.source === 'legacy' → segue o caminho legado EXISTENTE abaixo (inalterado).

    // Legacy (mercurio/saturno) nunca ingeriu fromMe (eco do próprio agente).
    // Como o parse não descarta mais fromMe (number-path precisa), blindamos aqui.
    if (msg.fromMe) {
      return { ignored: true, reason: 'fromMe-legacy' };
    }

    const agentCfg = config.AGENT_TOKENS_JSON[msg.agent];
    if (!agentCfg) {
      req.log.warn({ agent: msg.agent, instance: msg.instance }, 'webhook recebido para agente desconhecido');
      return reply.code(404).send({ error: 'unknown agent' });
    }

    // Gate de ingestão por modo do agente. Grupos só entram p/ agentes 'sweep'
    // (auditor). Agentes 'reactive' (SDR) seguem ignorando grupos.
    const mode = agentCfg.mode;
    if (!shouldIngest(msg, mode)) {
      return { ignored: true, reason: msg.isGroup ? 'group-not-audited' : 'not-DM' };
    }

    // Resolve workspace por remetente (opcional — só relevante se Bloquim sync ligado)
    const route = await lookupContact(msg.agent, msg.channel, msg.identifier);
    const workspaceId = route?.workspace_id ?? agentCfg.fallback_workspace_id ?? null;
    const fallbackUsed = !route;

    // Bloquim sync é OPCIONAL agora (v0.6). Só roda se agente tem bloquim_token + fallback_workspace_id.
    // Sem Bloquim: webhook_logs vira a inbox, agente lê via MCP `inbox_list_unread`.
    // Task Bloquim por mensagem é só do fluxo reativo (SDR). Auditor (sweep) age
    // por regra no tick, não cria task por mensagem de grupo.
    let bloquimTaskId: string | null = null;
    if (mode === 'reactive' && agentCfg.bloquim_token && workspaceId) {
      const tagBase = [`canal:${msg.channel}`];
      if (fallbackUsed) tagBase.push('triagem-necessaria');
      const preview = (msg.messageText ?? '').slice(0, 80) || '(sem texto)';
      try {
        const task = await createTask({
          agent: msg.agent,
          bloquim_token: agentCfg.bloquim_token,
          payload: {
            workspaceId,
            title: `WA: ${preview}`,
            description: [
              `**Canal:** ${msg.channel}`,
              `**Instância (persona/projeto):** ${msg.instance}`,
              `**De:** ${msg.identifier}${msg.pushName ? ` (${msg.pushName})` : ''}`,
              `**Fallback workspace:** ${fallbackUsed ? 'sim — triagem necessária' : 'não'}`,
              `**Evolution event id:** ${msg.rawEventId}`,
              '',
              '**Mensagem:**',
              '```',
              msg.messageText ?? '(sem texto)',
              '```',
            ].join('\n'),
            scheduleMode: 'urgente',
            tags: tagBase,
          },
        });
        bloquimTaskId = task?.id ?? null;
      } catch (err) {
        req.log.warn({ err }, 'bloquim sync falhou — inbox no worker continua disponível');
      }
    }

    // Sempre loga no worker (= inbox primária a partir da v0.6)
    const inserted = await logWebhook({
      agent: msg.agent,
      channel: msg.channel,
      instance: msg.instance,
      identifier: msg.identifier,
      author: msg.author,
      push_name: msg.pushName,
      message_text: msg.messageText,
      workspace_id: workspaceId,
      evolution_event_id: msg.rawEventId,
      payload_summary: (msg.messageText ?? '').slice(0, 80) || '(sem texto)',
      bloquim_task_id: bloquimTaskId,
      fallback_used: fallbackUsed,
    });

    // Fase 1: timeline conversacional. Inbound vai pra `messages` em paralelo
    // ao `webhook_logs`. Dedup pelo unique index parcial (agent, evolution_event_id).
    // Falha aqui não interrompe webhook — apenas loga.
    try {
      if (msg.messageText && msg.identifier) {
        await insertMessage({
          agent: msg.agent,
          project: msg.project,
          channel: msg.channel,
          identifier: msg.identifier,
          author: msg.author,
          direction: 'inbound',
          text: msg.messageText,
          evolution_event_id: msg.rawEventId,
        });
      }
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'insertMessage(inbound) falhou — webhook segue');
    }

    // Webhook duplicado (Evolution re-enviou o mesmo evento). Não dispara
    // trigger — o item original já foi processado ou está na fila.
    if (inserted.duplicate) {
      req.log.info(
        { agent: msg.agent, evolution_event_id: msg.rawEventId, inbox_id: inserted.id },
        'webhook duplicado — ignorando (sem trigger)'
      );
      return {
        ok: true,
        inbox_id: inserted.id,
        duplicate: true,
        trigger_fired: false,
      };
    }

    // v0.8 (mitigação anti-detecção): em vez de fire-and-forget do trigger,
    // enfileiramos em pending_triggers. Burst smoothing: várias msgs em
    // sequência atualizam a MESMA row pending e empurram scheduled_at —
    // mercurio recebe 1 trigger só. Quiet hours: se config tem janela
    // silenciada e o horário cai dentro, scheduled_at vira o fim da janela.
    let triggerQueued = false;
    let triggerError: string | null = null;
    if (mode !== 'reactive') {
      // sweep (auditor): não dispara trigger reativo — saturno varre por cron.
    } else if (!agentCfg.trigger_url) {
      req.log.warn({ agent: msg.agent }, 'agentCfg.trigger_url não está setado em AGENT_TOKENS_JSON');
      triggerError = 'no trigger_url configured';
    } else if (!msg.identifier) {
      triggerError = 'missing identifier';
    } else {
      try {
        const projectConfig = msg.project
          ? await getAgentProjectConfig(msg.agent, msg.project).catch(() => null)
          : null;
        const scheduledAt = computeScheduledAt(projectConfig, config.TRIGGER_DEBOUNCE_MS);
        const queued = await enqueuePendingTrigger({
          agent: msg.agent,
          project: msg.project,
          identifier: msg.identifier,
          inbox_id: inserted.id,
          scheduled_at: scheduledAt,
        });
        triggerQueued = true;
        req.log.info(
          {
            agent: msg.agent,
            identifier: msg.identifier,
            pending_id: queued.id,
            msg_count: queued.msg_count,
            scheduled_at: scheduledAt.toISOString(),
            quiet_active: projectConfig?.quiet_hours_enabled === true,
          },
          queued.msg_count > 1 ? 'trigger debounced — burst smoothing' : 'trigger enqueued'
        );
      } catch (err) {
        triggerError = (err as Error).message;
        req.log.warn({ err: triggerError, agent: msg.agent }, 'enqueuePendingTrigger falhou');
      }
    }

    return {
      ok: true,
      inbox_id: inserted.id,
      bloquim_task_id: bloquimTaskId,
      bloquim_sync: bloquimTaskId !== null,
      fallback: fallbackUsed,
      trigger_queued: triggerQueued,
      trigger_error: triggerError,
    };
  });
}
