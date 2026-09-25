import type { Pool } from 'pg';
import type { MessageKey } from '../evolution/client.js';
import { businessMsBetween, type OffDates } from './business-hours.js';
import {
  decideTrigger,
  decideVerdict,
  generateProbeCode,
  inProbeSendWindow,
  pickCandidates,
  probeTexts,
  reconcileStatus,
  PROBE_COOLDOWN_MS,
  PROBE_INCONCLUSIVE_ALERT,
  PROBE_WAIT_MS,
  type Trigger,
  type Verdict,
} from './connection-probe.js';
import {
  closeProbeEpisode,
  createProbe,
  listOpenProbes,
  markProbeSent,
  openNumberProbeEpisode,
  probeHistory,
  recordProbeReceipt,
  setVerdict,
  takenCodes,
  type ProbeRow,
} from './connection-probe-store.js';
import { openSystemProbeEpisode, type SystemTarget } from './down-notify-store.js';
import type { DownNotifyLog } from './down-notify-service.js';
import { sameWhatsappNumber } from './down-notify-ops-copy.js';

/**
 * Sonda de conexão — orquestração por TICK (spec 2026-09-25-sonda-conexao-whatsapp-design.md
 * §4–§8, §12). Junta as decisões puras (`connection-probe.ts`), a camada de banco
 * (`connection-probe-store.ts`), a Evolution, o envio Cloud e os episódios de queda.
 *
 * Ordem de um tick (cada instância em try/catch próprio — falha de uma não para as outras):
 *   1. VEREDITOS das sondas abertas. Roda também FORA da janela de envio.
 *   2. RECONCILIAÇÃO estado Evolution ↔ `whatsapp_numbers.status` (só números).
 *   3. GATILHOS (só dentro da janela 08–20h SP): identidade, silêncio geral, anti-rebanho.
 *   4. ENVIO (sonda + espelho ao operador).
 *
 * O aviso ao CLIENTE não sai daqui: abrir o episódio basta. `sweepDownNumbers` avisa o
 * número (lista o episódio `probe` aberto) e `runSystemInstanceWatch` avisa o saturno
 * (a leitura `open` do tick seguinte MANTÉM o episódio `probe` — `planEpisode` 'keep' —
 * e a `row.downSince` resultante passa pelo `notifyOne`).
 *
 * Decisões desta camada (ver task-9-report):
 *  - FORA da janela nenhum envio, nem a 2ª sonda de um `repeated`: a 1ª fica `repeated`
 *    e o par recomeça no dia seguinte. Avisos OPERACIONAIS (ao operador) saem a qualquer hora.
 *  - Silêncio geral: 1 aviso por 24h por PROCESSO (memória em `ProbeMemo`); rolling
 *    deploy pode mandar 2.
 *  - 3 `inconclusive` seguidos: avisa só quando a contagem é EXATAMENTE 3.
 */

export type ProbeTarget = {
  instance: string;
  kind: 'number' | 'system';
  numberId: number | null;
  phone: string;
  label: string | null;
  workspaceId: string | null;
  /** `whatsapp_numbers.status`; null para sistema. */
  status: string | null;
  /** Para sistema. */
  systemTarget: SystemTarget | null;
};

/** Memória em processo do aviso de silêncio geral (1 por 24h). */
export type ProbeMemo = { generalSilenceAt: number | null };
export function newProbeMemo(): ProbeMemo {
  return { generalSilenceAt: null };
}
const PROCESS_MEMO: ProbeMemo = newProbeMemo();

export type ProbeDeps = {
  pool: Pool;
  /** `debug` opcional (adicionado): 404 da Evolution na reconciliação loga aqui. */
  log: DownNotifyLog & { debug?: (...args: any[]) => void };
  now: () => Date;
  rand: () => number;
  evolution: {
    connectionState(i: string): Promise<'open' | 'connecting' | 'close'>;
    /** Já sem o nosso tráfego (aviso de queda, cópia, sonda). */
    latestStoreTs(i: string): Promise<Date | null>;
    owner(i: string): Promise<string | null>;
    findProbe(i: string, code: string, sinceSec: number): Promise<boolean>;
    markRead(i: string, key: MessageKey): Promise<void>;
    archive(i: string, key: MessageKey): Promise<void>;
  };
  sendProbe(to: string, titulo: string, detalhe: string): Promise<{ ok: boolean; wamid: string | null; detail?: unknown }>;
  /** Aviso operacional, best-effort. */
  sendOps(titulo: string, detalhe: string): Promise<void>;
  /** OPS_NOTIFY_TO quando CONNECTION_PROBE_MIRROR=on. */
  mirrorTo: string | null;
  resolveName(t: ProbeTarget): Promise<string | null>;
  staleMs: number;
  offDates: OffDates;
  updateNumberStatus(instance: string, status: 'connected' | 'disconnected'): Promise<void>;
  /** Opcional (adicionado): memória do silêncio geral; ausente = singleton do processo. */
  memo?: ProbeMemo;
};

/** Margem de relógio (Evolution × banco) na parada da varredura do store. */
const STORE_SCAN_SKEW_SEC = 120;

export async function listProbeTargets(pool: Pool, system: SystemTarget[]): Promise<ProbeTarget[]> {
  const out: ProbeTarget[] = system.map((t) => ({
    instance: t.instance,
    kind: 'system' as const,
    numberId: null,
    phone: t.expectedPhone,
    label: t.label,
    workspaceId: null,
    status: null,
    systemTarget: t,
  }));
  const sys = new Set(system.map((t) => t.instance));
  const { rows } = await pool.query(
    `SELECT id, evolution_instance, phone, label, workspace_id, status
       FROM whatsapp_numbers
      WHERE removed_at IS NULL AND phone IS NOT NULL
      ORDER BY id`,
  );
  for (const r of rows) {
    if (sys.has(r.evolution_instance)) continue;
    out.push({
      instance: r.evolution_instance,
      kind: 'number',
      numberId: Number(r.id),
      phone: r.phone,
      label: r.label,
      workspaceId: r.workspace_id,
      status: r.status,
      systemTarget: null,
    });
  }
  return out;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const is404 = (e: unknown) => /→ 404\b/.test(errMsg(e));

async function safeOps(deps: ProbeDeps, titulo: string, detalhe: string): Promise<void> {
  try {
    await deps.sendOps(titulo, detalhe);
  } catch (err) {
    deps.log.warn({ err: errMsg(err), titulo }, 'sonda: aviso operacional falhou');
  }
}

function who(p: { instance: string; phone: string; label: string | null }): string {
  return `${p.label ? `${p.label} ` : ''}(${p.phone}, instância ${p.instance})`;
}

/** Ler + arquivar, best-effort e independentes (uma falha não impede a outra). */
function readAndArchive(deps: Pick<ProbeDeps, 'log' | 'evolution'>, instance: string, key: MessageKey): Promise<void> {
  const guard = (what: string, p: Promise<void>) =>
    p.catch((err) => deps.log.warn({ instance, err: errMsg(err) }, `sonda: ${what} falhou`));
  return Promise.all([
    guard('marcar como lida', deps.evolution.markRead(instance, key)),
    guard('arquivar', deps.evolution.archive(instance, key)),
  ]).then(() => undefined);
}

async function onAlive(deps: ProbeDeps, p: ProbeRow): Promise<void> {
  if (p.msgKey) await readAndArchive(deps, p.instance, p.msgKey);
  await closeProbeEpisode(deps.pool, p.instance);
}

function targetFor(targets: ProbeTarget[], p: ProbeRow): ProbeTarget {
  return (
    targets.find((t) => t.instance === p.instance) ?? {
      instance: p.instance,
      kind: p.kind,
      numberId: p.numberId,
      phone: p.phone,
      label: p.label,
      workspaceId: null,
      status: null,
      systemTarget:
        p.kind === 'system' ? { instance: p.instance, expectedPhone: p.phone, label: p.label } : null,
    }
  );
}

/**
 * Cria, envia (sonda + espelho) e grava o envio. `createProbe` null (sonda aberta
 * concorrente — outro container) → não envia. Devolve true se o envio ao alvo saiu.
 */
async function createAndSend(
  deps: ProbeDeps,
  t: ProbeTarget,
  trigger: Trigger,
  parentId: number | null,
): Promise<boolean> {
  const code = generateProbeCode(deps.rand, await takenCodes(deps.pool, t.instance));
  const row = await createProbe(deps.pool, {
    instance: t.instance,
    kind: t.kind,
    numberId: t.numberId,
    phone: t.phone,
    label: t.label,
    trigger,
    parentId,
    code,
  });
  if (!row) return false;

  const name = await deps.resolveName(t).catch(() => t.label);
  const { titulo, detalhe } = probeTexts(name ?? t.label, t.phone, code);
  let res: { ok: boolean; wamid: string | null; detail?: unknown };
  try {
    res = await deps.sendProbe(t.phone, titulo, detalhe);
  } catch (err) {
    res = { ok: false, wamid: null, detail: errMsg(err) };
  }

  let mirrorWamid: string | null = null;
  if (res.ok && deps.mirrorTo && !sameWhatsappNumber(deps.mirrorTo, t.phone)) {
    try {
      const m = await deps.sendProbe(deps.mirrorTo, titulo, detalhe);
      mirrorWamid = m.wamid;
      if (!m.ok) deps.log.warn({ instance: t.instance, detail: m.detail }, 'sonda: espelho ao operador falhou');
    } catch (err) {
      deps.log.warn({ instance: t.instance, err: errMsg(err) }, 'sonda: espelho ao operador falhou');
    }
  }

  await markProbeSent(deps.pool, row.id, {
    wamid: res.wamid,
    mirrorWamid,
    sendError: res.ok ? null : (res.detail ?? 'envio falhou'),
  });
  if (!res.ok) {
    deps.log.warn({ instance: t.instance, detail: res.detail }, 'sonda: envio falhou');
    await safeOps(deps, 'Sonda de conexão não enviada', `Envio da sonda ${code} para ${who(t)} falhou.`);
    return false;
  }
  deps.log.info({ instance: t.instance, code, trigger, parentId }, 'sonda: enviada');
  return true;
}

/** Última mensagem real do store (início estimado do episódio) — falha vira null. */
async function storeTsOrNull(deps: ProbeDeps, instance: string): Promise<Date | null> {
  try {
    return await deps.evolution.latestStoreTs(instance);
  } catch {
    return null;
  }
}

async function firstSentAtOf(deps: ProbeDeps, p: ProbeRow): Promise<Date> {
  const id = p.parentId ?? p.id;
  const { rows } = await deps.pool.query(
    `SELECT COALESCE(sent_at, created_at) AS first_sent_at FROM connection_probes WHERE id = $1`,
    [id],
  );
  return rows[0]?.first_sent_at ?? p.sentAt ?? deps.now();
}

async function evaluateProbe(
  deps: ProbeDeps,
  p: ProbeRow,
  targets: ProbeTarget[],
  inWindow: boolean,
  tally: (v: string) => void,
): Promise<number> {
  const received = p.receivedAt != null;
  let storeSeen = false;
  if (!received && p.ageMs >= PROBE_WAIT_MS && p.sentAt && p.cloudStatus !== 'failed') {
    const sinceSec = Math.floor(new Date(p.sentAt).getTime() / 1000) - STORE_SCAN_SKEW_SEC;
    storeSeen = await deps.evolution.findProbe(p.instance, p.code, sinceSec);
  }
  const v = decideVerdict({
    isRepeat: p.parentId != null,
    received,
    storeSeen,
    cloudStatus: p.cloudStatus,
    ageMs: p.ageMs,
  });
  if (v === 'wait') return 0;

  if (v === 'alive') {
    if ((await setVerdict(deps.pool, p.id, 'alive')) === 'set') tally('alive');
    await onAlive(deps, p);
    return 0;
  }

  const r = await setVerdict(deps.pool, p.id, v, { storeSeen });
  if (r === 'already') return 0;
  if (r === 'received') {
    // Chegou entre a leitura e a gravação: é `alive` (spec §6).
    tally('alive');
    await closeProbeEpisode(deps.pool, p.instance);
    return 0;
  }
  tally(v);
  const t = targetFor(targets, p);

  switch (v as Exclude<Verdict, 'alive'>) {
    case 'repeated': {
      if (!inWindow) {
        deps.log.info({ instance: p.instance }, 'sonda: repeated fora da janela — o par recomeça amanhã');
        return 0;
      }
      return (await createAndSend(deps, t, p.trigger, p.id)) ? 1 : 0;
    }
    case 'down': {
      const startedAt = await storeTsOrNull(deps, p.instance);
      const firstSentAt = await firstSentAtOf(deps, p);
      if (p.kind === 'system') {
        const st = t.systemTarget ?? { instance: p.instance, expectedPhone: p.phone, label: p.label };
        await openSystemProbeEpisode(deps.pool, st, startedAt, firstSentAt, p.trigger);
      } else if (p.numberId != null) {
        await openNumberProbeEpisode(deps.pool, {
          instance: p.instance,
          numberId: p.numberId,
          startedAt,
          firstSentAt,
          trigger: p.trigger,
        });
      } else {
        deps.log.warn({ instance: p.instance }, 'sonda: down de número sem number_id — episódio não aberto');
      }
      deps.log.info({ instance: p.instance, trigger: p.trigger }, 'sonda: queda confirmada');
      return 0;
    }
    case 'pipeline_broken':
      await safeOps(
        deps,
        'Sonda de conexão: mensagem no store mas não no worker',
        `A sonda ${p.code} de ${who(p)} chegou ao aparelho mas o webhook não a entregou ao worker (2 vezes).`,
      );
      return 0;
    case 'send_failed':
      await safeOps(deps, 'Sonda de conexão: envio falhou', `O Cloud recusou a sonda ${p.code} para ${who(p)}.`);
      return 0;
    case 'inconclusive': {
      const h = await probeHistory(deps.pool, p.instance);
      if (h.consecutiveInconclusive === PROBE_INCONCLUSIVE_ALERT) {
        await safeOps(
          deps,
          'Sonda de conexão: 3 testes sem entrega',
          `As 3 últimas sondas de ${who(p)} não foram entregues pelo Cloud — nosso número bloqueado ou webhook do Cloud quebrado?`,
        );
      }
      return 0;
    }
    default:
      return 0;
  }
}

/**
 * Um tick da sonda. Devolve quantas sondas saíram (1ª e 2ª, sem o espelho) e a
 * contagem de vereditos gravados neste tick.
 */
export async function runProbeTick(
  deps: ProbeDeps,
  targets: ProbeTarget[],
): Promise<{ sent: number; verdicts: Record<string, number> }> {
  const verdicts: Record<string, number> = {};
  const tally = (v: string) => {
    verdicts[v] = (verdicts[v] ?? 0) + 1;
  };
  let sent = 0;
  const now = deps.now();
  const inWindow = inProbeSendWindow(now);
  const memo = deps.memo ?? PROCESS_MEMO;

  // 1. Vereditos das sondas abertas.
  let open: ProbeRow[] = [];
  try {
    open = await listOpenProbes(deps.pool);
  } catch (err) {
    deps.log.error({ err: errMsg(err) }, 'sonda: leitura das sondas abertas falhou');
  }
  for (const p of open) {
    try {
      sent += await evaluateProbe(deps, p, targets, inWindow, tally);
    } catch (err) {
      deps.log.error({ instance: p.instance, probeId: p.id, err: errMsg(err) }, 'sonda: veredito falhou');
    }
  }

  // 2. Estado Evolution + reconciliação (números).
  const openTargets: ProbeTarget[] = [];
  for (const t of targets) {
    try {
      const state = await deps.evolution.connectionState(t.instance);
      if (t.kind === 'number') {
        const r = reconcileStatus(state, t.status ?? '');
        if (r) {
          await deps.updateNumberStatus(t.instance, r);
          deps.log.info({ instance: t.instance, state, from: t.status, to: r }, 'sonda: status reconciliado com a Evolution');
        }
      }
      if (state === 'open') openTargets.push(t);
    } catch (err) {
      if (is404(err)) deps.log.debug?.({ instance: t.instance }, 'sonda: instância inexistente na Evolution — ignorada');
      else deps.log.warn({ instance: t.instance, err: errMsg(err) }, 'sonda: estado da instância falhou');
    }
  }

  // 3. Gatilhos — só dentro da janela.
  if (!inWindow) return { sent, verdicts };

  const storeTs = new Map<string, Date | null>();
  for (const t of openTargets) {
    try {
      storeTs.set(t.instance, await deps.evolution.latestStoreTs(t.instance));
    } catch (err) {
      deps.log.warn({ instance: t.instance, err: errMsg(err) }, 'sonda: leitura do store falhou — sem gatilho');
    }
  }
  const businessElapsedMs = (a: Date, b: Date) => businessMsBetween(a, b, deps.offDates);

  const cands: { t: ProbeTarget; trigger: Trigger }[] = [];
  for (const t of openTargets) {
    if (!storeTs.has(t.instance)) continue;
    try {
      const ownStoreTs = storeTs.get(t.instance) ?? null;
      let peerStoreTs: Date | null = null;
      for (const [i, ts] of storeTs) {
        if (i === t.instance || !ts) continue;
        if (!peerStoreTs || ts > peerStoreTs) peerStoreTs = ts;
      }
      const { rows } = await deps.pool.query(
        `SELECT EXISTS (SELECT 1 FROM instance_outages WHERE instance = $1 AND ended_at IS NULL)
             OR EXISTS (SELECT 1 FROM system_instance_health WHERE instance = $1 AND down_since IS NOT NULL) AS open`,
        [t.instance],
      );
      const history = await probeHistory(deps.pool, t.instance);
      const trigger = decideTrigger({
        state: 'open',
        ownStoreTs,
        peerStoreTs,
        now,
        staleMs: deps.staleMs,
        businessElapsedMs,
        episodeOpen: rows[0].open === true,
        history,
      });
      if (!trigger) continue;

      // Identidade (§4): o aparelho pareado tem que ser o telefone gravado.
      const owner = await deps.evolution.owner(t.instance);
      if (!owner) {
        deps.log.warn({ instance: t.instance }, 'sonda: dono da instância desconhecido — não sonda');
        continue;
      }
      if (!sameWhatsappNumber(owner, t.phone)) {
        const code = generateProbeCode(deps.rand, await takenCodes(deps.pool, t.instance));
        const row = await createProbe(deps.pool, {
          instance: t.instance,
          kind: t.kind,
          numberId: t.numberId,
          phone: t.phone,
          label: t.label,
          trigger,
          code,
        });
        if (!row) continue;
        if ((await setVerdict(deps.pool, row.id, 'identity_mismatch')) !== 'set') continue;
        tally('identity_mismatch');
        deps.log.warn({ instance: t.instance, owner, phone: t.phone }, 'sonda: aparelho pareado diverge do telefone');
        await safeOps(
          deps,
          'Sonda de conexão: aparelho diferente do cadastrado',
          `A instância ${t.instance}${t.label ? ` (${t.label})` : ''} está pareada com ${owner}, mas o telefone gravado é ${t.phone}. Não sondada.`,
        );
        continue;
      }
      cands.push({ t, trigger });
    } catch (err) {
      deps.log.error({ instance: t.instance, err: errMsg(err) }, 'sonda: avaliação de gatilho falhou');
    }
  }

  const { send, generalSilence } = pickCandidates(cands, openTargets.length);
  if (generalSilence) {
    const last = memo.generalSilenceAt;
    if (last == null || now.getTime() - last >= PROBE_COOLDOWN_MS) {
      memo.generalSilenceAt = now.getTime();
      const quiet = cands.filter((c) => c.trigger === 'quiet').map((c) => c.t.instance);
      deps.log.warn({ quiet, open: openTargets.length }, 'sonda: silêncio geral — sondas quiet suspensas');
      await safeOps(
        deps,
        'Silêncio geral no WhatsApp',
        `${quiet.length} de ${openTargets.length} números conectados sem tráfego há 12h+ (${quiet.join(', ')}). Evolution ou WhatsApp fora?`,
      );
    }
  }

  // 4. Envio.
  for (const c of send) {
    try {
      if (await createAndSend(deps, c.t, c.trigger, null)) sent++;
    } catch (err) {
      deps.log.error({ instance: c.t.instance, err: errMsg(err) }, 'sonda: envio falhou');
    }
  }
  return { sent, verdicts };
}

/**
 * Recebimento da sonda pelo webhook (porta anti-CRM). Roda DENTRO da requisição do
 * webhook, então fica rápido: ler/arquivar vai em fire-and-forget (erro só loga) —
 * o tick repete no veredito `alive`, e as duas chamadas são idempotentes.
 *
 * Recebimento TARDIO (sonda já com veredito negativo): fecha o episódio `probe` da
 * instância (Review Focus 2). Se a sonda casada é a 1ª de um par (`repeated`), a 2ª
 * ainda aberta ganha `alive` — a mensagem da 1ª chegou, então a sessão está viva, e
 * sem isto a 2ª poderia virar `down` falso.
 */
export async function handleProbeReceipt(
  deps: Pick<ProbeDeps, 'pool' | 'log' | 'evolution'>,
  instance: string,
  code: string,
  key: MessageKey,
): Promise<void> {
  const row = await recordProbeReceipt(deps.pool, instance, code, key);
  if (!row) {
    deps.log.info({ instance, code }, 'sonda: recebimento sem sonda correspondente');
    return;
  }
  void readAndArchive(deps, instance, key);
  if (row.verdict === 'repeated') {
    const { rows } = await deps.pool.query(
      `SELECT id FROM connection_probes WHERE parent_id = $1 AND verdict IS NULL`,
      [row.id],
    );
    for (const c of rows) await setVerdict(deps.pool, Number(c.id), 'alive');
  }
  if (row.verdict != null && row.verdict !== 'alive') {
    const closed = await closeProbeEpisode(deps.pool, instance);
    deps.log.info({ instance, code, verdict: row.verdict, closed }, 'sonda: recebimento tardio');
  } else {
    deps.log.info({ instance, code }, 'sonda: recebida');
  }
}
