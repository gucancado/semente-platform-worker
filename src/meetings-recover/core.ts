/**
 * src/meetings-recover/core.ts
 *
 * Regras PURAS da transcrição pela GRAVAÇÃO (mig 071). Sem pg, sem rede, sem
 * ffmpeg: tudo aqui é testado isolado.
 *
 * Contexto: a gravação do bot é o áudio MIXADO da sala — não diz quem falou.
 * A diarização separa vozes em rótulos (A, B…) e, com amostras de voz
 * (`known_speaker_references`, máx 4), devolve o NOME de quem reconhece. As
 * amostras e os nomes vêm da linha do tempo que o próprio bot envia
 * (`meeting_speaker_activity`): "NOME falou de T1 a T2".
 */

/** Abaixo disto a gravação não tem conversa — a sala estava vazia ou muda de
 *  fato. Mesmo piso de fala da importação (MIN_SPEECH_MS_TO_IMPORT). */
export const MIN_SPEECH_S = 30;

/** Pedaço de áudio por chamada. Pedido de >~4 min estoura o headers timeout de
 *  300 s do fetch do Node (undici) na diarização — medido em 02/10/2026. */
export const CHUNK_S = 240;

/** Máximo de vozes de referência que a API aceita. */
export const MAX_REFS = 4;

export const UNKNOWN_SPEAKER = 'Não identificado';

/**
 * Segundos de fala na gravação a partir da saída do `silencedetect` do ffmpeg.
 * Fala = duração − soma dos silêncios. Silêncio aberto no fim (sem
 * `silence_end`) vai até o fim do arquivo.
 */
export function speechSecondsFromSilencedetect(stderr: string, durationS: number): number {
  let silent = 0;
  let openStart: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { openStart = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
    if (e) { silent += Number(e[2]); openStart = null; }
  }
  if (openStart != null) silent += Math.max(0, durationS - openStart);
  return Math.max(0, durationS - silent);
}

/** Inícios (s) dos pedaços que cobrem `durationS`. */
export function chunkStarts(durationS: number, chunkS = CHUNK_S): number[] {
  const out: number[] = [];
  for (let t = 0; t < durationS; t += chunkS) out.push(t);
  return out;
}

/** Intervalo de fala relativo ao início da gravação, em segundos. */
export type Activity = { speaker: string; startS: number; endS: number };

/** Nome genérico que o bot usa antes de saber quem é ("Speaker") não identifica ninguém. */
function isRealName(n: string): boolean {
  const t = n.trim();
  return t.length > 0 && !/^speaker\b/i.test(t);
}

/** Converte a linha do tempo absoluta do bot para segundos da gravação. */
export function toRelativeActivity(
  rows: Array<{ speaker: string; started_at: Date; ended_at: Date }>,
  recordingStart: Date,
): Activity[] {
  const t0 = recordingStart.getTime();
  return rows
    .filter((r) => isRealName(r.speaker))
    .map((r) => ({ speaker: r.speaker.trim(), startS: (r.started_at.getTime() - t0) / 1000, endS: (r.ended_at.getTime() - t0) / 1000 }))
    .filter((a) => a.endS > a.startS);
}

export type RefClip = { name: string; startS: number; lenS: number };

/**
 * Amostras de voz: as (até) 4 pessoas que mais falaram, cada uma com um trecho
 * de 3–8 s do seu intervalo contínuo mais longo, dentro da gravação. Pula 0,5 s
 * no começo do intervalo — a borda costuma pegar o fim da fala anterior.
 */
export function pickReferenceClips(activity: Activity[], durationS: number, max = MAX_REFS): RefClip[] {
  const total = new Map<string, number>();
  for (const a of activity) total.set(a.speaker, (total.get(a.speaker) ?? 0) + (a.endS - a.startS));
  const ranked = [...total.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n);
  const out: RefClip[] = [];
  for (const name of ranked) {
    if (out.length >= max) break;
    const best = activity
      .filter((a) => a.speaker === name && a.startS >= 0 && a.endS <= durationS)
      .map((a) => ({ start: a.startS + 0.5, len: Math.min(8, a.endS - a.startS - 0.5) }))
      .filter((c) => c.len >= 3)
      .sort((x, y) => y.len - x.len)[0];
    if (best) out.push({ name, startS: best.start, lenS: best.len });
  }
  return out;
}

export type DiarSeg = { speaker: string; start: number; end: number; text: string };

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Nome de cada rótulo que a diarização devolveu num pedaço (tempos do pedaço +
 * `offsetS` = tempos da gravação).
 *   - rótulo que JÁ é um nome de referência fica;
 *   - letra solta ganha o nome de quem a linha do tempo mais cobre, se cobrir
 *     ao menos metade da fala daquele rótulo — abaixo disso é chute;
 *   - sem linha do tempo, letra nova vira `fallback(letra)` (Falante N).
 */
export function nameLabels(
  segs: DiarSeg[],
  offsetS: number,
  activity: Activity[],
  refNames: string[],
  fallback: (label: string) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  const byLabel = new Map<string, DiarSeg[]>();
  for (const s of segs) byLabel.set(s.speaker, [...(byLabel.get(s.speaker) ?? []), s]);
  for (const [label, list] of byLabel) {
    if (refNames.includes(label)) { out.set(label, label); continue; }
    if (activity.length === 0) { out.set(label, fallback(label)); continue; }
    const dur = list.reduce((n, s) => n + (s.end - s.start), 0);
    const cover = new Map<string, number>();
    for (const s of list) {
      for (const a of activity) {
        const o = overlap(s.start + offsetS, s.end + offsetS, a.startS, a.endS);
        if (o > 0) cover.set(a.speaker, (cover.get(a.speaker) ?? 0) + o);
      }
    }
    const best = [...cover.entries()].sort((x, y) => y[1] - x[1])[0];
    out.set(label, best && dur > 0 && best[1] / dur >= 0.5 ? best[0] : UNKNOWN_SPEAKER);
  }
  return out;
}
