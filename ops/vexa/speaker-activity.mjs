// Pré-carregamento do bot da Vexa (node --import). Envia ao worker QUEM FALOU
// QUANDO: "NOME falou de T1 a T2". [PATCH BeeAds — mig 071 do worker]
//
// Por quê: a gravação do bot é o áudio MIXADO da sala. Quando a transcrição ao
// vivo falha (conta OpenAI sem crédito, 29/09–02/10/2026), a reunião só pode ser
// transcrita pela gravação — e sem esta linha do tempo os falantes saem como
// "Falante 1, 2…". Com ela, o worker usa amostras de voz de cada pessoa e põe os
// nomes reais.
//
// Como: o pipeline do Google Meet chama SpeakerStreamManager.feedAudio(chave,
// pcm, tsMs) só durante FALA (o turno fecha após 1 s de silêncio) e com a hora
// real em tsMs; o nome vem do destaque de quem fala no Meet (addSpeaker /
// updateSpeakerName). Interceptamos esses três métodos no protótipo.
//
// REGRA: nada aqui pode derrubar o bot. Tudo em try/catch, envio best-effort,
// sem listener de SIGTERM (adicionar um desliga a saída padrão do Node).
const MODULE = '/app/core/meetings/modules/gmeet-pipeline/dist/speaker-streams.js';
const URL_ = process.env.BEEADS_SPEAKER_URL;
const TOKEN = process.env.BEEADS_SPEAKER_TOKEN;
const IDLE_MS = 3000;
const FLUSH_MS = 15000;

let cfg = {};
try { cfg = JSON.parse(process.env.VEXA_BOT_CONFIG || process.env.BOT_CONFIG || '{}'); } catch { /* sem config */ }
const meetingId = Number(cfg.meeting_id ?? cfg.meetingId) || null;
const nativeMeetingId = cfg.nativeMeetingId ?? cfg.native_meeting_id ?? null;

if (URL_ && TOKEN && (meetingId || nativeMeetingId)) {
  try {
    const { SpeakerStreamManager } = await import(MODULE);
    const P = SpeakerStreamManager.prototype;
    const open = new Map(); // chave do turno -> { name, start, end, last }
    const ready = [];

    const close = (key) => {
      const cur = open.get(key);
      if (cur) { ready.push({ speaker: cur.name, start_ms: Math.round(cur.start), end_ms: Math.round(cur.end) }); open.delete(key); }
    };

    const origAdd = P.addSpeaker;
    P.addSpeaker = function (speakerId, speakerName) {
      try { close(speakerId); } catch { /* ignora */ }
      return origAdd.apply(this, arguments);
    };

    const origFeed = P.feedAudio;
    P.feedAudio = function (speakerId, audioData, atMs) {
      try {
        const b = this.buffers && this.buffers.get(speakerId);
        if (b) {
          const sr = this.sampleRate || 16000;
          const durMs = ((audioData && audioData.length) || 0) / sr * 1000;
          const now = Date.now();
          const start = typeof atMs === 'number' ? atMs : now - durMs;
          const end = start + durMs;
          const cur = open.get(speakerId);
          if (cur) { cur.end = Math.max(cur.end, end); cur.last = now; cur.name = b.speakerName || cur.name; }
          else open.set(speakerId, { name: b.speakerName || 'Speaker', start, end, last: now });
        }
      } catch { /* ignora */ }
      return origFeed.apply(this, arguments);
    };

    const origRename = P.updateSpeakerName;
    P.updateSpeakerName = function (speakerId, newName) {
      try { const cur = open.get(speakerId); if (cur && newName) cur.name = newName; } catch { /* ignora */ }
      return origRename.apply(this, arguments);
    };

    const origRemove = P.removeSpeaker;
    if (typeof origRemove === 'function') {
      P.removeSpeaker = function (speakerId) {
        try { close(speakerId); } catch { /* ignora */ }
        return origRemove.apply(this, arguments);
      };
    }

    const flush = async () => {
      try {
        const now = Date.now();
        for (const [k, v] of open) if (now - v.last > IDLE_MS) close(k);
        if (ready.length === 0) return;
        const events = ready.splice(0, 500);
        await fetch(URL_, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Speaker-Token': TOKEN },
          body: JSON.stringify({ meeting_id: meetingId, native_meeting_id: nativeMeetingId, events }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => { /* perdeu este lote; segue */ });
      } catch { /* ignora */ }
    };
    const t = setInterval(flush, FLUSH_MS);
    t.unref?.();
    console.log(`[beeads] speaker-activity ativo (meeting=${meetingId ?? nativeMeetingId})`);
  } catch (err) {
    console.log(`[beeads] speaker-activity desligado: ${err && err.message}`);
  }
}
