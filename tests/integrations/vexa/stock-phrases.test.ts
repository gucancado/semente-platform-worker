import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStockPhrase, stripStockPhrases, stripJunk } from '../../../src/integrations/vexa/stock-phrases.js';
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

test('crédito de legenda colado em fala real: sai só o crédito', () => {
  assert.equal(
    stripStockPhrases('Amara.org porque a gente, semanalmente, faz uma reunião.'),
    'porque a gente, semanalmente, faz uma reunião.',
  );
  assert.equal(stripStockPhrases('Saiba mais em www.opusdei.pt'), '');
  assert.equal(stripStockPhrases('Legendas pela comunidade do Amara.org Muito obrigado'), '');
});

test('encerramento de vídeo colado em fala real (casos do histórico)', () => {
  assert.equal(
    stripStockPhrases('Só que assim, gente, curso não é mentoria, né? se inscreva no canal e ative o sininho para receber notificações de novos vídeos.'),
    'Só que assim, gente, curso não é mentoria, né?',
  );
  assert.equal(
    stripStockPhrases('E aí, com relação ao... Para mais vídeos acesse www.leonardomunizodonto.com.br'),
    'E aí, com relação ao...',
  );
  assert.equal(stripStockPhrases('Se inscreva no canal e ative o sininho.'), '');
  assert.equal(stripStockPhrases('Aí também deu a mesma coisa. Um abraço e até o próximo vídeo. Indo do anúncio, estou no feed.'),
    'Aí também deu a mesma coisa. Indo do anúncio, estou no feed.');
  assert.equal(stripStockPhrases('Deus lhe abençoe.'), '');
});

test('assunto de reunião sobre vídeo e canal não é tocado', () => {
  for (const t of ['A gente grava até o próximo vídeo da série.', 'Pede pra galera se inscrever no canal do YouTube.',
    'O CTA do vídeo vai ser: inscreva-se no canal.']) {
    assert.equal(stripStockPhrases(t), t);
  }
});

test('stripJunk (Fireflies): tira crédito, mantém despedida real', () => {
  assert.equal(stripJunk('Legendas pela comunidade Amara.org Gente! Olá! Tá todo mundo aí?'), 'Gente! Olá! Tá todo mundo aí?');
  assert.equal(stripJunk('Amara.org.'), '');
  assert.equal(stripJunk('Valeu. Tchau, tchau.'), 'Valeu. Tchau, tchau.');
});

test('fala sem frase inventada sai idêntica, byte a byte (espaços e pontuação)', () => {
  for (const t of ['Equipe, adicionar membro é com .com ou .com.br?', 'então por exemplo... ...comemora a primavera', 'a  b']) {
    assert.equal(stripJunk(t), t);
    assert.equal(stripStockPhrases(t), t);
  }
});

test('cauda "para receber as notificações" sai junto; ponto do crédito não duplica', () => {
  assert.equal(stripJunk('Aí acabou. se inscreva no canal e ative o sininho para receber as notificações. Equipe X.'), 'Aí acabou. Equipe X.');
  assert.equal(stripJunk('vou pegar uma água. Legendas pela comunidade Amara.org Legendas pela comunidade.'), 'vou pegar uma água.');
});

test('variantes "dos novos vídeos" e "Obrigado por assistir,"', () => {
  assert.equal(stripJunk('e aí nisso... se inscreva no canal e ative o sininho para receber as notificações dos novos vídeos.'), 'e aí nisso...');
  assert.equal(stripJunk('Obrigado por assistir, se inscreva no canal e ative o sininho para receber notificações de novos vídeos.'), '');
});

test('crédito "Transcrição e Legendas www.intervoices.com" (visto ao vivo em 27/10)', () => {
  assert.equal(stripJunk('Transcrição e Legendas www.intervoices.com'), '');
  assert.equal(stripJunk('Fechamos o cronograma. Transcrição e Legendas www.intervoices.com'), 'Fechamos o cronograma.');
  assert.equal(stripJunk('Legendas por intervoices.com'), '');
  assert.equal(stripJunk('Tradução e Legendas www.intervoices.com'), '');
  assert.equal(stripJunk('Transcrição e Legendas www.intervoices.com.br Olhando as contas.'), 'Olhando as contas.');
  assert.equal(stripJunk('um certo preconceito. Contribuição e Legendas www.intervoices.com.br'), 'um certo preconceito.');
});
