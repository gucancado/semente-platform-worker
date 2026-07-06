import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMedia, parseEvolutionPayload, shouldIngest } from '../../src/webhook/evolution.js';

const baseEv = {
  event: 'messages.upsert',
  instance: 'mercurio-metido-a-gente',
  data: {
    key: { remoteJid: '5531999998888@s.whatsapp.net', fromMe: false, id: 'EV1' },
    message: { conversation: 'oi' },
    pushName: 'Fulano',
  },
};

test('parser extrai project do sufixo da instance', () => {
  const parsed = parseEvolutionPayload(baseEv);
  assert.ok(parsed);
  assert.equal(parsed!.agent, 'mercurio');
  assert.equal(parsed!.project, 'metido-a-gente');
  assert.equal(parsed!.instance, 'mercurio-metido-a-gente');
});

test('parser lida com project contendo múltiplos hífens', () => {
  const parsed = parseEvolutionPayload({ ...baseEv, instance: 'mercurio-cliente-acme-2026' });
  assert.ok(parsed);
  assert.equal(parsed!.agent, 'mercurio');
  assert.equal(parsed!.project, 'cliente-acme-2026');
});

test('parser retorna project=null quando instance não tem hífen', () => {
  const parsed = parseEvolutionPayload({ ...baseEv, instance: 'agentelegado' });
  assert.ok(parsed);
  assert.equal(parsed!.agent, 'agentelegado');
  assert.equal(parsed!.project, null);
});

// ── Grupos (auditor/saturno) ──────────────────────────────────────────────

const groupEv = {
  event: 'messages.upsert',
  instance: 'saturno-bluma',
  data: {
    key: {
      remoteJid: '120363000000000000@g.us',
      participant: '5531988887777@s.whatsapp.net',
      fromMe: false,
      id: 'EVG1',
    },
    message: { conversation: 'cadê o relatório?' },
    pushName: 'Cliente Bluma',
  },
};

test('DM: isGroup=false e author=null', () => {
  const parsed = parseEvolutionPayload(baseEv);
  assert.ok(parsed);
  assert.equal(parsed!.isGroup, false);
  assert.equal(parsed!.author, null);
  assert.equal(parsed!.identifier, '+5531999998888');
});

test('grupo: isGroup=true, identifier=JID do grupo, author=participant', () => {
  const parsed = parseEvolutionPayload(groupEv);
  assert.ok(parsed);
  assert.equal(parsed!.isGroup, true);
  assert.equal(parsed!.identifier, '+120363000000000000');
  assert.equal(parsed!.author, '+5531988887777');
  assert.equal(parsed!.agent, 'saturno');
  assert.equal(parsed!.project, 'bluma');
});

test('grupo sem participant: author=null', () => {
  const ev = { ...groupEv, data: { ...groupEv.data, key: { ...groupEv.data.key, participant: undefined } } };
  const parsed = parseEvolutionPayload(ev);
  assert.ok(parsed);
  assert.equal(parsed!.isGroup, true);
  assert.equal(parsed!.author, null);
});

test('shouldIngest: DM sempre ingere (reactive e sweep)', () => {
  const dm = parseEvolutionPayload(baseEv)!;
  assert.equal(shouldIngest(dm, 'reactive'), true);
  assert.equal(shouldIngest(dm, 'sweep'), true);
});

test('shouldIngest: grupo só ingere em sweep', () => {
  const grp = parseEvolutionPayload(groupEv)!;
  assert.equal(shouldIngest(grp, 'reactive'), false);
  assert.equal(shouldIngest(grp, 'sweep'), true);
});

// ── fromMe (mensagens enviadas pelo próprio número) ───────────────────────
test('fromMe DM: parse NÃO retorna null e marca fromMe=true', () => {
  const ev = { ...baseEv, data: { ...baseEv.data, key: { ...baseEv.data.key, fromMe: true, id: 'EVOUT1' } } };
  const parsed = parseEvolutionPayload(ev);
  assert.ok(parsed, 'fromMe deve ser parseado, não descartado');
  assert.equal(parsed!.fromMe, true);
  assert.equal(parsed!.isGroup, false);
  assert.equal(parsed!.identifier, '+5531999998888');
});
test('fromMe=false continua marcando fromMe=false', () => {
  const parsed = parseEvolutionPayload(baseEv);
  assert.ok(parsed);
  assert.equal(parsed!.fromMe, false);
});
test('fromMe em grupo: parseado, isGroup=true, fromMe=true', () => {
  const ev = { ...groupEv, data: { ...groupEv.data, key: { ...groupEv.data.key, fromMe: true, id: 'EVGOUT1' } } };
  const parsed = parseEvolutionPayload(ev);
  assert.ok(parsed);
  assert.equal(parsed!.fromMe, true);
  assert.equal(parsed!.isGroup, true);
  assert.equal(parsed!.identifier, '+120363000000000000');
});

// ── canonicalização LID (@lid → número real via *Alt) ─────────────────────
test('DM @lid usa remoteJidAlt (número real) como identifier', () => {
  const ev = { ...baseEv, data: { ...baseEv.data, key: { remoteJid: '166730898927796@lid', remoteJidAlt: '553196039118@s.whatsapp.net', fromMe: false, id: 'EVLID1', addressingMode: 'lid' } } };
  const p = parseEvolutionPayload(ev);
  assert.ok(p);
  assert.equal(p!.identifier, '+553196039118');
  assert.equal(p!.isGroup, false);
});
test('@lid sem alt mantém o lid (fallback)', () => {
  const ev = { ...baseEv, data: { ...baseEv.data, key: { remoteJid: '166730898927796@lid', fromMe: false, id: 'EVLID2' } } };
  const p = parseEvolutionPayload(ev);
  assert.ok(p);
  assert.equal(p!.identifier, '+166730898927796');
});
test('grupo: author usa participantAlt quando participant é @lid', () => {
  const ev = { ...groupEv, data: { ...groupEv.data, key: { remoteJid: '120363000000000000@g.us', participant: '228617015537729@lid', participantAlt: '553187508613@s.whatsapp.net', fromMe: false, id: 'EVLID3', addressingMode: 'lid' } } };
  const p = parseEvolutionPayload(ev);
  assert.ok(p);
  assert.equal(p!.isGroup, true);
  assert.equal(p!.identifier, '+120363000000000000');
  assert.equal(p!.author, '+553187508613');
});
test('número real (@s.whatsapp.net) não é alterado', () => {
  const p = parseEvolutionPayload(baseEv); // remoteJid 5531999998888@s.whatsapp.net
  assert.ok(p);
  assert.equal(p!.identifier, '+5531999998888');
});

// ── Áudio (audioMessage / pttMessage) ────────────────────────────────────────
test('extractMedia detecta audioMessage com mime e duração', () => {
  const m = extractMedia({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7 } });
  assert.deepEqual(m, { kind: 'audio', mime: 'audio/ogg; codecs=opus', durationS: 7 });
});
test('extractMedia detecta pttMessage', () => {
  const m = extractMedia({ pttMessage: { mimetype: 'audio/ogg', seconds: 3 } });
  assert.deepEqual(m, { kind: 'audio', mime: 'audio/ogg', durationS: 3 });
});
test('extractMedia desempacota ephemeral/viewOnce', () => {
  assert.equal(extractMedia({ ephemeralMessage: { message: { audioMessage: { mimetype: 'audio/ogg', seconds: 2 } } } })?.kind, 'audio');
  assert.equal(extractMedia({ viewOnceMessageV2: { message: { audioMessage: { seconds: 1 } } } })?.kind, 'audio');
});
test('extractMedia em texto puro é null', () => {
  assert.equal(extractMedia({ conversation: 'oi' }), null);
});
test('parseEvolutionPayload popula media em áudio e messageText null', () => {
  const p = parseEvolutionPayload({
    event: 'messages.upsert', instance: 'inst-x',
    data: { key: { remoteJid: '5531999998888@s.whatsapp.net', fromMe: false, id: 'E1' }, message: { audioMessage: { mimetype: 'audio/ogg', seconds: 5 } } },
  });
  assert.equal(p?.messageText, null);
  assert.deepEqual(p?.media, { kind: 'audio', mime: 'audio/ogg', durationS: 5 });
});
