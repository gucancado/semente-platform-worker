import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSystemHealth,
  fmtBrtShort,
  isOwnDownNotice,
  isRetryableSendFailure,
  observedDownSince,
  planEpisode,
  shouldNotify,
} from '../../src/whatsapp/down-notify.js';
import { businessMsBetween } from '../../src/whatsapp/business-hours.js';
import { latestTrafficTs } from '../../src/evolution/client.js';
import { renderConnectionDownText } from '../../src/webhook-cloud/templates.js';

const H = 3_600_000;
const NOW = new Date('2026-09-13T15:00:00.000Z'); // 12:00 em São Paulo

test('fmtBrtShort formata em São Paulo, não no fuso do runtime', () => {
  assert.equal(fmtBrtShort(new Date('2026-09-09T21:10:00.000Z')), '09/09 às 18:10');
});

test('fmtBrtShort respeita a virada de dia UTC×BRT', () => {
  // 02:30Z do dia 10 ainda é 23:30 do dia 09 em São Paulo
  assert.equal(fmtBrtShort(new Date('2026-09-10T02:30:00.000Z')), '09/09 às 23:30');
});

const base = {
  downSince: new Date(NOW.getTime() - 2 * H) as Date | null,
  lastNotifiedAt: null as Date | null,
  notifyCount: 0,
  now: NOW,
  debounceMs: 5 * 60_000,
  renotifyMs: 12 * H,
  maxNotifies: 6,
};

test('primeiro aviso: fora do ar além do debounce e nunca avisado', () => {
  assert.equal(shouldNotify(base), true);
});

test('dentro do debounce não avisa', () => {
  assert.equal(shouldNotify({ ...base, downSince: new Date(NOW.getTime() - 60_000) }), false);
});

test('sem downSince (saudável) não avisa', () => {
  assert.equal(shouldNotify({ ...base, downSince: null }), false);
});

test('avisado há menos que o intervalo de re-aviso não avisa de novo', () => {
  assert.equal(
    shouldNotify({ ...base, lastNotifiedAt: new Date(NOW.getTime() - 11 * H), notifyCount: 1 }),
    false,
  );
});

test('re-avisa quando o intervalo passou', () => {
  assert.equal(
    shouldNotify({
      ...base,
      downSince: new Date(NOW.getTime() - 30 * H),
      lastNotifiedAt: new Date(NOW.getTime() - 12 * H),
      notifyCount: 1,
    }),
    true,
  );
});

test('teto de avisos por episódio', () => {
  assert.equal(
    shouldNotify({ ...base, lastNotifiedAt: new Date(NOW.getTime() - 99 * H), notifyCount: 6 }),
    false,
  );
});

const S = (iso: string) => new Date(iso);

test('estado diferente de open é queda, independente do store', () => {
  assert.deepEqual(
    decideSystemHealth({ state: 'close', ownStoreTs: S('2026-09-13T14:59:00Z'), peerStoreTs: S('2026-09-13T14:59:00Z'), staleMs: 6 * H }),
    { down: true, reason: 'state' },
  );
  assert.deepEqual(
    decideSystemHealth({ state: 'connecting', ownStoreTs: null, peerStoreTs: null, staleMs: 6 * H }),
    { down: true, reason: 'state' },
  );
});

test('open com store parado atrás do par além do limite é queda (caso do número 18)', () => {
  // store próprio parou 08/09 14:21; o par seguiu recebendo até 12/09 10:08
  assert.deepEqual(
    decideSystemHealth({ state: 'open', ownStoreTs: S('2026-09-08T14:21:43Z'), peerStoreTs: S('2026-09-12T10:08:03Z'), staleMs: 6 * H }),
    { down: true, reason: 'store_stale' },
  );
});

test('open com store atrás do par DENTRO do limite é saudável', () => {
  assert.deepEqual(
    decideSystemHealth({ state: 'open', ownStoreTs: S('2026-09-13T10:00:00Z'), peerStoreTs: S('2026-09-13T14:00:00Z'), staleMs: 6 * H }),
    { down: false, reason: null },
  );
});

test('todos quietos não é queda: o par parado também não denuncia ninguém', () => {
  assert.deepEqual(
    decideSystemHealth({ state: 'open', ownStoreTs: S('2026-09-12T20:00:00Z'), peerStoreTs: S('2026-09-12T21:00:00Z'), staleMs: 6 * H }),
    { down: false, reason: null },
  );
});

test('sem par para comparar, só o estado decide', () => {
  assert.deepEqual(
    decideSystemHealth({ state: 'open', ownStoreTs: S('2026-09-01T00:00:00Z'), peerStoreTs: null, staleMs: 6 * H }),
    { down: false, reason: null },
  );
});

test('store próprio vazio com par ativo é queda', () => {
  assert.deepEqual(
    decideSystemHealth({ state: 'open', ownStoreTs: null, peerStoreTs: S('2026-09-13T14:00:00Z'), staleMs: 6 * H }),
    { down: true, reason: 'store_stale' },
  );
});

test('retentável só falha de rede, 429 e 5xx; 4xx e erro de config esperam o re-aviso', () => {
  assert.equal(isRetryableSendFailure({ ok: false, networkError: true }), true);
  assert.equal(isRetryableSendFailure({ ok: false, status: 503 }), true);
  assert.equal(isRetryableSendFailure({ ok: false, status: 429 }), true);
  assert.equal(isRetryableSendFailure({ ok: false, status: 400 }), false);
  assert.equal(isRetryableSendFailure({ ok: false, detail: 'no access token' }), false);
  assert.equal(isRetryableSendFailure({ ok: true, sendId: 'x' }), false);
});

test('observedDownSince usa a última mensagem quando o par seguiu recebendo depois', () => {
  const own = S('2026-09-09T21:10:00Z');
  assert.equal(observedDownSince({ ownStoreTs: own, peerStoreTs: S('2026-09-12T13:08:00Z') }), own);
});

test('observedDownSince sem par à frente não inventa início', () => {
  assert.equal(observedDownSince({ ownStoreTs: S('2026-09-12T20:00:00Z'), peerStoreTs: S('2026-09-12T19:00:00Z') }), null);
  assert.equal(observedDownSince({ ownStoreTs: null, peerStoreTs: S('2026-09-12T19:00:00Z') }), null);
  assert.equal(observedDownSince({ ownStoreTs: S('2026-09-12T19:00:00Z'), peerStoreTs: null }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Falsos positivos medidos em prod entre 15/09 e 21/09/2026 (instância `saturno`,
// só-de-grupos-de-equipe, que NÃO caiu: 11 avisos e 8 episódios falsos).
// Os horários abaixo são os reais, em São Paulo.
// ─────────────────────────────────────────────────────────────────────────────
const brt = (s: string) => new Date(`${s}-03:00`);

test('[defeito 1] aviso falso de 21/09 06:24: alvo mudo desde domingo à noite NÃO é queda', () => {
  // store próprio parado desde 20/09 20:06 (domingo); par de ATENDIMENTO recebeu lead às 06:20 de segunda
  const input = {
    state: 'open' as const,
    ownStoreTs: brt('2026-09-20T20:06:00'),
    peerStoreTs: brt('2026-09-21T06:20:00'),
    staleMs: 6 * H,
  };
  // pelo relógio de parede são 10h14 de atraso — foi o que disparou o aviso
  assert.deepEqual(decideSystemHealth(input), { down: true, reason: 'store_stale' });
  // medido em expediente, o atraso é zero: ninguém fala em grupo de equipe de madrugada
  assert.deepEqual(decideSystemHealth({ ...input, elapsedMs: businessMsBetween }), { down: false, reason: null });
});

test('[defeito 1] fim de semana inteiro mudo com par ativo NÃO é queda (episódios 77 e 78)', () => {
  assert.deepEqual(
    decideSystemHealth({
      state: 'open',
      ownStoreTs: brt('2026-09-18T18:40:00'), // sexta, fim do expediente
      peerStoreTs: brt('2026-09-20T10:54:00'), // domingo
      staleMs: 6 * H,
      elapsedMs: businessMsBetween,
    }),
    { down: false, reason: null },
  );
});

test('[defeito 1] sessão zumbi em dia útil AINDA é pega, no mesmo prazo de 6h', () => {
  const zombie = {
    state: 'open' as const,
    ownStoreTs: brt('2026-09-22T10:00:00'), // terça: parou de receber às 10h
    staleMs: 6 * H,
    elapsedMs: businessMsBetween,
  };
  assert.deepEqual(decideSystemHealth({ ...zombie, peerStoreTs: brt('2026-09-22T15:00:00') }), { down: false, reason: null });
  assert.deepEqual(decideSystemHealth({ ...zombie, peerStoreTs: brt('2026-09-22T16:00:00') }), { down: true, reason: 'store_stale' });
});

test('[defeito 1] zumbi de sexta à tarde é pego na segunda, não no sábado', () => {
  const zombie = { state: 'open' as const, ownStoreTs: brt('2026-09-25T17:00:00'), staleMs: 6 * H, elapsedMs: businessMsBetween };
  assert.equal(decideSystemHealth({ ...zombie, peerStoreTs: brt('2026-09-26T12:00:00') }).down, false);
  assert.equal(decideSystemHealth({ ...zombie, peerStoreTs: brt('2026-09-28T13:59:00') }).down, false);
  assert.equal(decideSystemHealth({ ...zombie, peerStoreTs: brt('2026-09-28T14:00:00') }).down, true);
});

test('[defeito 1] estado fechado é queda a qualquer hora — o expediente só vale para o store', () => {
  assert.deepEqual(
    decideSystemHealth({
      state: 'close',
      ownStoreTs: brt('2026-09-20T20:06:00'),
      peerStoreTs: brt('2026-09-21T03:00:00'),
      staleMs: 6 * H,
      elapsedMs: businessMsBetween,
    }),
    { down: true, reason: 'state' },
  );
});

// O aviso como a Evolution o guarda no store do PRÓPRIO alvo (DM recebida do número Cloud).
const NOTICE_TEXT = renderConnectionDownText({
  name: 'Monitor de grupos',
  phone: '+553195950748',
  downSince: brt('2026-09-19T12:03:00'),
  token: 'o4MEzz_exemploDeToken',
});
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const notice = (at: Date, message: unknown = { conversation: NOTICE_TEXT }, remoteJid = '553190858510@s.whatsapp.net') => ({
  key: { remoteJid, fromMe: false, id: `wamid-${secs(at)}` },
  message,
  messageTimestamp: secs(at),
});
const groupMsg = (at: Date, text = 'bom dia, pessoal') => ({
  key: { remoteJid: '120363424016852722@g.us', fromMe: false, id: `g-${secs(at)}`, participant: '5531999990000@s.whatsapp.net' },
  message: { conversation: text },
  messageTimestamp: secs(at),
});

test('[defeito 2] o texto que o vigia ENVIA é reconhecido como aviso próprio (trava o acoplamento com o template)', () => {
  assert.equal(isOwnDownNotice(notice(brt('2026-09-19T17:09:39'))), true);
});

test('[defeito 2] reconhece o aviso em qualquer formato que o Baileys entregue', () => {
  const at = brt('2026-09-19T17:09:39');
  assert.equal(
    isOwnDownNotice(notice(at, { extendedTextMessage: { text: NOTICE_TEXT, matchedText: 'https://painel.beeads.com.br/reconectar-whatsapp/x' } })),
    true,
  );
  assert.equal(isOwnDownNotice(notice(at, { templateMessage: { hydratedTemplate: { hydratedContentText: NOTICE_TEXT } } })), true);
  // v1 do template: corpo sem link, URL só no botão
  assert.equal(
    isOwnDownNotice(
      notice(at, {
        templateMessage: {
          hydratedTemplate: {
            hydratedContentText: 'x',
            hydratedButtons: [{ urlButton: { url: 'https://painel.beeads.com.br/reconectar-whatsapp/tok' } }],
          },
        },
      }),
    ),
    true,
  );
  // remetente chega como LID de privacidade — por isso o critério é o CONTEÚDO, não o jid
  assert.equal(isOwnDownNotice(notice(at, undefined, '93557490733105@lid')), true);
});

test('[defeito 2] tráfego de verdade nunca é confundido com o aviso', () => {
  const at = brt('2026-09-21T09:12:00');
  assert.equal(isOwnDownNotice(groupMsg(at)), false);
  // o aviso ENCAMINHADO a um grupo é tráfego de grupo: a sessão o recebeu
  assert.equal(isOwnDownNotice(groupMsg(at, NOTICE_TEXT)), false);
  // enviado pelo próprio aparelho (fromMe) também prova sessão viva
  assert.equal(
    isOwnDownNotice({ ...notice(at), key: { remoteJid: '5531988887777@s.whatsapp.net', fromMe: true, id: 'a' } }),
    false,
  );
  assert.equal(
    isOwnDownNotice({
      key: { remoteJid: '5531988887777@s.whatsapp.net', fromMe: false, id: 'b' },
      message: { conversation: 'oi' },
      messageTimestamp: secs(at),
    }),
    false,
  );
  assert.equal(isOwnDownNotice(null), false);
  assert.equal(isOwnDownNotice({}), false);
});

test('[defeito 2] o aviso de 19/09 17:09:39 não vira a "última mensagem" do alvo — nem cura, nem data o episódio seguinte', () => {
  const lastReal = brt('2026-09-18T18:40:00');
  const store = [notice(brt('2026-09-19T17:09:39')), groupMsg(lastReal)];
  // sem filtro (o bug): o store parece fresco às 17:09:39…
  assert.equal(latestTrafficTs(store)!.getTime(), brt('2026-09-19T17:09:39').getTime());
  // …com filtro, a última mensagem é a de verdade
  const own = latestTrafficTs(store, isOwnDownNotice)!;
  assert.equal(own.getTime(), lastReal.getTime());
  // e é ela — não o horário do aviso — que dataria um "desde" (o episódio 77 começava em 17:09:39)
  assert.equal(
    observedDownSince({ ownStoreTs: own, peerStoreTs: brt('2026-09-20T10:00:00') })!.getTime(),
    lastReal.getTime(),
  );
});

test('[defeito 2] store só com avisos não tem tráfego nenhum', () => {
  assert.equal(
    latestTrafficTs([notice(brt('2026-09-20T10:54:41')), notice(brt('2026-09-19T17:09:39'))], isOwnDownNotice),
    null,
  );
});

const TICK = 5 * 60_000; // SYSTEM_INSTANCE_WATCH_INTERVAL_MS em prod
const healthy = { downSince: null, sawDown: false, ageMs: null };
const suspectAged = (ageMs: number | null) => ({ downSince: null, sawDown: true, ageMs });

test('[defeito 3] flap connecting→open de 1s (17/09 18:39:35) NÃO abre episódio: um tick só é suspeita', () => {
  // tick das 18:39 vê `connecting`
  assert.equal(planEpisode(healthy, true, TICK), 'suspect');
  // o tick seguinte já vê `open`: a suspeita some sem nunca ter virado episódio
  assert.equal(planEpisode(suspectAged(TICK), false, TICK), 'healthy');
});

test('[defeito 3] segunda observação NO PRAZO confirma; depois o episódio é mantido e fechado', () => {
  assert.equal(planEpisode(suspectAged(TICK), true, TICK), 'open');
  const since = brt('2026-09-09T15:10:00');
  assert.equal(planEpisode({ downSince: since, sawDown: true, ageMs: TICK }, true, TICK), 'keep');
  assert.equal(planEpisode({ downSince: since, sawDown: true, ageMs: TICK }, false, TICK), 'close');
  assert.equal(planEpisode(healthy, false, TICK), 'healthy');
});

test('[defeito 3] ramo CEDO DEMAIS: duas gravações não são duas observações (dry-run, rolling deploy, concorrência)', () => {
  // o flap dura ~1s: tudo que cair dentro dele é a MESMA observação
  assert.equal(planEpisode(suspectAged(0), true, TICK), 'hold');
  assert.equal(planEpisode(suspectAged(1_000), true, TICK), 'hold');
  assert.equal(planEpisode(suspectAged(2_000), true, TICK), 'hold'); // 2º container, tick imediato no boot
  assert.equal(planEpisode(suspectAged(TICK / 2 - 1), true, TICK), 'hold');
  // a partir de meio intervalo já é outra observação
  assert.equal(planEpisode(suspectAged(TICK / 2), true, TICK), 'open');
});

test('[defeito 3] ramo NO PRAZO tolera jitter do tick e até duas sondas perdidas', () => {
  assert.equal(planEpisode(suspectAged(TICK - 700), true, TICK), 'open'); //  tick adiantado
  assert.equal(planEpisode(suspectAged(TICK + 900), true, TICK), 'open'); //  tick atrasado
  assert.equal(planEpisode(suspectAged(3 * TICK + 900), true, TICK), 'open'); // 2 sondas com erro no meio
});

test('[defeito 3] ramo VELHA DEMAIS: suspeita de horas atrás não é confirmada — recomeça como 1ª observação', () => {
  // sonda com erro não toca a linha: a suspeita pode ficar parada por horas
  assert.equal(planEpisode(suspectAged(3.5 * TICK + 1), true, TICK), 'suspect');
  assert.equal(planEpisode(suspectAged(4 * 3_600_000), true, TICK), 'suspect');
  // idade desconhecida (checked_at nulo) é tratada como velha demais, nunca como confirmação
  assert.equal(planEpisode(suspectAged(null), true, TICK), 'suspect');
});

test('[defeito 3] leitura saudável desfaz a suspeita em QUALQUER idade; episódio aberto ignora a janela', () => {
  assert.equal(planEpisode(suspectAged(500), false, TICK), 'healthy');
  assert.equal(planEpisode(suspectAged(9 * 3_600_000), false, TICK), 'healthy');
  const since = brt('2026-09-09T15:10:00');
  assert.equal(planEpisode({ downSince: since, sawDown: true, ageMs: 500 }, true, TICK), 'keep');
  assert.equal(planEpisode({ downSince: since, sawDown: true, ageMs: 9 * 3_600_000 }, true, TICK), 'keep');
});
