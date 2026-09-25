import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROBE_CODE_ALPHABET, cloudStatusRank, decideTrigger, decideVerdict, generateProbeCode,
  inProbeSendWindow, pickCandidates, probeTexts, reconcileStatus, type ProbeHistory,
} from '../../src/whatsapp/connection-probe.js';

const H = 3_600_000;
const clean: ProbeHistory = { hasOpen: false, lastVerdict: null, primaryCount24h: 0, lastQuietAgeMs: null, consecutiveInconclusive: 0 };
const wall = (a: Date, b: Date) => b.getTime() - a.getTime();
const now = new Date('2026-09-25T15:00:00Z'); // 12:00 SP
const base = { state: 'open' as const, now, staleMs: 6 * H, businessElapsedMs: wall, episodeOpen: false, history: clean };

test('código: alfabeto e fuga de colisão', () => {
  let i = 0;
  const seq = [0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99];
  const code = generateProbeCode(() => seq[i++ % seq.length], new Set(['AAAA']));
  assert.equal(code.length, 4);
  assert.notEqual(code, 'AAAA');
  for (const c of code) assert.ok(PROBE_CODE_ALPHABET.includes(c));
});

test('janela de envio 08–20 SP', () => {
  assert.equal(inProbeSendWindow(new Date('2026-09-25T10:59:00Z')), false); // 07:59
  assert.equal(inProbeSendWindow(new Date('2026-09-25T11:00:00Z')), true);  // 08:00
  assert.equal(inProbeSendWindow(new Date('2026-09-25T22:59:00Z')), true);  // 19:59
  assert.equal(inProbeSendWindow(new Date('2026-09-25T23:00:00Z')), false); // 20:00
});

test('textos da sonda', () => {
  assert.deepEqual(probeTexts('Luhma', '+553171431880', 'K7Q2'), {
    titulo: 'Teste de conexão do WhatsApp Luhma (+553171431880)',
    detalhe: 'Código K7Q2. Não é preciso responder.',
  });
  assert.equal(probeTexts(null, '+55', 'K7Q2').titulo, 'Teste de conexão do WhatsApp +55');
  // Whitespace-only name normalizes to phone only
  assert.equal(probeTexts('   ', '+55', 'K7Q2').titulo, 'Teste de conexão do WhatsApp +55');
});

test('gatilho store_stale e quiet', () => {
  const own = new Date(now.getTime() - 10 * H);
  assert.equal(decideTrigger({ ...base, ownStoreTs: own, peerStoreTs: new Date(now.getTime() - 1 * H) }), 'store_stale');
  assert.equal(decideTrigger({ ...base, ownStoreTs: new Date(now.getTime() - 13 * H), peerStoreTs: null }), 'quiet');
  assert.equal(decideTrigger({ ...base, ownStoreTs: new Date(now.getTime() - 11 * H), peerStoreTs: null }), null);
  assert.equal(decideTrigger({ ...base, ownStoreTs: new Date(now.getTime() - 2 * H), peerStoreTs: now }), null);
});

test('peer lag pequeno (< staleMs) permite quiet (silencio geral alcancavel)', () => {
  // own 13h ago, peer 12.5h ago (lag 0.5h < 6h staleMs) → should evaluate quiet and return 'quiet'
  assert.equal(
    decideTrigger({
      ...base,
      ownStoreTs: new Date(now.getTime() - 13 * H),
      peerStoreTs: new Date(now.getTime() - 12.5 * H),
    }),
    'quiet'
  );
  // ownStoreTs null with peer present → 'store_stale' (peer has data, we don't)
  assert.equal(decideTrigger({ ...base, ownStoreTs: null, peerStoreTs: now }), 'store_stale');
  // ownStoreTs null and no peer → 'quiet' (general silence)
  assert.equal(decideTrigger({ ...base, ownStoreTs: null, peerStoreTs: null }), 'quiet');
  // businessElapsedMs returns 0 (lag always 0): own 10h / peer now → NOT 'store_stale', returns null (own is 10h old < 12h PROBE_QUIET_MS)
  assert.equal(
    decideTrigger({
      ...base,
      ownStoreTs: new Date(now.getTime() - 10 * H),
      peerStoreTs: now,
      businessElapsedMs: () => 0,
    }),
    null
  );
  // own 13h / peer now with businessElapsedMs = () => 0 → 'quiet'
  assert.equal(
    decideTrigger({
      ...base,
      ownStoreTs: new Date(now.getTime() - 13 * H),
      peerStoreTs: now,
      businessElapsedMs: () => 0,
    }),
    'quiet'
  );
});

test('bloqueios', () => {
  const stale = { ...base, ownStoreTs: new Date(now.getTime() - 10 * H), peerStoreTs: now };
  assert.equal(decideTrigger({ ...stale, state: 'connecting' }), null);
  assert.equal(decideTrigger({ ...stale, episodeOpen: true }), null);
  assert.equal(decideTrigger({ ...stale, history: { ...clean, hasOpen: true } }), null);
  for (const v of ['alive', 'pipeline_broken', 'identity_mismatch'] as const) {
    assert.equal(decideTrigger({ ...stale, history: { ...clean, lastVerdict: { verdict: v, ageMs: 23 * H } } }), null);
    assert.equal(decideTrigger({ ...stale, history: { ...clean, lastVerdict: { verdict: v, ageMs: 25 * H } } }), 'store_stale');
  }
  for (const v of ['inconclusive', 'send_failed'] as const) {
    assert.equal(decideTrigger({ ...stale, history: { ...clean, lastVerdict: { verdict: v, ageMs: 0.5 * H } } }), null);
    assert.equal(decideTrigger({ ...stale, history: { ...clean, lastVerdict: { verdict: v, ageMs: 1.5 * H } } }), 'store_stale');
  }
  assert.equal(decideTrigger({ ...stale, history: { ...clean, primaryCount24h: 3 } }), null);
  const quiet = { ...base, ownStoreTs: new Date(now.getTime() - 13 * H), peerStoreTs: null };
  assert.equal(decideTrigger({ ...quiet, history: { ...clean, lastQuietAgeMs: 23 * H } }), null);
  assert.equal(decideTrigger({ ...quiet, history: { ...clean, lastQuietAgeMs: 25 * H } }), 'quiet');
});

test('anti-rebanho', () => {
  const q = Array.from({ length: 6 }, () => ({ trigger: 'quiet' as const }));
  assert.deepEqual(pickCandidates(q, 10), { send: [], generalSilence: true });
  const mix = [{ trigger: 'store_stale' as const }, ...q.slice(0, 2), { trigger: 'store_stale' as const }, { trigger: 'store_stale' as const }];
  const r = pickCandidates(mix, 20);
  assert.equal(r.generalSilence, false);
  assert.equal(r.send.length, 3);
  assert.ok(r.send.slice(0, 3).every((c) => c.trigger === 'store_stale'));
});

test('veredito', () => {
  const m = 60_000;
  assert.equal(decideVerdict({ isRepeat: false, received: false, storeSeen: false, cloudStatus: 'delivered', ageMs: 4 * m }), 'wait');
  assert.equal(decideVerdict({ isRepeat: false, received: true, storeSeen: false, cloudStatus: null, ageMs: 5 * m }), 'alive');
  assert.equal(decideVerdict({ isRepeat: false, received: false, storeSeen: true, cloudStatus: 'delivered', ageMs: 5 * m }), 'repeated');
  assert.equal(decideVerdict({ isRepeat: true, received: false, storeSeen: true, cloudStatus: 'delivered', ageMs: 5 * m }), 'pipeline_broken');
  assert.equal(decideVerdict({ isRepeat: false, received: false, storeSeen: false, cloudStatus: 'read', ageMs: 5 * m }), 'repeated');
  assert.equal(decideVerdict({ isRepeat: true, received: false, storeSeen: false, cloudStatus: 'delivered', ageMs: 5 * m }), 'down');
  assert.equal(decideVerdict({ isRepeat: false, received: false, storeSeen: false, cloudStatus: 'failed', ageMs: 5 * m }), 'send_failed');
  assert.equal(decideVerdict({ isRepeat: false, received: false, storeSeen: false, cloudStatus: 'sent', ageMs: 20 * m }), 'wait');
  assert.equal(decideVerdict({ isRepeat: false, received: false, storeSeen: false, cloudStatus: 'sent', ageMs: 30 * m }), 'inconclusive');
});

test('status Cloud não regride e reconciliação', () => {
  assert.ok(cloudStatusRank('failed') > cloudStatusRank('read'));
  assert.ok(cloudStatusRank('read') > cloudStatusRank('delivered'));
  assert.ok(cloudStatusRank('delivered') > cloudStatusRank('sent'));
  assert.equal(cloudStatusRank(null), 0);
  assert.equal(reconcileStatus('open', 'disconnected'), 'connected');
  assert.equal(reconcileStatus('close', 'connected'), 'disconnected');
  assert.equal(reconcileStatus('connecting', 'connected'), null);
  assert.equal(reconcileStatus('open', 'connected'), null);
});
