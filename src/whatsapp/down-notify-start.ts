import type { Pool } from 'pg';
import { config } from '../config.js';
import { fetchLatestMessageTs, getConnectionState } from '../evolution/client.js';
import { cloudPhoneNumberIdForAgent } from '../webhook-cloud/send.js';
import { resolveWorkspaceNames } from '../bloquim/workspace-names.js';
import { listConnectedInstances } from './numbers.js';
import { makeCloudDownSender } from './down-notify-sender.js';
import {
  runSystemInstanceWatch,
  sweepDownNumbers,
  type DownNotifyDeps,
  type DownNotifyLog,
  type SystemProbe,
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
    },
  };
}

/** Sondas reais da vigia de sistema — compartilhadas pelo daemon e pelo CLI. */
export function buildSystemProbe(pool: Pool): SystemProbe {
  const evolution = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
  return {
    connectionState: (i: string) => getConnectionState(evolution, i),
    latestStoreTs: (i: string) => fetchLatestMessageTs(evolution, i),
    listPeerInstances: () => listConnectedInstances(pool),
  };
}

/**
 * Liga os vigias conforme o config. Configuração incompleta NÃO derruba o
 * worker: loga em erro e não inicia — o resto do processo segue.
 */
export function startDownNotify(pool: Pool, log: DownNotifyLog): void {
  const numbersOn = config.CONNECTION_NOTIFY_NUMBERS === 'on';
  const targets = config.SYSTEM_INSTANCE_WATCH_JSON;
  if (!numbersOn && targets.length === 0) {
    log.info({}, 'down-notify: desligado (CONNECTION_NOTIFY_NUMBERS=off e sem SYSTEM_INSTANCE_WATCH_JSON)');
    return;
  }
  const built = buildDownNotifyDeps(pool, log);
  if ('error' in built) {
    log.error({ reason: built.error }, 'down-notify: NÃO iniciado');
    return;
  }
  const { deps } = built;

  if (numbersOn) {
    loop('numbers', config.CONNECTION_ALERT_SWEEP_INTERVAL_MS, () => sweepDownNumbers(deps), log);
  }
  if (targets.length > 0) {
    const probe = buildSystemProbe(pool);
    loop(
      'system',
      config.SYSTEM_INSTANCE_WATCH_INTERVAL_MS,
      () => runSystemInstanceWatch({ ...deps, probe, staleMs: config.SYSTEM_INSTANCE_STORE_STALE_MS }, targets),
      log,
    );
  }
  log.info(
    {
      numbers: numbersOn,
      systemTargets: targets.map((t) => t.instance),
      sender: built.phoneNumberId,
      template: config.CONNECTION_NOTIFY_TEMPLATE_NAME ?? null,
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
