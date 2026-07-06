import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFor, OpenAITranscriptionProvider } from '../../src/transcription/provider.js';

test('costFor calcula por duração e modelo', () => {
  const c = costFor('gpt-4o-mini-transcribe', 60); // 1 min
  assert.ok(c > 0 && c < 0.01);
  assert.equal(costFor('gpt-4o-mini-transcribe', null), 0);
});

test('OpenAI provider chama audio.transcriptions.create e devolve texto+custo', async () => {
  const fakeClient = { audio: { transcriptions: { create: async (args: any) => {
    assert.equal(args.model, 'gpt-4o-mini-transcribe');
    assert.equal(args.language, 'pt');
    return { text: 'olá mundo' };
  } } } };
  const p = new OpenAITranscriptionProvider({ apiKey: 'k', model: 'gpt-4o-mini-transcribe', client: fakeClient as any });
  const r = await p.transcribe(Buffer.from('abc'), { mime: 'audio/ogg', durationS: 30 });
  assert.equal(r.text, 'olá mundo');
  assert.equal(r.model, 'gpt-4o-mini-transcribe');
  assert.ok(r.costUsd > 0);
});
