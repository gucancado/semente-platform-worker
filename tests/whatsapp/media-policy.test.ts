import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMediaError,
  cleanFilename,
  contentDisposition,
  mediaExtension,
  mediaIngestPlan,
  mediaMessageText,
  mediaObjectKey,
  planMediaRetry,
  retentionEnabled,
  storageVerdict,
  type MediaIngestInput,
} from '../../src/whatsapp/media-policy.js';
import type { ParsedMedia } from '../../src/webhook/evolution.js';

const MB = 1024 * 1024;
const media = (over: Partial<ParsedMedia> = {}): ParsedMedia => ({
  kind: 'image', mime: 'image/jpeg', durationS: null, sizeBytes: 100_000, filename: null, ...over,
});
const input = (over: Partial<MediaIngestInput> = {}): MediaIngestInput => ({
  mode: 'on', isGroup: false, media: media(), maxBytes: 16 * MB, kinds: ['image', 'video', 'document'], ...over,
});

// ── mediaIngestPlan ─────────────────────────────────────────────────────────

test('modo off não grava nada — ingest idêntico ao de antes', () => {
  assert.deepEqual(mediaIngestPlan(input({ mode: 'off' })), { record: false });
});
test('grupo, áudio e ausência de mídia não passam por aqui', () => {
  assert.deepEqual(mediaIngestPlan(input({ isGroup: true })), { record: false });
  assert.deepEqual(mediaIngestPlan(input({ media: media({ kind: 'audio' }) })), { record: false });
  assert.deepEqual(mediaIngestPlan(input({ media: null })), { record: false });
});
test('imagem dentro do teto é baixada', () => {
  assert.deepEqual(mediaIngestPlan(input()), { record: true, status: 'pending' });
});
test('documento acima do teto grava a mensagem mas não o arquivo', () => {
  const plan = mediaIngestPlan(input({ media: media({ kind: 'document', sizeBytes: 114 * MB }) }));
  assert.deepEqual(plan, { record: true, status: 'skipped_size' });
});
test('tamanho desconhecido não recusa — o teto é conferido depois do download', () => {
  assert.deepEqual(mediaIngestPlan(input({ media: media({ sizeBytes: null }) })), { record: true, status: 'pending' });
});
test('figurinha e tipo fora da lista viram só marcador', () => {
  assert.deepEqual(mediaIngestPlan(input({ media: media({ kind: 'sticker' }) })), { record: true, status: 'skipped_policy' });
  assert.deepEqual(mediaIngestPlan(input({ media: media({ kind: 'video' }), kinds: ['image'] })), { record: true, status: 'skipped_policy' });
});

// ── Texto da mensagem ───────────────────────────────────────────────────────

test('marcador sem e com legenda', () => {
  assert.equal(mediaMessageText(media(), null), '[imagem]');
  assert.equal(mediaMessageText(media(), '  quanto custa?  '), '[imagem] quanto custa?');
  assert.equal(mediaMessageText(media({ kind: 'video' }), null), '[vídeo]');
  assert.equal(mediaMessageText(media({ kind: 'sticker' }), null), '[figurinha]');
});
test('documento leva o nome; sem nome, só o tipo', () => {
  assert.equal(mediaMessageText(media({ kind: 'document', filename: 'orçamento.pdf' }), 'segue'), '[documento: orçamento.pdf] segue');
  assert.equal(mediaMessageText(media({ kind: 'document', filename: null }), null), '[documento]');
});
test('nome de arquivo hostil não quebra o marcador', () => {
  assert.equal(cleanFilename('a]b[c\nd.pdf'), 'a)b(c d.pdf');
  assert.equal(cleanFilename('   '), null);
  assert.equal(cleanFilename('x'.repeat(200))!.length, 120);
});

// ── Armazenamento ───────────────────────────────────────────────────────────

test('extensão pelo mime (com parâmetros), depois pelo nome, senão bin', () => {
  assert.equal(mediaExtension('image/jpeg', null), 'jpg');
  assert.equal(mediaExtension('video/mp4; codecs=avc1', null), 'mp4');
  assert.equal(mediaExtension('application/octet-stream', 'planilha.XLSX'), 'xlsx');
  assert.equal(mediaExtension(null, 'arquivo.sem-extensao-valida'), 'bin');
  assert.equal(mediaExtension(null, null), 'bin');
});
test('key nunca usa o nome do arquivo', () => {
  assert.equal(
    mediaObjectKey({ workspaceId: 'ws-1', numberId: 3, messageId: 99, ext: 'pdf' }),
    'whatsapp-media/ws-1/3/99.pdf',
  );
  assert.equal(mediaObjectKey({ workspaceId: null, numberId: 3, messageId: 99, ext: 'jpg' }), 'whatsapp-media/na/3/99.jpg');
});
test('content-disposition só em documento, com nome codificado', () => {
  assert.equal(contentDisposition('image', 'x.jpg'), undefined);
  const cd = contentDisposition('document', 'orçamento "final" (v2).pdf')!;
  assert.match(cd, /^attachment; filename="or_amento _final_ \(v2\)\.pdf"; filename\*=UTF-8''/);
  assert.match(cd, /or%C3%A7amento%20%22final%22%20%28v2%29\.pdf$/);
});

// ── Falha e retentativa ─────────────────────────────────────────────────────

test('classifica pelo STATUS, não por substring do nome da instância', () => {
  // O path carrega "ws-500a" e "4001": substring viraria sistêmico. O status é 400.
  assert.equal(classifyMediaError(new Error('Evolution POST /chat/getBase64FromMediaMessage/ws-500a-4001 → 400')), 'item');
  assert.equal(classifyMediaError(new Error('Evolution POST /chat/getBase64FromMediaMessage/ws-x → 503')), 'systemic');
  assert.equal(classifyMediaError(new Error('Evolution POST /chat/getBase64FromMediaMessage/ws-x → 401')), 'systemic');
  assert.equal(classifyMediaError(new Error('Evolution POST /chat/getBase64FromMediaMessage/ws-x → 404')), 'item');
});
test('classifica erro de rede, do SDK do R2 e do próprio arquivo', () => {
  assert.equal(classifyMediaError(new TypeError('fetch failed')), 'systemic');
  assert.equal(classifyMediaError(Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } })), 'systemic');
  assert.equal(classifyMediaError(Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 403 } })), 'systemic');
  assert.equal(classifyMediaError(new Error('evolution base64 vazio (mídia não pronta)')), 'item');
  assert.equal(classifyMediaError(new Error('r2: verificação falhou pra k (esperado 3, gravado 2)')), 'item');
});
test('sistêmico não consome tentativa e desiste só pela idade', () => {
  assert.deepEqual(planMediaRetry({ cls: 'systemic', attempts: 9, maxAttempts: 4, ageH: 10 }), { action: 'retry', backoffSec: 900, consumesAttempt: false });
  assert.deepEqual(planMediaRetry({ cls: 'systemic', attempts: 1, maxAttempts: 4, ageH: 73 }), { action: 'fail', backoffSec: 0, consumesAttempt: false });
});
test('falha do arquivo consome tentativa até o teto', () => {
  assert.deepEqual(planMediaRetry({ cls: 'item', attempts: 2, maxAttempts: 4, ageH: 0 }), { action: 'retry', backoffSec: 120, consumesAttempt: true });
  assert.deepEqual(planMediaRetry({ cls: 'item', attempts: 4, maxAttempts: 4, ageH: 0 }), { action: 'fail', backoffSec: 0, consumesAttempt: true });
});

// ── Expiração e orçamento ───────────────────────────────────────────────────

test('expiração: 0 desliga, abaixo de 30 é recusado, 180 liga', () => {
  assert.equal(retentionEnabled(0), false);
  assert.equal(retentionEnabled(1), false);
  assert.equal(retentionEnabled(29), false);
  assert.equal(retentionEnabled(30), true);
  assert.equal(retentionEnabled(180), true);
  assert.equal(retentionEnabled(Number.NaN), false);
  assert.equal(retentionEnabled(180.5), false);
});
test('revisão só ACIMA de 70% do orçamento', () => {
  const GB = 1024 ** 3;
  assert.equal(storageVerdict(14 * GB, 20).overThreshold, false);
  assert.equal(storageVerdict(14.01 * GB, 20).overThreshold, true);
  assert.equal(storageVerdict(10 * GB, 20).pct, 0.5);
  assert.equal(storageVerdict(1, 0).overThreshold, false);
});
