/**
 * Aviso por WhatsApp para o PRÓPRIO número que caiu — núcleo puro.
 *
 * Sem banco e sem rede, para ser testável e idêntico nos dois vigias (números
 * de workspace e instância de sistema). Três decisões moram aqui:
 *  - quando avisar (debounce, re-aviso, teto por episódio);
 *  - se uma instância de sistema está fora (sinal composto);
 *  - se uma falha de envio merece nova tentativa já no próximo tick.
 */

export const DEFAULT_PANEL_PUBLIC_URL = 'https://painel.beeads.com.br';

const BRT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `09/09 às 18:10` sempre em São Paulo — o container roda em UTC. */
export function fmtBrtShort(d: Date): string {
  const parts = Object.fromEntries(BRT.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}

/** URL pública do link de reconexão (feature de link deslogado). */
export function reconnectUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/reconectar-whatsapp/${token}`;
}

export type NotifyCadence = {
  /** Início do episódio de queda; null = saudável. */
  downSince: Date | null;
  lastNotifiedAt: Date | null;
  notifyCount: number;
  now: Date;
  debounceMs: number;
  renotifyMs: number;
  maxNotifies: number;
};

/**
 * Um aviso por episódio é pouco: mensagem de alerta se perde. Então re-avisa a
 * cada `renotifyMs`, até `maxNotifies` — o teto existe porque um número
 * abandonado de propósito não pode receber aviso para sempre.
 */
export function shouldNotify(c: NotifyCadence): boolean {
  if (!c.downSince) return false;
  const now = c.now.getTime();
  if (now - c.downSince.getTime() < c.debounceMs) return false;
  if (c.notifyCount >= c.maxNotifies) return false;
  if (!c.lastNotifiedAt) return true;
  return now - c.lastNotifiedAt.getTime() >= c.renotifyMs;
}

export type SystemHealthInput = {
  state: 'open' | 'connecting' | 'close';
  /** Mensagem mais recente no store da Evolution desta instância. */
  ownStoreTs: Date | null;
  /** Mais recente entre as instâncias-controle (os pares). */
  peerStoreTs: Date | null;
  staleMs: number;
  /**
   * Como medir o atraso do store entre dois instantes. Ausente = relógio de
   * parede. Alvo que só fala em horário comercial passa o relógio de expediente
   * (`businessMsBetween`) — ver o comentário de `decideSystemHealth`.
   */
  elapsedMs?: (from: Date, to: Date) => number;
};

export type SystemHealth = { down: boolean; reason: 'state' | 'store_stale' | null };

/**
 * `state` sozinho NÃO basta: medido em 2026-09-12, o número 18 reportava `open`
 * na Evolution e `connected` no worker enquanto seu store não recebia nada havia
 * 4 dias — a sessão morre por dentro sem mudar o estado.
 *
 * Por isso o segundo sinal é o store ficar para trás do de um PAR que segue
 * recebendo. O par continua sendo a régua: se NINGUÉM recebeu nada depois da
 * última mensagem do alvo (Evolution fora, WhatsApp fora), ninguém é denunciado.
 * Sem par para comparar, só o estado decide.
 *
 * ⚠️ O par sozinho NÃO protege madrugada e domingo — a premissa original ("se
 * todo mundo está quieto, o par também está") é falsa quando alvo e par têm
 * PERFIS diferentes. Medido em 2026-09-21: os pares são números de atendimento,
 * que recebem lead a qualquer hora; o saturno só está em grupos de equipe, mudos
 * fora do expediente. Pelo relógio de parede isso deu 11 avisos falsos em uma
 * semana. Por isso o atraso é medido por `elapsedMs`: para alvo de horário
 * comercial, só o tempo de EXPEDIENTE entre a última mensagem dele e a do par.
 */
export function decideSystemHealth(i: SystemHealthInput): SystemHealth {
  if (i.state !== 'open') return { down: true, reason: 'state' };
  if (!i.peerStoreTs) return { down: false, reason: null };
  if (!i.ownStoreTs) return { down: true, reason: 'store_stale' };
  const elapsed = i.elapsedMs ?? wallClockMs;
  return elapsed(i.ownStoreTs, i.peerStoreTs) >= i.staleMs
    ? { down: true, reason: 'store_stale' }
    : { down: false, reason: null };
}

function wallClockMs(from: Date, to: Date): number {
  return to.getTime() - from.getTime();
}

/** Trecho do link de reconexão — presente no corpo do aviso (v2) e no botão de URL (v1). */
const NOTICE_LINK_MARK = '/reconectar-whatsapp/';
/** Frase fixa do corpo aprovado. Segunda marca, para o aviso cujo link chegue reescrito. */
const NOTICE_TEXT_MARK = 'desconectado da BeeAds desde';

/**
 * Este registro do store da Evolution é o AVISO que o próprio vigia mandou?
 *
 * O aviso vai para o PRÓPRIO número vigiado, então cai no store dele como a
 * mensagem mais recente. Contado como tráfego, ele "curava" o episódio no tick
 * seguinte (medido: os 8 episódios falsos de 15–21/09 fecharam 5min depois do
 * aviso), zerava a contagem — re-aviso e teto nunca atuavam — e ainda virava o
 * "desde" da queda seguinte (episódios 77 e 78 começam no horário do aviso
 * anterior). Aviso do vigia não é sinal de vida nem marco de início.
 *
 * O critério é o CONTEÚDO, procurado no JSON inteiro de `message` — não o jid do
 * remetente (que chega como LID de privacidade) nem um campo fixo: o Baileys
 * entrega o mesmo texto como `conversation`, `extendedTextMessage` ou
 * `templateMessage`, conforme o caso. Só vale para DM recebida: o aviso
 * encaminhado a um grupo, ou mandado do próprio aparelho, é tráfego de verdade.
 */
export function isOwnDownNotice(record: unknown): boolean {
  const r = record as { key?: { remoteJid?: unknown; fromMe?: unknown }; message?: unknown } | null | undefined;
  const jid = r?.key?.remoteJid;
  if (typeof jid !== 'string' || jid.endsWith('@g.us')) return false;
  if (r?.key?.fromMe === true) return false;
  if (r?.message == null) return false;
  let body: string;
  try {
    body = JSON.stringify(r.message) ?? '';
  } catch {
    return false;
  }
  return body.includes(NOTICE_LINK_MARK) || body.includes(NOTICE_TEXT_MARK);
}

/** O que o tick anterior deixou gravado sobre o alvo. */
export type EpisodePrev = {
  /** Episódio aberto (início); null = nenhum. */
  downSince: Date | null;
  /** O tick ANTERIOR também viu o alvo fora? */
  sawDown: boolean;
};

export type EpisodePlan = 'healthy' | 'suspect' | 'open' | 'keep' | 'close';

/**
 * Máquina de estados do episódio de queda de uma instância de sistema.
 *
 *   saudável → fora          : 'suspect' — anota, mas NÃO abre episódio nem avisa
 *   suspeita → fora de novo  : 'open'    — dois ticks consecutivos confirmam
 *   suspeita → saudável      : 'healthy' — era um soluço; some sem rastro
 *   episódio → fora          : 'keep'
 *   episódio → saudável      : 'close'   — encerra e zera o aviso
 *
 * Um tick só não basta: a Evolution tem um `connecting→open` de ~1s quase diário,
 * e o debounce não o segura — ele conta a partir do INÍCIO do episódio, que para
 * instância de sistema é a última mensagem do store (sempre mais velha que o
 * debounce). Medido em 2026-09-17: link emitido às 18:39:35, consumido às
 * 18:39:36. A confirmação no tick seguinte é o debounce de verdade deste vigia.
 */
export function planEpisode(prev: EpisodePrev, down: boolean): EpisodePlan {
  if (!down) return prev.downSince ? 'close' : 'healthy';
  if (prev.downSince) return 'keep';
  return prev.sawDown ? 'open' : 'suspect';
}

export type SendOutcome =
  | { ok: true; sendId?: string | null }
  | { ok: false; status?: number; networkError?: boolean; detail?: unknown };

/**
 * Retentar no próximo tick só o que é transitório. Um 4xx (template não
 * aprovado, fora da janela de 24h) e erro de configuração falhariam de novo a
 * cada minuto — esses esperam o intervalo de re-aviso.
 */
export function isRetryableSendFailure(o: SendOutcome): boolean {
  if (o.ok) return false;
  if (o.networkError) return true;
  const s = o.status ?? 0;
  return s === 429 || s >= 500;
}

/**
 * Melhor estimativa de QUANDO a instância parou, para o "desde" do aviso.
 *
 * O instante da detecção mente para quem já estava fora quando o vigia começou
 * a olhar, e o `disconnectionAt` da Evolution também — medido em 2026-09-13: o
 * do saturno marcava 03/09, de uma queda anterior que a reconexão nunca
 * atualizou, enquanto ele capturou mensagens até 09/09. A última mensagem do
 * store é verdadeira desde que um PAR tenha seguido recebendo depois dela: aí
 * ela marca o ponto em que só esta instância parou. Sem par à frente não há
 * como separar queda de silêncio — devolve null e o chamador usa a detecção.
 */
export function observedDownSince(i: { ownStoreTs: Date | null; peerStoreTs: Date | null }): Date | null {
  if (!i.ownStoreTs || !i.peerStoreTs) return null;
  return i.peerStoreTs.getTime() > i.ownStoreTs.getTime() ? i.ownStoreTs : null;
}
