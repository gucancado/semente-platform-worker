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
export function audioDownloadName(episodeId: number, occurredAt: Date): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(occurredAt);
  return `reuniao-${day}-${episodeId}.webm`;
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
