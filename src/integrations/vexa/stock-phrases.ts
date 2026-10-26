/**
 * Frases que o Whisper inventa em trecho sem fala (encerramento de vídeo do
 * YouTube e créditos de legenda), em pt-BR.
 *
 * Medido em 2026-10-26 nas 14.839 falas de reunião vindas do Vexa: "tchau,
 * tchau" 1.370×, "muito obrigado" 1.297×, "até a próxima" 677×, "legendas pela
 * comunidade amara.org" 459×, "www.opusdei.pt" 28×. Elas chegam como trecho
 * ISOLADO (o STT devolve um trecho por pedaço de áudio), então descartar o
 * trecho inteiro não corta fala real.
 *
 * Custo aceito: um "Tchau, tchau!" ou "Muito obrigado." DE VERDADE, dito sozinho
 * como trecho próprio, também some. A lista evita o vocabulário de conversa
 * ("beleza", "é isso", "valeu", "um abraço") que aparece de verdade em reunião.
 *
 * A mesma lista vai pro Vexa (`ops/vexa/hallucinations-pt.txt`, montado sobre a
 * lista da imagem) pra filtrar na origem; aqui é a segunda proteção, e a que
 * limpa o histórico (`cli/strip-meeting-hallucinations.ts`).
 */

/** Comparados com o trecho inteiro, em minúsculas e sem pontuação final. */
export const STOCK_PHRASES: readonly string[] = [
  'tchau, tchau',
  'tchau tchau',
  'tchau, tchau, tchau',
  'muito obrigado',
  'muito obrigada',
  'muito obrigado e até a próxima',
  'muito obrigada e até a próxima',
  'obrigado e até a próxima',
  'até a próxima',
  'até o próximo vídeo',
  'até o próximo',
  'obrigado por assistir',
  'obrigada por assistir',
  'obrigado por assistirem',
  'inscreva-se no canal',
  'se inscreva no canal',
  'um beijo e um abraço',
  'um beijo e até a próxima',
  'deus te abençoe',
  'que deus te abençoe',
  'deus lhe abençoe',
  'que deus lhe abençoe',
  'um abraço e até o próximo vídeo',
  'inscreva-se no nosso canal',
  'se inscreva no nosso canal',
];

/**
 * Créditos de legenda e encerramento de vídeo: nunca são fala de reunião, em
 * QUALQUER posição. Sai só o pedaço, não a frase: já veio "Amara.org porque a
 * gente, semanalmente, faz uma reunião…" num trecho só, e apagar o trecho levaria
 * a fala real junto. Medido no histórico em 2026-10-27: "Se inscreva no canal e
 * ative o sininho para receber notificações de novos vídeos" 90×, "Para mais
 * vídeos acesse www.…" 14×, vindos colados em fala real.
 *
 * "Até o próximo vídeo" e "se inscreva no canal" SOZINHOS ficam fora daqui (são
 * unidade inteira em STOCK_PHRASES): numa agência, falar de vídeo e canal é
 * assunto de reunião. Aqui só entra o que tem a cauda inconfundível (sininho, URL).
 */
const ALWAYS_JUNK = new RegExp('(?:' + [
  String.raw`(?:saiba mais em )?www\.opusdei\.pt`,
  String.raw`legendas? pela comunidade(?: d[aoe])?(?: amara\.org)?`,
  String.raw`amara\.org`,
  String.raw`(?:(?:e )?(?:se )?inscreva(?:-se)? no (?:nosso )?canal,? e )?ative o sininho(?: para receber (?:as )?notifica\S*(?: (?:de|sobre|dos|das) (?:novos )?vídeos)?)?`,
  String.raw`para mais vídeos,? acesse \S+`,
  String.raw`obrigad[oa] por assistir(?:em)?,?`,
].join('|') + ')[.!]?', 'giu');

/** Só os créditos/encerramentos (sem a lista de despedidas). Para transcrição que
 *  não vem do Whisper ao vivo (Fireflies), onde "Tchau, tchau." é despedida real. */
export function stripJunk(text: string): string {
  // Sem crédito no texto, devolve o texto INTOCADO (nem espaço muda): a limpeza do
  // histórico compara antes/depois, e normalizar fala sem frase inventada viraria
  // alteração em massa sem motivo.
  if (text.search(ALWAYS_JUNK) === -1) return text;
  const out = text.replace(ALWAYS_JUNK, ' ').replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

const STOCK = new Set(STOCK_PHRASES);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…]+$/u, '').trim();
}

/**
 * Tira as frases inventadas de um texto. Serve tanto pro trecho que chega do STT
 * quanto pra fala JÁ JUNTADA do histórico (`episode_turns`, trechos concatenados
 * com espaço): divide nas fronteiras que o STT deixa (pontuação final seguida de
 * espaço, ou espaço seguido de MAIÚSCULA, já que o Whisper abre cada trecho com
 * maiúscula: "criação, Muito obrigado! então" separa o "Muito obrigado!") e
 * remove só as unidades que, sozinhas, são frase inventada.
 */
export function stripStockPhrases(text: string): string {
  const base = stripJunk(text);
  const units = base.split(/(?<=[.!?…])\s+|\s+(?=\p{Lu})/u);
  const kept = units.filter((u) => u.trim() && !/^[\s.,!?…]+$/u.test(u) && !STOCK.has(normalize(u)));
  // Nada removido: devolve o texto como veio (mesma razão do stripJunk).
  if (base === text && kept.length === units.length) return text;
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/** O trecho inteiro é frase inventada? (vazio também conta: não há o que guardar) */
export function isStockPhrase(text: string | null | undefined): boolean {
  return !text || stripStockPhrases(text) === '';
}
