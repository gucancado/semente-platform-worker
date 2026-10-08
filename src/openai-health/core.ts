/**
 * src/openai-health/core.ts
 *
 * Regras PURAS do estado da conta OpenAI. A conta é a MESMA da transcrição ao
 * vivo das reuniões (Vexa), do áudio do WhatsApp, dos resumos e da IA do CRM:
 * quando o crédito acaba tudo para ao mesmo tempo, e até aqui ninguém via —
 * foram 3 dias (29/09–02/10/2026) de reuniões perdidas sem nenhum aviso.
 *
 * A sonda manda 1 s de áudio para a mesma rota que a Vexa usa. `GET /v1/models`
 * NÃO serve: responde 200 com o crédito zerado (medido em 03/09).
 */

export type HealthState = 'unknown' | 'ok' | 'down';

/** Resultado de uma sonda: só `ok` e `down` mudam o estado. Erro de rede,
 *  5xx e rate limit comum são `unknown` — não dizem nada sobre a conta e não
 *  podem disparar aviso nem segurar bot na sala. */
export function classifyProbe(status: number | null, body: string): HealthState {
  if (status == null) return 'unknown';
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'down';
  if (status === 429 && /insufficient_quota|credit|billing/i.test(body)) return 'down';
  return 'unknown';
}

export type Transition = 'went_down' | 'came_back' | null;

/** Aviso só na TRANSIÇÃO entre estados conhecidos. Do `unknown` (boot, sem
 *  histórico) para `down` também avisa: a conta pode ter caído com o worker
 *  fora. Do `unknown` para `ok` não há o que dizer. */
export function transitionOf(prev: HealthState, next: HealthState): Transition {
  if (next === 'unknown' || next === prev) return null;
  if (next === 'down') return 'went_down';
  return prev === 'down' ? 'came_back' : null;
}

/**
 * A transcrição ao vivo de uma reunião que começou em `startedAt` foi afetada?
 * Sim se a conta está fora agora OU esteve fora em algum momento desde o início.
 * `last_down_at` é a ÚLTIMA vez vista fora, então pega também uma queda que já
 * voltou no meio da reunião.
 */
export function sttAffectedSince(
  h: { state: HealthState; lastDownAt: Date | null },
  startedAt: Date,
): boolean {
  if (h.state === 'down') return true;
  return h.lastDownAt != null && h.lastDownAt.getTime() >= startedAt.getTime();
}

/** 1 s de silêncio em WAV PCM 16 kHz mono — o menor pedido aceito pela rota. */
export function silentWav(seconds = 1, sampleRate = 16000): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

export const DOWN_NOTICE = {
  titulo: 'OpenAI sem crédito',
  detalhe:
    'A conta OpenAI está recusando chamadas. Ficam parados até recarregar: transcrição de reuniões e de áudios do WhatsApp, '
    + 'resumos e IA do CRM. Reuniões continuam sendo gravadas e serão transcritas pela gravação quando a conta voltar.',
};
export const UP_NOTICE = {
  titulo: 'OpenAI voltou',
  detalhe: 'A conta OpenAI voltou a responder. Áudios e resumos pendentes retomam sozinhos; reuniões do período serão transcritas pela gravação.',
};
