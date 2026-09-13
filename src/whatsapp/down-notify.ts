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

/** Texto livre — só é entregue pelo Cloud API dentro da janela de 24h. */
export function buildDownNotifyText(p: { label: string | null; phone: string; downSince: Date; link: string }): string {
  const who = p.label ? `${p.label} (${p.phone})` : p.phone;
  return [
    '⚠️ WhatsApp desconectado',
    '',
    `O WhatsApp ${who} está desconectado da BeeAds desde ${fmtBrtShort(p.downSince)}.`,
    '',
    'Para reconectar, abra o link abaixo e escaneie o QR code com este celular:',
    p.link,
  ].join('\n');
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
};

export type SystemHealth = { down: boolean; reason: 'state' | 'store_stale' | null };

/**
 * `state` sozinho NÃO basta: medido em 2026-09-12, o número 18 reportava `open`
 * na Evolution e `connected` no worker enquanto seu store não recebia nada havia
 * 4 dias — a sessão morre por dentro sem mudar o estado.
 *
 * Por isso o segundo sinal é o store ficar para trás do de um PAR que segue
 * recebendo. Comparar com um par, e não com o relógio, é o que impede falso
 * positivo em madrugada ou domingo: se todo mundo está quieto, o par também
 * está, e ninguém é denunciado. Sem par para comparar, só o estado decide.
 */
export function decideSystemHealth(i: SystemHealthInput): SystemHealth {
  if (i.state !== 'open') return { down: true, reason: 'state' };
  if (!i.peerStoreTs) return { down: false, reason: null };
  if (!i.ownStoreTs) return { down: true, reason: 'store_stale' };
  return i.peerStoreTs.getTime() - i.ownStoreTs.getTime() >= i.staleMs
    ? { down: true, reason: 'store_stale' }
    : { down: false, reason: null };
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
