import type { Pool } from 'pg';
import { config } from '../config.js';
import { cloudPhoneNumberIdForAgent, sendCloudTemplate } from '../webhook-cloud/send.js';
import { OPS_ALERT_TEMPLATE, opsAlertTemplateParams } from '../webhook-cloud/templates.js';
import { resolveWorkspaceNames } from '../bloquim/workspace-names.js';
import { listConnectedInstances, updateNumberStatus } from './numbers.js';
import { makeCloudDownSender, makeOpsCopySender } from './down-notify-sender.js';
import { makeEvolutionProbe } from './down-notify-probe.js';
import { parseOffDates } from './business-hours.js';
import type { EvolutionDeps } from '../evolution/client.js';
import { archiveChat, fetchInstanceOwner, findProbeInStore, markMessageAsRead } from '../evolution/client.js';
import { listProbeTargets, runProbeTick, type ProbeDeps } from './connection-probe-service.js';
import {
  runSystemInstanceWatch,
  sweepDownNumbers,
  type DownNotifyDeps,
  type DownNotifyLog,
  type SystemProbe,
  type SystemWatchOpts,
} from './down-notify-service.js';

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

/**
 * Config da sonda de conexão, resolvida de forma PURA (spec §11): sem env nem
 * rede aqui, para o teste travar as 4 combinações sem precisar do zod nem do
 * processo. `mode:'off'` (ou ausência dele) é "não inicia"; `mode:'on'` sem
 * telefone próprio é erro declarado — nunca deriva um estado "on" quebrado.
 */
export type ProbeConfigEnv = {
  mode: 'off' | 'on';
  ownPhones: string[];
  mirror?: 'off' | 'on';
  opsTo?: string;
};
export type ProbeConfigResult = { mode: 'off' } | { error: string } | { mode: 'on'; mirrorTo: string | null };

export function buildProbeConfig(env: ProbeConfigEnv): ProbeConfigResult {
  if (env.mode !== 'on') return { mode: 'off' };
  if (env.ownPhones.length === 0) return { error: 'WHATSAPP_CLOUD_OWN_PHONES ausente' };
  const mirror = env.mirror ?? 'on';
  return { mode: 'on', mirrorTo: mirror === 'on' ? (env.opsTo ?? null) : null };
}

/**
 * `{error}` não carrega `mode` (é a forma mais fiel ao caso — "erro de
 * configuração", não um terceiro MODO), então o discriminante entre os 3
 * ramos de `ProbeConfigResult` é o `in`, não um campo comum a todos.
 *
 * Exportada porque `index.ts` precisa da MESMA decisão pra saber se liga
 * `setOwnCloudProbeHandler` — reconstruir a condição lá (ex.: só checar
 * `CONNECTION_PROBE_MODE==='on'`) divergiria de `buildProbeConfig` no dia em
 * que este ganhar uma regra nova.
 */
export function probeStarted(r: ProbeConfigResult): { mode: 'on'; mirrorTo: string | null } | null {
  return 'mode' in r && r.mode === 'on' ? r : null;
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
      return { ok: r.ok, wamid: r.send_id, detail: r.ok ? undefined : r.detail };
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

/** Dependências reais da sonda de conexão (ver `buildProbeEvolution` acima). */
function buildProbeDeps(pool: Pool, log: DownNotifyLog, phoneNumberId: string, mirrorTo: string | null): ProbeDeps {
  // Não reusa `buildSystemWatchOpts` aqui: aquela tipa `offDates` como opcional
  // (o vigia de sistema tolera datas ausentes), e a sonda exige `OffDates`
  // sempre presente — o `parseOffDates` direto já devolve o `Set` (vazio na
  // ausência de config), sem o `| undefined` da forma do vigia.
  const { dates: offDates } = parseOffDates(config.BUSINESS_HOURS_EXTRA_OFF_DATES);
  return {
    pool,
    log,
    now: () => new Date(),
    rand: Math.random,
    evolution: buildProbeEvolution(pool),
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
 */
export function startDownNotify(pool: Pool, log: DownNotifyLog): void {
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
    log.info({}, 'down-notify: desligado (CONNECTION_NOTIFY_NUMBERS=off, sem SYSTEM_INSTANCE_WATCH_JSON e sonda de conexão off)');
    return;
  }
  const built = buildDownNotifyDeps(pool, log);
  if ('error' in built) {
    log.error({ reason: built.error }, 'down-notify: NÃO iniciado');
    return;
  }
  const { deps, phoneNumberId } = built;

  if (numbersOn) {
    loop('numbers', config.CONNECTION_ALERT_SWEEP_INTERVAL_MS, () => sweepDownNumbers(deps), log);
  }
  if (targets.length > 0) {
    const probe = buildSystemProbe(pool);
    const watchOpts = buildSystemWatchOpts(log);
    loop(
      'system',
      config.SYSTEM_INSTANCE_WATCH_INTERVAL_MS,
      () => runSystemInstanceWatch({ ...deps, probe, ...watchOpts }, targets),
      log,
    );
  }
  if (started) {
    const probeDeps = buildProbeDeps(pool, log, phoneNumberId, started.mirrorTo);
    loop(
      'probe',
      config.SYSTEM_INSTANCE_WATCH_INTERVAL_MS,
      async () => runProbeTick(probeDeps, await listProbeTargets(pool, config.SYSTEM_INSTANCE_WATCH_JSON)),
      log,
    );
  } else if ('error' in probeCfg) {
    log.error({ reason: probeCfg.error }, 'sonda de conexão: NÃO iniciada');
  }
  log.info(
    {
      numbers: numbersOn,
      systemTargets: targets.map((t) => t.instance),
      extraOffDates: parseOffDates(config.BUSINESS_HOURS_EXTRA_OFF_DATES).dates.size,
      sender: phoneNumberId,
      template: config.CONNECTION_NOTIFY_TEMPLATE_NAME ?? null,
      // Visível no boot: sem isto, "o dono não recebeu a cópia" vira caça ao
      // env sem nenhum sinal de que ele estava ausente o tempo todo.
      opsCopy: config.OPS_NOTIFY_TO ? 'on' : 'off (sem OPS_NOTIFY_TO)',
      probe: started ? 'on' : 'off',
      mirrorTo: started ? started.mirrorTo : null,
    },
    'down-notify iniciado',
  );
}

/** setInterval + flag de sobreposição (padrão do repo) + primeiro tick imediato. */
function loop(name: string, intervalMs: number, fn: () => Promise<unknown>, log: DownNotifyLog): void {
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
  setInterval(tick, intervalMs);
  void tick();
}
