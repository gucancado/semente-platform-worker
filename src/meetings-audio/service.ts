/**
 * src/meetings-audio/service.ts
 *
 * Cópia do áudio da reunião pro R2. Um caminho só de gravação, usado pelo poller
 * (reuniões novas, arquivo vindo da Vexa) e pelo backfill (gravações antigas,
 * arquivo vindo do disco): remux → R2 → `episodes.audio_r2_key`.
 */
import { audioKeyFor, pickAudioRecording, repairHeaderlessWebm, type VexaRecording } from './core.js';

export type AudioLogger = {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
};

export type StoreAudioDeps = {
  remux: (b: Buffer) => Promise<Buffer>;
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  setKey: (episodeId: number, key: string) => Promise<boolean>;
};

export type ArchiveAudioDeps = StoreAudioDeps & {
  vexa: {
    listRecordings: () => Promise<VexaRecording[]>;
    downloadRecordingAudio: (recordingId: number, mediaFileId: number | string) => Promise<Buffer>;
  };
  log?: AudioLogger;
};

/** Remux + R2 + chave no episódio. A chave só é gravada depois do objeto
 *  verificado no R2: nunca aponta pra um arquivo que não existe. */
export async function storeEpisodeAudio(
  deps: StoreAudioDeps, a: { episodeId: number; vexaMeetingId: number; bytes: Buffer },
): Promise<{ key: string; bytes: number; recorded: boolean; repaired: boolean }> {
  const { bytes: whole, repaired } = repairHeaderlessWebm(a.bytes);
  const fixed = await deps.remux(whole);
  const key = audioKeyFor(a.vexaMeetingId);
  await deps.put(key, fixed, 'audio/webm');
  const recorded = await deps.setKey(a.episodeId, key);
  return { key, bytes: fixed.length, recorded, repaired };
}

/**
 * Busca a gravação da reunião na Vexa e arquiva. `not_ready` quando a Vexa ainda
 * não tem o arquivo: o bot só envia ao sair da sala, e a importação costuma
 * chegar antes. O poller tenta de novo no próximo ciclo.
 */
export async function archiveFromVexa(
  deps: ArchiveAudioDeps,
  a: { episodeId: number; vexaMeetingId: number; recordings: VexaRecording[] },
): Promise<'stored' | 'not_ready'> {
  const picked = pickAudioRecording(a.recordings, a.vexaMeetingId);
  if (!picked) return 'not_ready';
  const bytes = await deps.vexa.downloadRecordingAudio(picked.recordingId, picked.mediaFileId);
  const r = await storeEpisodeAudio(deps, { episodeId: a.episodeId, vexaMeetingId: a.vexaMeetingId, bytes });
  deps.log?.info({ episode: a.episodeId, vexa: a.vexaMeetingId, key: r.key, bytes: r.bytes, repaired: r.repaired }, 'meetings-audio: áudio arquivado');
  return 'stored';
}

/** Um ciclo do poller: uma chamada à lista da Vexa por ciclo, não uma por reunião. */
export async function runAudioBatch(
  deps: ArchiveAudioDeps & { listPending: () => Promise<Array<{ episodeId: number; vexaMeetingId: number }>> },
): Promise<{ pending: number; stored: number }> {
  const pending = await deps.listPending();
  if (pending.length === 0) return { pending: 0, stored: 0 };
  const recordings = await deps.vexa.listRecordings();
  let stored = 0;
  for (const p of pending) {
    try {
      if ((await archiveFromVexa(deps, { ...p, recordings })) === 'stored') stored += 1;
    } catch (err) {
      // Uma reunião com falha não impede as outras; ela volta no próximo ciclo
      // enquanto estiver na janela de pendência.
      deps.log?.warn({ episode: p.episodeId, vexa: p.vexaMeetingId, err: (err as Error).message }, 'meetings-audio: falha ao arquivar');
    }
  }
  return { pending: pending.length, stored };
}
