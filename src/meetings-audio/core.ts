/**
 * src/meetings-audio/core.ts
 *
 * Regras puras do arquivo de áudio da reunião. Sem I/O: tudo aqui é testado sem
 * banco, sem Vexa e sem ffmpeg.
 *
 * De onde vem o áudio: o bot da Vexa grava a reunião inteira (opus em webm) e,
 * ao sair da sala, sobe o arquivo pro MinIO do próprio serviço. A Vexa expõe esse
 * arquivo em `GET /recordings` (lista do usuário da API key) e o monta em
 * `GET /recordings/{id}/master?type=audio`. O worker copia pro R2 e grava a chave
 * em `episodes.audio_r2_key`, que é o que o painel lê.
 */

/** Forma mínima de uma gravação na lista `GET /recordings` da Vexa. O
 *  `meeting_id` é o id da reunião NA VEXA, o mesmo `collected_meetings.vexa_meeting_id`. */
export type VexaRecording = {
  id: number;
  meeting_id: number;
  media_files?: Array<{ id: number | string; type: string; format?: string; is_final?: boolean }>;
};

export type PickedRecording = { recordingId: number; mediaFileId: number | string };

/**
 * Gravação de áudio de uma reunião da Vexa. Uma reunião pode ter mais de uma
 * gravação quando o bot reinicia a sessão; a mais recente (id maior) é a que
 * cobre o fim da reunião, e é a que o bot terminou de enviar por último.
 */
export function pickAudioRecording(recs: VexaRecording[], vexaMeetingId: number): PickedRecording | null {
  let best: PickedRecording | null = null;
  for (const r of recs) {
    if (Number(r.meeting_id) !== vexaMeetingId) continue;
    const mf = (r.media_files ?? []).find((m) => m.type === 'audio');
    if (!mf) continue;
    if (!best || Number(r.id) > best.recordingId) best = { recordingId: Number(r.id), mediaFileId: mf.id };
  }
  return best;
}

/**
 * Cabeçalho do webm do bot: EBML + Segment + Info + Tracks (Opus, 48 kHz,
 * estéreo), copiado de uma gravação válida (reunião 199). É idêntico em toda
 * gravação porque o gravador do bot usa sempre a mesma configuração; só o UID
 * da trilha muda, e os blocos de áudio referenciam a trilha pelo NÚMERO (1).
 */
export const WEBM_OPUS_INIT_HEX =
  '1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701ffffffffffffff'
  + '1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d651654ae6bbfaebdd7810173c587cefd7bc0'
  + '8f6b368381028686415f4f50555363a2934f707573486561640102000080bb0000000000e18db584473b80009f81'
  + '0262648120';

const EBML_MAGIC = Buffer.from('1a45dfa3', 'hex');
const CLUSTER_ID = Buffer.from('1f43b675', 'hex');

/** Lê um inteiro de tamanho variável do EBML. `null` se o byte não inicia um. */
function readVint(b: Buffer, i: number): { value: number; length: number } | null {
  if (i >= b.length) return null;
  const first = b[i]!;
  for (let len = 1; len <= 8; len++) {
    if (first & (0x80 >> (len - 1))) {
      if (i + len > b.length) return null;
      let v = first & (0xff >> len);
      for (let k = 1; k < len; k++) v = v * 256 + b[i + k]!;
      return { value: v, length: len };
    }
  }
  return null;
}

/** Timecode (ms) do cluster que começa em `pos`, ou `null` se não for legível. */
function clusterTimecode(b: Buffer, pos: number): number | null {
  const size = readVint(b, pos + 4);
  if (!size) return null;
  const i = pos + 4 + size.length;
  if (b[i] !== 0xe7) return null;
  const n = readVint(b, i + 1);
  if (!n || n.value < 1 || n.value > 8) return null;
  const at = i + 1 + n.length;
  if (at + n.value > b.length) return null;
  let v = 0;
  for (let k = 0; k < n.value; k++) v = v * 256 + b[at + k]!;
  return v;
}

/**
 * Posição do primeiro cluster a partir do qual os timecodes AVANÇAM. Numa
 * gravação atingida, o começo do arquivo é o pedaço do FIM da reunião gravado
 * por cima (medido: 1º cluster em 2.226.525 ms, o seguinte em 240.702 ms). Tudo
 * antes do primeiro cluster são é descartado.
 */
export function firstSaneClusterAt(b: Buffer): { pos: number; timecodeMs: number } | null {
  const found: Array<{ pos: number; tc: number }> = [];
  let pos = b.indexOf(CLUSTER_ID);
  while (pos !== -1 && found.length < 64) {
    const tc = clusterTimecode(b, pos);
    if (tc != null) found.push({ pos, tc });
    pos = b.indexOf(CLUSTER_ID, pos + 4);
  }
  for (let k = 0; k < found.length; k++) {
    const cur = found[k]!;
    const next = found[k + 1];
    if (!next || next.tc >= cur.tc) return { pos: cur.pos, timecodeMs: cur.tc };
  }
  return null;
}

/**
 * Repara gravação atingida pelo 2º master do bot (antes do patch de 24/09 no
 * capture-bridge): o arquivo perdeu o cabeçalho e começa com o pedaço final da
 * reunião, às vezes seguido de zeros. Reparo: cabeçalho Opus do gravador +
 * arquivo a partir do primeiro cluster com timecodes em ordem. O áudio passa a
 * começar ali (o `start_time` medido pelo remux vira `audio_start_ms`), e o que
 * vinha antes era irrecuperável: zeros, ou fim da reunião fora de lugar.
 */
export function repairHeaderlessWebm(bytes: Buffer): { bytes: Buffer; repaired: boolean } {
  if (bytes.subarray(0, 4).equals(EBML_MAGIC)) return { bytes, repaired: false };
  const head = Buffer.from(WEBM_OPUS_INIT_HEX, 'hex');
  const c = firstSaneClusterAt(bytes);
  if (!c) throw new Error('gravação sem cluster legível: nada a recuperar');
  return { bytes: Buffer.concat([head, bytes.subarray(c.pos)]), repaired: true };
}

/**
 * Áudio curto demais não é guardado. Motivo medido em 2026-09-24: o bot monta um
 * 2º arquivo só com o último pedaço (~3 KB) no MESMO caminho do arquivo completo e
 * é esse que chega à Vexa. Guardar faria o player aparecer tocando 1 segundo de
 * uma reunião de 40 min. Referência é a duração do episódio (tempo de fala), que
 * é sempre menor que o tempo do bot na sala; metade dá folga aos minutos que se
 * perdem no início das gravações reparadas.
 */
export const MIN_AUDIO_COVERAGE = 0.5;

export function audioCoversEpisode(audioS: number | null, episodeS: number | null): boolean {
  if (audioS == null || !Number.isFinite(audioS) || audioS <= 0) return false;
  if (episodeS == null || episodeS <= 0) return audioS >= 30;
  return audioS >= episodeS * MIN_AUDIO_COVERAGE;
}

/** Chave determinística no R2: re-tentar sobrescreve o mesmo objeto. */
export function audioKeyFor(vexaMeetingId: number): string {
  return `vexa/audio/${vexaMeetingId}.webm`;
}

/** `recording_199_b9d21ea6-....webm` → 199. É o nome que o bot usa em /tmp do
 *  contêiner da Vexa; só o backfill das gravações antigas depende dele. */
export function parseRecordingFilename(name: string): number | null {
  const m = /^recording_(\d+)_[0-9a-f-]+\.webm$/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** Nome do arquivo baixado: data da reunião em São Paulo + id do episódio.
 *  O container roda em UTC, então a data sai do fuso explícito. */
export function audioDownloadName(episodeId: number, occurredAt: Date, key = '.webm'): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(occurredAt);
  // Extensão sai da chave: episódios do Fireflies guardam mp3, os da Vexa webm.
  const ext = /\.([a-z0-9]{2,4})$/i.exec(key)?.[1]?.toLowerCase() ?? 'webm';
  return `reuniao-${day}-${episodeId}.${ext}`;
}

/**
 * TTL do link assinado. Não pode ser curto como o da mídia do WhatsApp (120s):
 * o `<audio>` segue o redirect uma vez e depois faz requisições de intervalo na
 * URL FINAL durante toda a escuta, a cada busca na barra e a cada novo trecho
 * bufferizado. Link expirado no meio da reunião = player travado com 403.
 * Seis horas cobrem a reunião mais longa medida com folga.
 */
export const AUDIO_URL_TTL_S = 6 * 60 * 60;

/** Janela em que o poller insiste numa reunião importada sem áudio. O bot envia o
 *  arquivo ao sair da sala, minutos depois da importação; passado esse prazo o
 *  arquivo não vem mais (bot falhou no envio ou a reunião é anterior ao recurso). */
export const PENDING_WINDOW_HOURS = 24;
