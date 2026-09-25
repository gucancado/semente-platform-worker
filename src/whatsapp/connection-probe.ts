/**
 * Sonda de conexão — decisões PURAS (sem config, pool ou rede).
 * Ver spec 2026-09-25-sonda-conexao-whatsapp-design.md §5–§6.
 */

export const PROBE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PROBE_WAIT_MS = 5 * 60_000;
export const PROBE_DELIVERY_WINDOW_MS = 30 * 60_000;
export const PROBE_COOLDOWN_MS = 24 * 3_600_000;
export const PROBE_RETRY_MS = 3_600_000;
export const PROBE_MAX_PRIMARY_24H = 3;
export const PROBE_QUIET_MS = 12 * 3_600_000;
export const PROBE_MAX_NEW_PER_TICK = 3;
export const PROBE_GENERAL_SILENCE_RATIO = 0.5;
export const PROBE_INCONCLUSIVE_ALERT = 3;

export type Verdict =
  | 'alive' | 'repeated' | 'pipeline_broken' | 'down' | 'send_failed' | 'inconclusive' | 'identity_mismatch';
export type Trigger = 'store_stale' | 'quiet';
export type CloudStatus = 'sent' | 'delivered' | 'read' | 'failed';

export function generateProbeCode(rand: () => number, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += PROBE_CODE_ALPHABET[Math.floor(rand() * PROBE_CODE_ALPHABET.length) % PROBE_CODE_ALPHABET.length];
    if (!taken.has(c)) return c;
  }
  throw new Error('sonda: sem código livre');
}

const SP_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' });

export function inProbeSendWindow(now: Date): boolean {
  const h = Number(SP_HOUR.format(now));
  return h >= 8 && h < 20;
}

export function probeTexts(name: string | null, phone: string, code: string): { titulo: string; detalhe: string } {
  const n = name?.replace(/\s+/g, ' ').trim();
  const quem = n ? `${n} (${phone})` : phone;
  return { titulo: `Teste de conexão do WhatsApp ${quem}`, detalhe: `Código ${code}. Não é preciso responder.` };
}

export type ProbeHistory = {
  hasOpen: boolean;
  lastVerdict: { verdict: Verdict; ageMs: number } | null;
  primaryCount24h: number;
  lastQuietAgeMs: number | null;
  consecutiveInconclusive: number;
};

export function decideTrigger(i: {
  state: 'open' | 'connecting' | 'close';
  ownStoreTs: Date | null;
  peerStoreTs: Date | null;
  now: Date;
  staleMs: number;
  businessElapsedMs: (from: Date, to: Date) => number;
  episodeOpen: boolean;
  history: ProbeHistory;
}): Trigger | null {
  if (i.state !== 'open' || i.episodeOpen || i.history.hasOpen) return null;
  const lv = i.history.lastVerdict;
  if (lv) {
    const long = lv.verdict === 'alive' || lv.verdict === 'pipeline_broken' || lv.verdict === 'identity_mismatch';
    if (long && lv.ageMs < PROBE_COOLDOWN_MS) return null;
    if ((lv.verdict === 'inconclusive' || lv.verdict === 'send_failed') && lv.ageMs < PROBE_RETRY_MS) return null;
  }
  if (i.history.primaryCount24h >= PROBE_MAX_PRIMARY_24H) return null;

  // Peer ahead logic: only return 'store_stale' if lag is significant (>= staleMs).
  // If lag < staleMs, fall through to quiet check because in general silence, most instances
  // have a peer slightly ahead (max over all others), making silent-candidate detection impossible.
  const peerAhead = i.peerStoreTs && (!i.ownStoreTs || i.peerStoreTs > i.ownStoreTs);
  if (peerAhead) {
    if (!i.ownStoreTs) {
      // Peer has data, we don't: peer is definitely ahead
      return 'store_stale';
    }
    const lag = i.businessElapsedMs(i.ownStoreTs, i.peerStoreTs!);
    if (lag >= i.staleMs) {
      return 'store_stale';
    }
    // lag < staleMs: fall through to quiet evaluation
  }
  const quietFor = i.ownStoreTs ? i.now.getTime() - i.ownStoreTs.getTime() : Infinity;
  if (quietFor < PROBE_QUIET_MS) return null;
  if (i.history.lastQuietAgeMs != null && i.history.lastQuietAgeMs < PROBE_COOLDOWN_MS) return null;
  return 'quiet';
}

export function pickCandidates<T extends { trigger: Trigger }>(
  cands: T[],
  totalOpenTargets: number,
): { send: T[]; generalSilence: boolean } {
  const quiet = cands.filter((c) => c.trigger === 'quiet').length;
  const generalSilence = totalOpenTargets > 0 && quiet / totalOpenTargets >= PROBE_GENERAL_SILENCE_RATIO;
  const pool = generalSilence ? cands.filter((c) => c.trigger !== 'quiet') : cands;
  const ordered = [...pool.filter((c) => c.trigger === 'store_stale'), ...pool.filter((c) => c.trigger === 'quiet')];
  return { send: ordered.slice(0, PROBE_MAX_NEW_PER_TICK), generalSilence };
}

export function decideVerdict(p: {
  isRepeat: boolean;
  received: boolean;
  storeSeen: boolean;
  cloudStatus: CloudStatus | null;
  ageMs: number;
}): Verdict | 'wait' {
  if (p.received) return 'alive';
  if (p.ageMs < PROBE_WAIT_MS) return 'wait';
  if (p.cloudStatus === 'failed') return 'send_failed';
  if (p.storeSeen) return p.isRepeat ? 'pipeline_broken' : 'repeated';
  if (p.cloudStatus === 'delivered' || p.cloudStatus === 'read') return p.isRepeat ? 'down' : 'repeated';
  return p.ageMs >= PROBE_DELIVERY_WINDOW_MS ? 'inconclusive' : 'wait';
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
export function cloudStatusRank(s: string | null): number {
  return s ? RANK[s] ?? 0 : 0;
}

export function reconcileStatus(state: 'open' | 'connecting' | 'close', status: string): 'connected' | 'disconnected' | null {
  if (state === 'open' && status !== 'connected') return 'connected';
  if (state === 'close' && status === 'connected') return 'disconnected';
  return null;
}

// ── Config de boot da sonda (spec §11) ───────────────────────────────────────
//
// Vive aqui, e não em `down-notify-start.ts`, porque este módulo é ZERO-IMPORT
// (sem config/pool/rede) — importar `down-notify-start.ts` (que importa
// `config.ts`, que faz `EnvSchema.parse(process.env)` no top-level do módulo)
// obriga qualquer teste puro dessa função a rodar com `--env-file`, mesmo sem
// nenhuma dependência real de env. `down-notify-start.ts` re-exporta os três
// símbolos abaixo pra quem já importa dali continuar funcionando.

export type ProbeConfigEnv = {
  mode: 'off' | 'on';
  ownPhones: string[];
  mirror?: 'off' | 'on';
  opsTo?: string;
};
export type ProbeConfigResult = { mode: 'off' } | { error: string } | { mode: 'on'; mirrorTo: string | null };

/**
 * Config da sonda de conexão, resolvida de forma PURA: `mode:'off'` (ou
 * ausência dele) é "não inicia"; `mode:'on'` sem telefone próprio é erro
 * declarado — nunca deriva um estado "on" quebrado.
 */
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
 * Exportada porque `index.ts` e `down-notify-start.ts` precisam da MESMA
 * decisão pra saber se a sonda está ligada — reconstruir a condição em cada
 * lugar (ex.: só checar `CONNECTION_PROBE_MODE==='on'`) divergiria de
 * `buildProbeConfig` no dia em que este ganhar uma regra nova.
 */
export function probeStarted(r: ProbeConfigResult): { mode: 'on'; mirrorTo: string | null } | null {
  return 'mode' in r && r.mode === 'on' ? r : null;
}
