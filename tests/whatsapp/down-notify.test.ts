import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDownNotifyText,
  decideSystemHealth,
  fmtBrtShort,
  isRetryableSendFailure,
  shouldNotify,
} from '../../src/whatsapp/down-notify.js';

const H = 3_600_000;
const NOW = new Date('2026-09-13T15:00:00.000Z'); // 12:00 em São Paulo

test('fmtBrtShort formata em São Paulo, não no fuso do runtime', () => {
  assert.equal(fmtBrtShort(new Date('2026-09-09T21:10:00.000Z')), '09/09 às 18:10');
});

test('fmtBrtShort respeita a virada de dia UTC×BRT', () => {
  // 02:30Z do dia 10 ainda é 23:30 do dia 09 em São Paulo
  assert.equal(fmtBrtShort(new Date('2026-09-10T02:30:00.000Z')), '09/09 às 23:30');
});

test('texto traz rótulo, telefone, desde quando e o link', () => {
  const t = buildDownNotifyText({
    label: 'Monitor de grupos',
    phone: '+553195950748',
    downSince: new Date('2026-09-09T21:10:00.000Z'),
    link: 'https://painel.beeads.com.br/reconectar-whatsapp/abc',
  });
  assert.match(t, /Monitor de grupos/);
  assert.match(t, /\+553195950748/);
  assert.match(t, /09\/09 às 18:10/);
  assert.match(t, /https:\/\/painel\.beeads\.com\.br\/reconectar-whatsapp\/abc/);
});

test('sem rótulo o texto usa só o telefone e não vaza null', () => {
  const t = buildDownNotifyText({ label: null, phone: '+5531999', downSince: NOW, link: 'https://x/y' });
  assert.match(t, /\+5531999/);
  assert.doesNotMatch(t, /null|undefined/);
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
