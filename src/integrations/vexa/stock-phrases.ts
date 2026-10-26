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
];

/**
 * Créditos de legenda: nunca são fala de reunião, em QUALQUER posição. Sai só o
 * pedaço, não a frase: já veio "Amara.org porque a gente, semanalmente, faz uma
 * reunião…" num trecho só, e apagar o trecho levaria a fala real junto.
 */
const ALWAYS_JUNK = /(?:saiba mais em )?www\.opusdei\.pt|legendas? pela comunidade(?: d[aoe])?(?: amara\.org)?|amara\.org/giu;

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
  const units = text.replace(ALWAYS_JUNK, ' ').split(/(?<=[.!?…])\s+|\s+(?=\p{Lu})/u);
  return units
    .filter((u) => u.trim() && !/^[\s.,!?…]+$/u.test(u) && !STOCK.has(normalize(u)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** O trecho inteiro é frase inventada? (vazio também conta: não há o que guardar) */
export function isStockPhrase(text: string | null | undefined): boolean {
  return !text || stripStockPhrases(text) === '';
}
