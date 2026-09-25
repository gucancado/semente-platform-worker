import type { Pool } from 'pg';
import { config } from '../config.js';
import { cloudPhoneNumberIdForAgent, sendCloudTemplate } from '../webhook-cloud/send.js';
import { OPS_ALERT_TEMPLATE, opsAlertTemplateParams } from '../webhook-cloud/templates.js';
import { resolveWorkspaceNames } from '../bloquim/workspace-names.js';
import { listConnectedInstances, updateNumberStatus } from './numbers.js';
import { makeCloudDownSender, makeOpsCopySender } from './down-notify-sender.js';
import { makeEvolutionProbe } from './down-notify-probe.js';
import { parseOffDates, type OffDates } from './business-hours.js';
import type { EvolutionDeps } from '../evolution/client.js';
import { archiveChat, fetchInstanceOwner, findProbeInStore, markMessageAsRead } from '../evolution/client.js';
import { listProbeTargets, runProbeTick, type ProbeDeps } from './connection-probe-service.js';
// buildProbeConfig/probeStarted moram em `connection-probe.ts` (módulo
// ZERO-IMPORT) pra o teste puro de config não precisar de `--env-file` só
// porque este arquivo importa `config.ts` — re-exportadas aqui pra quem já
// importa deste módulo continuar funcionando sem mudar import (review round 1).
import { buildProbeConfig, probeStarted, type ProbeConfigEnv, type ProbeConfigResult } from './connection-probe.js';
import {
  runSystemInstanceWatch,
  sweepDownNumbers,
  type DownNotifyDeps,
  type DownNotifyLog,
  type SystemProbe,
  type SystemWatchOpts,
} from './down-notify-service.js';

export { buildProbeConfig, probeStarted, type ProbeConfigEnv, type ProbeConfigResult };

const LINK_MAX_CLICKS = 10;
const LINK_TTL_DAYS = 7;

/**
 * Dependências reais do aviso de queda. Compartilhadas pelo daemon e pelo CLI
 * `whatsapp:notify-down`, para o smoke manual avisar exatamente como o vigia.
 */
export function buildDownNotifyDeps(
  pool: Pool,
  log: DownNotifyLog,
): { deps: DownNotifyDeps; phoneNumberId: string } | { error: string } {
  if (!config.WHATSAPP_CLOUD_ACCESS_TOKEN) return { error: 'WHATSAPP_CLOUD_ACCESS_TOKEN ausente' };
  const map = config.WHATSAPP_CLOUD_NUMBERS_JSON as Record<string, { agent: string; project: string }>;
  const phoneNumberId = cloudPhoneNumberIdForAgent(map, config.CONNECTION_NOTIFY_CLOUD_AGENT);
  if (!phoneNumberId) {
    return { error: `sem phone_number_id Cloud para o agente ${config.CONNECTION_NOTIFY_CLOUD_AGENT}` };
  }
  return {
    phoneNumberId,
    deps: {
      pool,
      send: makeCloudDownSender({
        phoneNumberId,
        templateName: config.CONNECTION_NOTIFY_TEMPLATE_NAME,
        templateLang: config.CONNECTION_NOTIFY_TEMPLATE_LANG,
      }),
      now: () => new Date(),
      panelBaseUrl: config.PANEL_PUBLIC_URL,
      cadence: {
        debounceMs: config.CONNECTION_ALERT_DEBOUNCE_MS,
        renotifyMs: config.CONNECTION_NOTIFY_RENOTIFY_MS,
        maxNotifies: config.CONNECTION_NOTIFY_MAX,
      },
      link: { maxClicks: LINK_MAX_CLICKS, ttlDays: LINK_TTL_DAYS },
      log,
      resolveWorkspaceName: async (id: string) => (await resolveWorkspaceNames([id])).get(id) ?? null,
      // Cópia para o operador — pelo MESMO número Cloud, com o template de
      // OPERAÇÃO. Sem OPS_NOTIFY_TO os dois campos ficam undefined e a cópia é
      // no-op silencioso: o aviso principal não muda em nada.
      sendOpsCopy: config.OPS_NOTIFY_TO
        ? makeOpsCopySender({ phoneNumberId, to: config.OPS_NOTIFY_TO })
        : undefined,
      opsCopyTo: config.OPS_NOTIFY_TO,
    },
  };
}

/** Sondas reais da vigia de sistema — compartilhadas pelo daemon e pelo CLI. */
export function buildSystemProbe(pool: Pool): SystemProbe {
  return makeEvolutionProbe(
    { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY },
    () => listConnectedInstances(pool),
    config.WHATSAPP_CLOUD_OWN_PHONES,
  );
}

/**
 * Opções da vigia de sistema a partir do config — compartilhadas pelo daemon e
 * pelo CLI, para o smoke avaliar exatamente como o vigia. Data extra malformada
 * vira WARN e é ignorada: nunca derruba o processo.
 */
export function buildSystemWatchOpts(log: DownNotifyLog): SystemWatchOpts {
  const { dates, invalid } = parseOffDates(config.BUSINESS_HOURS_EXTRA_OFF_DATES);
  if (invalid.length > 0) {
    log.warn(
      { invalid, accepted: [...dates] },
      'down-notify: BUSINESS_HOURS_EXTRA_OFF_DATES tem entrada inválida (esperado yyyy-MM-dd) — ignorada',
    );
  }
  return {
    staleMs: config.SYSTEM_INSTANCE_STORE_STALE_MS,
    intervalMs: config.SYSTEM_INSTANCE_WATCH_INTERVAL_MS,
    offDates: dates,
  };
}

/** `sendProbe` da sonda: SEM fallback de texto livre (spec §11) — fora da janela
 * de 24h o texto seria aceito e recusado depois, poluindo o veredito com um
 * `send_failed` que na verdade nunca tentou o template. */
function makeSendProbe(phoneNumberId: string): ProbeDeps['sendProbe'] {
  return async (to, titulo, detalhe) => {
    try {
      const r = await sendCloudTemplate(phoneNumberId, to, {
        name: OPS_ALERT_TEMPLATE.name,
        language: OPS_ALERT_TEMPLATE.language,
        ...opsAlertTemplateParams({ titulo, detalhe }),
      });
      // Status HTTP preservado dentro de `detail` (o contrato de ProbeDeps não
      // tem campo `status` próprio) — sem ele, um 4xx do Cloud (template não
      // aprovado, número bloqueado) e um erro de rede viravam o mesmo log
      // `send_failed` sem nada pra distinguir causa de configuração de causa
      // transitória (review round 1).
      return { ok: r.ok, wamid: r.send_id, detail: r.ok ? undefined : { status: r.status, detail: r.detail } };
    } catch (err) {
      return { ok: false, wamid: null, detail: (err as Error).message };
    }
  };
}

/** Aviso operacional da sonda (pipeline quebrado, envio falhou, identidade
 * divergente, 3 inconclusive, silêncio geral). Sem OPS_NOTIFY_TO, no-op
 * silencioso — igual ao `sendOpsCopy` do aviso de queda. */
function makeSendOps(phoneNumberId: string, to: string | undefined): ProbeDeps['sendOps'] {
  if (!to) return async () => {};
  const send = makeOpsCopySender({ phoneNumberId, to });
  return async (titulo, detalhe) => {
    try {
      await send(titulo, detalhe);
    } catch {
      // Best-effort: `safeOps` do serviço já loga a falha em torno de cada chamada.
    }
  };
}

/**
 * Evolution real da sonda. Reusa `buildSystemProbe` (que já embute o skip
 * anti-CRM `isOwnDownNotice || isFromOwnCloudRecord` — spec §3) para
 * `connectionState`/`latestStoreTs`, em vez de duplicar a construção do skip
 * aqui; as chamadas exclusivas da sonda (dono, achar no store, ler, arquivar)
 * vão direto no `evolution/client.ts` sobre o MESMO `EvolutionDeps`.
 *
 * Exportada porque `index.ts` precisa do MESMO objeto para
 * `handleProbeReceipt` (recebimento pelo webhook) — o tick e o recebimento
 * têm que enxergar a Evolution do jeito idêntico.
 */
export function buildProbeEvolution(pool: Pool): ProbeDeps['evolution'] {
  const evolutionDeps: EvolutionDeps = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
  const sysProbe = buildSystemProbe(pool);
  return {
    connectionState: sysProbe.connectionState,
    latestStoreTs: sysProbe.latestStoreTs,
    owner: (i) => fetchInstanceOwner(evolutionDeps, i),
    findProbe: (i, code, sinceSec) => findProbeInStore(evolutionDeps, i, code, sinceSec),
    markRead: (i, key) => markMessageAsRead(evolutionDeps, i, key),
    archive: (i, key) => archiveChat(evolutionDeps, i, key),
  };
}

/**
 * Dependências reais da sonda de conexão. `evolution` e `offDates` entram por
 * parâmetro (construídos 1x por `startDownNotify`) — não duplica
 * `buildProbeEvolution`/`parseOffDates` aqui, pra `index.ts` e o loop do tick
 * enxergarem exatamente o MESMO objeto (review round 1, item 3).
 */
function buildProbeDeps(
  pool: Pool,
  log: DownNotifyLog,
  phoneNumberId: string,
  mirrorTo: string | null,
  evolution: ProbeDeps['evolution'],
  offDates: OffDates,
): ProbeDeps {
  return {
    pool,
    log,
    now: () => new Date(),
    rand: Math.random,
    evolution,
    sendProbe: makeSendProbe(phoneNumberId),
    sendOps: makeSendOps(phoneNumberId, config.OPS_NOTIFY_TO),
    mirrorTo,
    resolveName: async (t) => {
      if (t.workspaceId) {
        const name = (await resolveWorkspaceNames([t.workspaceId])).get(t.workspaceId) ?? null;
        if (name) return name;
      }
      return t.label;
    },
    staleMs: config.SYSTEM_INSTANCE_STORE_STALE_MS,
    offDates,
    updateNumberStatus: (instance, status) => updateNumberStatus(pool, instance, { status }).then(() => undefined),
  };
}

/**
 * Liga os vigias conforme o config. Configuração incompleta NÃO derruba o
 * worker: loga em erro e não inicia — o resto do processo segue.
 *
 * Devolve `{ probeEvolution }` quando o loop da SONDA efetivamente subiu (modo
 * ligado, `WHATSAPP_CLOUD_OWN_PHONES` presente E o Cloud sender resolvido —
 * `buildDownNotifyDeps` ok), ou `null` caso contrário — é o que `index.ts` usa
 * pra ligar `setOwnCloudProbeHandler` com a MESMA Evolution do tick, sem
 * reconstruir a decisão nem o objeto (review round 1, item 3).
 */
export function startDownNotify(pool: Pool, log: DownNotifyLog): { probeEvolution: ProbeDeps['evolution'] } | null {
  const numbersOn = config.CONNECTION_NOTIFY_NUMBERS === 'on';
  const targets = config.SYSTEM_INSTANCE_WATCH_JSON;
  const probeCfg = buildProbeConfig({
    mode: config.CONNECTION_PROBE_MODE,
    ownPhones: config.WHATSAPP_CLOUD_OWN_PHONES,
    mirror: config.CONNECTION_PROBE_MIRROR,
    opsTo: config.OPS_NOTIFY_TO,
  });
  const started = probeStarted(probeCfg);
  const probeOn = started != null;
  const probeError = 'error' in probeCfg ? probeCfg.error : null;

  // Loga o erro de config da sonda JÁ AQUI, antes de qualquer `return` — na
  // versão anterior este log vivia só perto do loop, e os dois early-returns
  // abaixo (nada ligado; `buildDownNotifyDeps` falhou) o engoliam em silêncio
  // sempre que numbers/system também estavam desligados (review round 1, item 1).
  if (probeError) {
    log.error({ reason: probeError }, 'sonda de conexão: NÃO iniciada');
  }

  // Off-dates parseadas UMA VEZ (com o warn de entrada malformada de sempre) —
  // o vigia de sistema e a sonda usam o MESMO `Set`, nunca duas leituras/dois
  // warns pro mesmo `BUSINESS_HOURS_EXTRA_OFF_DATES` (review round 1, item 9).
  const watchOpts = buildSystemWatchOpts(log);
  const offDates: OffDates = watchOpts.offDates ?? new Set();

  // Lacuna do rollout (ruling do controlador na task 8): com a sonda desligada,
  // `store_stale` do saturno deixou de abrir episódio sozinho — virou só
  // gatilho de sonda (down-notify.ts:planEpisode). Sem a sonda, essa detecção
  // de zumbi de instância de SISTEMA fica sem ninguém que a confirme.
  if (targets.length > 0 && !probeOn) {
    log.warn(
      { systemTargets: targets.map((t) => t.instance) },
      'down-notify: SYSTEM_INSTANCE_WATCH_JSON configurado com a sonda de conexão DESLIGADA — store atrasado do saturno não abre mais episódio sozinho (só gatilho de sonda); detecção de zumbi de instância de sistema fica DESLIGADA até ligar CONNECTION_PROBE_MODE=on',
    );
  }

  if (!numbersOn && targets.length === 0 && !probeOn) {
    // `probeError` é "o operador pediu a sonda e a config está quebrada" —
    // bem diferente de "off" (não pedida). Dizer "off" nos dois casos faria o
    // erro logo acima parecer conversa fiada (review round 1, item 1).
    log.info(
      {},
      `down-notify: desligado (CONNECTION_NOTIFY_NUMBERS=off, sem SYSTEM_INSTANCE_WATCH_JSON e sonda de conexão ${probeError ? 'com erro de config (ver log acima)' : 'off'})`,
    );
    return null;
  }
  const built = buildDownNotifyDeps(pool, log);
  if ('error' in built) {
    log.error({ reason: built.error }, 'down-notify: NÃO iniciado');
    return null;
  }
  const { deps, phoneNumberId } = built;

  if (numbersOn) {
    loop('numbers', config.CONNECTION_ALERT_SWEEP_INTERVAL_MS, () => sweepDownNumbers(deps), log);
  }
  if (targets.length > 0) {
    const probe = buildSystemProbe(pool);
    loop(
      'system',
      config.SYSTEM_INSTANCE_WATCH_INTERVAL_MS,
      () => runSystemInstanceWatch({ ...deps, probe, ...watchOpts }, targets),
      log,
    );
  }
  let result: { probeEvolution: ProbeDeps['evolution'] } | null = null;
  if (started) {
    const probeEvolution = buildProbeEvolution(pool);
    const probeDeps = buildProbeDeps(pool, log, phoneNumberId, started.mirrorTo, probeEvolution, offDates);
    // Deslocado por METADE do intervalo do vigia de sistema (ruling do
    // controlador, review round 1 item 5): os dois loops usam o MESMO
    // `SYSTEM_INSTANCE_WATCH_INTERVAL_MS` e, sem o offset, disparariam o 1º
    // tick juntos (ambos chamam a Evolution imediatamente no boot) e depois
    // em lockstep a cada intervalo — uma rajada evitável contra a mesma API.
    loop(
      'probe',
      config.SYSTEM_INSTANCE_WATCH_INTERVAL_MS,
      async () => runProbeTick(probeDeps, await listProbeTargets(pool, config.SYSTEM_INSTANCE_WATCH_JSON)),
      log,
      Math.floor(config.SYSTEM_INSTANCE_WATCH_INTERVAL_MS / 2),
    );
    result = { probeEvolution };
  }
  log.info(
    {
      numbers: numbersOn,
      systemTargets: targets.map((t) => t.instance),
      extraOffDates: offDates.size,
      sender: phoneNumberId,
      template: config.CONNECTION_NOTIFY_TEMPLATE_NAME ?? null,
      // Visível no boot: sem isto, "o dono não recebeu a cópia" vira caça ao
      // env sem nenhum sinal de que ele estava ausente o tempo todo.
      opsCopy: config.OPS_NOTIFY_TO ? 'on' : 'off (sem OPS_NOTIFY_TO)',
      probe: started ? 'on' : probeError ? 'error' : 'off',
      mirrorTo: started ? started.mirrorTo : null,
    },
    'down-notify iniciado',
  );
  return result;
}

/**
 * setInterval + flag de sobreposição (padrão do repo) + primeiro tick.
 * `initialDelayMs` (default 0 = imediato) adia só o PRIMEIRO tick — os
 * seguintes continuam a cada `intervalMs` a partir dele (usado pra sonda e
 * vigia de sistema não rajarem a Evolution no mesmo instante — ver acima).
 */
function loop(name: string, intervalMs: number, fn: () => Promise<unknown>, log: DownNotifyLog, initialDelayMs = 0): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.error({ loop: name, err: (err as Error).message }, 'down-notify: ciclo falhou');
    } finally {
      running = false;
    }
  };
  if (initialDelayMs > 0) {
    setTimeout(() => {
      void tick();
      setInterval(tick, intervalMs);
    }, initialDelayMs);
  } else {
    setInterval(tick, intervalMs);
    void tick();
  }
}
