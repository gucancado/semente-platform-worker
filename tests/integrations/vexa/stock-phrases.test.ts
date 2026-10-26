import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStockPhrase, stripStockPhrases } from '../../../src/integrations/vexa/stock-phrases.js';
import { vexaMeetingToEpisodeInput } from '../../../src/integrations/vexa/normalize.js';

test('isStockPhrase: trecho inteiro inventado', () => {
  for (const t of ['Tchau, tchau!', 'Muito obrigado.', 'Até a próxima.', 'Muito obrigado e até a próxima!',
    'Legendas pela comunidade Amara.org', 'Legendas pela comunidade da Amara.org Muito obrigado', 'www.opusdei.pt', '  ']) {
    assert.equal(isStockPhrase(t), true, t);
  }
});

test('isStockPhrase: fala de reunião passa', () => {
  for (const t of ['Muito obrigado, Jéssica, pela apresentação.', 'Beleza.', 'É isso aí.', 'Um abraço.',
    'Tchau, Gustavo.', 'Até a próxima reunião a gente fecha o cronograma.']) {
    assert.equal(isStockPhrase(t), false, t);
  }
});

test('stripStockPhrases: limpa fala juntada do histórico (caso real, episódio 519)', () => {
  const raw = 'E a gente vai fazer essa transição para a Estela. Tchau, tchau. Tchau, tchau! e a frente do processo de '
    + 'construção desses cronogramas e também da... Legendas pela comunidade Amara.org Tchau, tchau. desse vínculo com a '
    + 'nossa criação, Muito obrigado e até a próxima! então a parte de construção desses criativos. Legendas pela '
    + 'comunidade da Amara.org Gustavo, Estela, querem acrescentar?';
  assert.equal(
    stripStockPhrases(raw),
    'E a gente vai fazer essa transição para a Estela. e a frente do processo de construção desses cronogramas e '
    + 'também da... desse vínculo com a nossa criação, então a parte de construção desses criativos. Gustavo, Estela, '
    + 'querem acrescentar?',
  );
});

test('stripStockPhrases: fala sem frase inventada fica igual', () => {
  const t = 'Gustavo, Estela, querem acrescentar? Muito obrigado, Jéssica, pela apresentação.';
  assert.equal(stripStockPhrases(t), t);
});

test('vexaMeetingToEpisodeInput descarta trecho inventado antes de virar fala e participante', () => {
  const ep = vexaMeetingToEpisodeInput({
    id: 1, native_meeting_id: 'abc-defg-hij', start_time: null, end_time: null,
    segments: [
      { start: 100, end: 101, speaker: 'Ana', text: 'Bom dia a todos.' },
      { start: 101, end: 102, speaker: 'Ana', text: 'Tchau, tchau!' },
      { start: 102, end: 103, speaker: 'Speaker', text: 'Legendas pela comunidade Amara.org' },
      { start: 103, end: 105, speaker: 'Ana', text: 'Vamos começar.' },
    ],
  } as any, null);
  assert.deepEqual(ep.turns.map((t) => [t.speaker_name, t.text]), [['Ana', 'Bom dia a todos. Vamos começar.']]);
  assert.deepEqual(ep.participants.map((p) => p.name), ['Ana']);
});
