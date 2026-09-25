import type { Pool } from 'pg';
import {
  decideSystemHealth,
  isRetryableSendFailure,
  observedDownSince,
  reconnectUrl,
  shouldNotify,
  type SystemHealth,
} from './down-notify.js';
import { businessMsBetween, type OffDates } from './business-hours.js';
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
import type { DownSendResult, DownSender, OpsCopySender } from './down-notify-sender.js';
import { opsCopyFor, sameWhatsappNumber } from './down-notify-ops-copy.js';

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
  /**
   * Cópia do aviso para o OPERADOR (template de operação). Ausente = no-op
   * silencioso — é o que acontece sem OPS_NOTIFY_TO configurado.
   */
  sendOpsCopy?: OpsCopySender;
  /** Destino da cópia (OPS_NOTIFY_TO). Serve pra não copiar para o próprio alvo. */
  opsCopyTo?: string;
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

/**
 * Cópia do aviso para o operador — o dono nunca via as quedas, porque o aviso
 * vai para o telefone que caiu.
 *
 * TRÊS invariantes, nesta ordem de importância:
 *
 *  1. NÃO altera o desfecho do aviso principal. Roda DEPOIS dele, dentro de
 *     try/catch próprio, e não toca em claim, contagem (`down_notified_at` /
 *     `down_notify_count`), re-aviso de 12h nem teto de 6. O `NotifyAttempt`
 *     devolvido ao chamador ignora o que acontece aqui.
 *  2. Só sai quando o principal SAIU. Não é economia: um envio principal que
 *     falha de forma transitória libera o claim e é re-tentado no PRÓXIMO TICK
 *     do vigia (minutos), enquanto o envio bem-sucedido respeita a cadência de
 *     re-aviso (12h, teto 6). Copiar na falha ligaria a cópia ao tick e o
 *     operador receberia a mesma queda de minuto em minuto.
 *  3. Não copia quando o alvo JÁ é o número do operador — senão ele recebe a
 *     mesma queda duas vezes.
 */
async function sendOperatorCopy(deps: DownNotifyDeps, t: Target, name: string | null): Promise<void> {
  const send = deps.sendOpsCopy;
  if (!send) return; // sem OPS_NOTIFY_TO configurado: no-op silencioso
  if (sameWhatsappNumber(deps.opsCopyTo, t.phone)) {
    deps.log.info({ key: t.key }, 'down-notify: cópia dispensada — o alvo já é o número do operador');
    return;
  }
  try {
    const { titulo, detalhe } = opsCopyFor({
      name,
      phone: t.phone,
      downSince: t.downSince,
      notifyNumber: t.version.notifyCount + 1,
      maxNotifies: deps.cadence.maxNotifies,
    });
    const r = await send(titulo, detalhe);
    if (r.ok) deps.log.info({ key: t.key, via: r.via }, 'down-notify: cópia enviada ao operador');
    else deps.log.warn({ key: t.key, status: r.status, detail: r.detail }, 'down-notify: cópia ao operador falhou');
  } catch (err) {
    deps.log.warn({ key: t.key, err: (err as Error).message }, 'down-notify: cópia ao operador falhou');
  }
}

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
    await sendOperatorCopy(deps, t, name);
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
  /**
   * O store ficou para trás do par com a Evolution dizendo `open`. Desde a sonda de
   * conexão isso NÃO abre episódio (nem conta como suspeita): é só o gatilho para a
   * sonda confirmar (spec 2026-09-25 §7).
   */
  storeStale: boolean;
};

/**
 * Sonda, decide e GRAVA o episódio de cada instância de sistema — sem avisar.
 * Separado do aviso para o CLI de smoke avaliar exatamente como o vigia.
 *
 * Sonda falhando NÃO mexe no episódio (a instância fica fora do resultado): um
 * soluço da Evolution não pode abrir nem fechar queda. Episódio novo começa no
 * início observado (`observedDownSince`), não no instante da detecção — e só
 * abre no SEGUNDO tick consecutivo fora (`planEpisode`): o primeiro é suspeita,
 * com `row.downSince` nulo, e por isso não avisa.
 */
export type SystemWatchOpts = {
  staleMs: number;
  /** Intervalo entre ticks do vigia — dimensiona a janela em que a 2ª observação confirma a suspeita. */
  intervalMs: number;
  /** Datas extras sem expediente (além dos feriados nacionais). */
  offDates?: OffDates;
};

export async function assessSystemTargets(
  deps: { pool: Pool; log: DownNotifyLog; probe: SystemProbe } & SystemWatchOpts,
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

    const verdict = decideSystemHealth({
      state,
      ownStoreTs,
      peerStoreTs,
      staleMs: deps.staleMs,
      // Alvo de horário comercial (o padrão): o atraso do store só conta em expediente.
      elapsedMs: t.traffic === 'always' ? undefined : (from, to) => businessMsBetween(from, to, deps.offDates),
    });
    // Só o ESTADO abre episódio pela máquina do tick. `store_stale` grava como
    // saudável (`last_reason` NULL): se contasse como suspeita, o flap diário de 1s
    // (`connecting` num tick, `open`+store atrasado no seguinte) confirmaria direto
    // — a regressão do 21/09. A confirmação dele é da sonda (openSystemProbeEpisode).
    const stateDown = verdict.down && verdict.reason === 'state';
    const storeStale = verdict.down && verdict.reason === 'store_stale';
    const since = stateDown ? observedDownSince({ ownStoreTs, peerStoreTs }) : null;
    const row = await recordSystemHealth(
      deps.pool,
      t,
      { down: stateDown, reason: stateDown ? 'state' : null, state, ownStoreTs, peerStoreTs },
      since,
      deps.intervalMs,
    );
    if (storeStale && !row.downSince) {
      deps.log.info(
        { instance: t.instance, state, ownStoreTs, peerStoreTs },
        'down-notify: store da instância de sistema atrasado — gatilho de sonda, sem episódio',
      );
    } else if (stateDown) {
      deps.log.info(
        { instance: t.instance, reason: 'state', state, ownStoreTs, peerStoreTs, downSince: row.downSince },
        row.downSince
          ? 'down-notify: instância de sistema fora do ar'
          : 'down-notify: instância de sistema suspeita — só vira episódio se outra observação confirmar',
      );
    }
    out.push({ target: t, state, verdict, ownStoreTs, peerStoreTs, row, storeStale });
  }
  return out;
}

/**
 * Vigia 2: instância de SISTEMA (saturno), que não existe em whatsapp_numbers e
 * por isso nunca é vista pelo vigia 1.
 */
export async function runSystemInstanceWatch(
  deps: DownNotifyDeps & { probe: SystemProbe } & SystemWatchOpts,
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
