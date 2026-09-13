import type { Pool } from 'pg';
import {
  decideSystemHealth,
  isRetryableSendFailure,
  observedDownSince,
  reconnectUrl,
  shouldNotify,
  type SystemHealth,
} from './down-notify.js';
import { ensureReconnectLink } from './provision-links.js';
import {
  claimNumberNotification,
  claimSystemNotification,
  listDownNumbers,
  recordSystemHealth,
  releaseNumberNotification,
  releaseSystemNotification,
  type NotifyVersion,
  type SystemHealthRow,
  type SystemTarget,
} from './down-notify-store.js';
import type { DownSendResult, DownSender } from './down-notify-sender.js';

/**
 * Orquestração do aviso de queda ao próprio número: decide → reivindica →
 * emite/reusa o link de reconexão → envia. Os dois vigias (números de workspace
 * e instância de sistema) passam pelo MESMO `notifyOne`, então avisam igual.
 *
 * Sem config e sem Evolution aqui dentro — tudo entra por `deps`, o que deixa
 * o fluxo testável contra banco com remetente e sondas falsos.
 */

export type DownNotifyLog = {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

export type DownNotifyDeps = {
  pool: Pool;
  send: DownSender;
  now: () => Date;
  panelBaseUrl: string;
  cadence: { debounceMs: number; renotifyMs: number; maxNotifies: number };
  link: { maxClicks: number; ttlDays: number };
  log: DownNotifyLog;
  /** Nome do workspace (Bloquim). Ausente, null ou falhando = usa o rótulo do número. */
  resolveWorkspaceName?: (workspaceId: string) => Promise<string | null>;
};

export type NotifyAttempt = {
  key: string;
  phone: string;
  outcome: 'sent' | 'released' | 'failed' | 'claim_lost';
  via?: 'template' | 'text' | null;
  reusedLink?: boolean;
};

type Target = {
  key: string;
  instance: string;
  phone: string;
  label: string | null;
  workspaceId: string | null;
  downSince: Date;
  version: NotifyVersion;
};

async function notifyOne(
  deps: DownNotifyDeps,
  t: Target,
  claim: () => Promise<boolean>,
  release: () => Promise<void>,
): Promise<NotifyAttempt | null> {
  const due = shouldNotify({
    downSince: t.downSince,
    lastNotifiedAt: t.version.lastNotifiedAt,
    notifyCount: t.version.notifyCount,
    now: deps.now(),
    ...deps.cadence,
  });
  if (!due) return null;
  // Claim ANTES do envio: dois ticks concorrentes não podem mandar o mesmo aviso.
  if (!(await claim())) return { key: t.key, phone: t.phone, outcome: 'claim_lost' };

  // Nome do workspace no lugar do rótulo do número (que costuma ser genérico:
  // "atendimento"). Sem workspace ou sem resposta, fica o rótulo — nunca bloqueia.
  const workspaceName =
    t.workspaceId && deps.resolveWorkspaceName
      ? await deps.resolveWorkspaceName(t.workspaceId).catch(() => null)
      : null;
  const name = workspaceName ?? t.label;

  let link: Awaited<ReturnType<typeof ensureReconnectLink>>;
  try {
    link = await ensureReconnectLink(deps.pool, {
      instance: t.instance,
      expectedPhone: t.phone,
      label: name,
      workspaceId: t.workspaceId,
      createdBy: 'down-notify',
      maxClicks: deps.link.maxClicks,
      ttlDays: deps.link.ttlDays,
    });
  } catch (err) {
    await release().catch(() => {});
    deps.log.error({ key: t.key, err: (err as Error).message }, 'down-notify: link de reconexão falhou — aviso devolvido');
    return { key: t.key, phone: t.phone, outcome: 'released' };
  }

  const url = reconnectUrl(deps.panelBaseUrl, link.row.token);
  let result: DownSendResult;
  try {
    result = await deps.send({ phone: t.phone, name, downSince: t.downSince, token: link.row.token, link: url });
  } catch (err) {
    // O remetente real nunca lança; um que lance é tratado como rede, para o claim não ficar preso.
    result = { ok: false, networkError: true, detail: (err as Error).message, via: null };
  }

  if (result.ok) {
    deps.log.info(
      { key: t.key, via: result.via, reusedLink: link.reused, count: t.version.notifyCount + 1 },
      'down-notify: aviso enviado',
    );
    return { key: t.key, phone: t.phone, outcome: 'sent', via: result.via, reusedLink: link.reused };
  }
  if (isRetryableSendFailure(result)) {
    await release().catch(() => {});
    deps.log.warn(
      { key: t.key, status: result.status, detail: result.detail },
      'down-notify: envio falhou (transitório) — tenta de novo no próximo tick',
    );
    return { key: t.key, phone: t.phone, outcome: 'released', via: null, reusedLink: link.reused };
  }
  deps.log.error(
    { key: t.key, status: result.status, detail: result.detail },
    'down-notify: envio recusado — espera o intervalo de re-aviso',
  );
  return { key: t.key, phone: t.phone, outcome: 'failed', via: null, reusedLink: link.reused };
}

/** Vigia 1: números de workspace fora do ar. */
export async function sweepDownNumbers(deps: DownNotifyDeps): Promise<NotifyAttempt[]> {
  const attempts: NotifyAttempt[] = [];
  for (const n of await listDownNumbers(deps.pool)) {
    const version = { lastNotifiedAt: n.lastNotifiedAt, notifyCount: n.notifyCount };
    const r = await notifyOne(
      deps,
      {
        key: `number:${n.id}`,
        instance: n.instance,
        phone: n.phone,
        label: n.label,
        workspaceId: n.workspaceId,
        downSince: n.downSince,
        version,
      },
      () => claimNumberNotification(deps.pool, n.id, version),
      () => releaseNumberNotification(deps.pool, n.id, version),
    );
    if (r) attempts.push(r);
  }
  return attempts;
}

export type SystemProbe = {
  connectionState: (instance: string) => Promise<'open' | 'connecting' | 'close'>;
  latestStoreTs: (instance: string) => Promise<Date | null>;
  /** Instâncias-controle: as conectadas em whatsapp_numbers. */
  listPeerInstances: () => Promise<string[]>;
};

export type SystemAssessment = {
  target: SystemTarget;
  state: 'open' | 'connecting' | 'close';
  verdict: SystemHealth;
  ownStoreTs: Date | null;
  peerStoreTs: Date | null;
  row: SystemHealthRow;
};

/**
 * Sonda, decide e GRAVA o episódio de cada instância de sistema — sem avisar.
 * Separado do aviso para o CLI de smoke avaliar exatamente como o vigia.
 *
 * Sonda falhando NÃO mexe no episódio (a instância fica fora do resultado): um
 * soluço da Evolution não pode abrir nem fechar queda. Episódio novo começa no
 * início observado (`observedDownSince`), não no instante da detecção.
 */
export async function assessSystemTargets(
  deps: { pool: Pool; log: DownNotifyLog; probe: SystemProbe; staleMs: number },
  targets: SystemTarget[],
): Promise<SystemAssessment[]> {
  let peers: string[] = [];
  try {
    peers = await deps.probe.listPeerInstances();
  } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'down-notify: lista de pares falhou — só o estado decide');
  }
  const instances = [...new Set([...peers, ...targets.map((t) => t.instance)])];

  // Um store por instância por tick: o mesmo par serve de controle para todos os alvos.
  const storeTs = new Map<string, Date | null>();
  const storeFailed = new Set<string>();
  for (const i of instances) {
    try {
      storeTs.set(i, await deps.probe.latestStoreTs(i));
    } catch {
      storeFailed.add(i);
    }
  }

  const out: SystemAssessment[] = [];
  for (const t of targets) {
    let state: 'open' | 'connecting' | 'close';
    try {
      state = await deps.probe.connectionState(t.instance);
    } catch (err) {
      deps.log.warn(
        { instance: t.instance, err: (err as Error).message },
        'down-notify: sonda de estado falhou — episódio intocado',
      );
      continue;
    }
    if (storeFailed.has(t.instance)) {
      deps.log.warn({ instance: t.instance }, 'down-notify: sonda do store falhou — episódio intocado');
      continue;
    }

    const ownStoreTs = storeTs.get(t.instance) ?? null;
    let peerStoreTs: Date | null = null;
    for (const i of instances) {
      if (i === t.instance) continue;
      const ts = storeTs.get(i) ?? null;
      if (ts && (!peerStoreTs || ts > peerStoreTs)) peerStoreTs = ts;
    }

    const verdict = decideSystemHealth({ state, ownStoreTs, peerStoreTs, staleMs: deps.staleMs });
    const since = verdict.down ? observedDownSince({ ownStoreTs, peerStoreTs }) : null;
    const row = await recordSystemHealth(deps.pool, t, { ...verdict, state, ownStoreTs, peerStoreTs }, since);
    if (verdict.down) {
      deps.log.info(
        { instance: t.instance, reason: verdict.reason, state, ownStoreTs, peerStoreTs, downSince: row.downSince },
        'down-notify: instância de sistema fora do ar',
      );
    }
    out.push({ target: t, state, verdict, ownStoreTs, peerStoreTs, row });
  }
  return out;
}

/**
 * Vigia 2: instância de SISTEMA (saturno), que não existe em whatsapp_numbers e
 * por isso nunca é vista pelo vigia 1.
 */
export async function runSystemInstanceWatch(
  deps: DownNotifyDeps & { probe: SystemProbe; staleMs: number },
  targets: SystemTarget[],
): Promise<NotifyAttempt[]> {
  const attempts: NotifyAttempt[] = [];
  for (const a of await assessSystemTargets(deps, targets)) {
    if (!a.row.downSince) continue;
    const version = { lastNotifiedAt: a.row.lastNotifiedAt, notifyCount: a.row.notifyCount };
    const r = await notifyOne(
      deps,
      {
        key: `system:${a.target.instance}`,
        instance: a.target.instance,
        phone: a.target.expectedPhone,
        label: a.target.label,
        workspaceId: null,
        downSince: a.row.downSince,
        version,
      },
      () => claimSystemNotification(deps.pool, a.target.instance, version),
      () => releaseSystemNotification(deps.pool, a.target.instance, version),
    );
    if (r) attempts.push(r);
  }
  return attempts;
}
