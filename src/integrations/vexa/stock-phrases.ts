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

/** Inventado em QUALQUER posição: nunca é fala de reunião. */
const ALWAYS_JUNK = /amara\.org|opusdei\.pt|legendas? pela comunidade|legendas? por [a-zà-ú ]{2,40}amara/i;

const STOCK = new Set(STOCK_PHRASES);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…]+$/u, '').trim();
}

/** O trecho inteiro é frase inventada? (vazio também conta: não há o que guardar) */
export function isStockPhrase(text: string | null | undefined): boolean {
  if (!text || !text.trim()) return true;
  if (ALWAYS_JUNK.test(text)) return true;
  return STOCK.has(normalize(text));
}

/**
 * Limpa uma fala JÁ JUNTADA (histórico em `episode_turns`, onde os trechos foram
 * concatenados com espaço). Divide nas fronteiras de trecho que o STT deixa:
 * pontuação final seguida de espaço, ou espaço seguido de MAIÚSCULA (o Whisper
 * abre cada trecho com maiúscula, então "criação, Muito obrigado! então" separa
 * o "Muito obrigado!"). Remove só as unidades que, sozinhas, são frase inventada.
 */
export function stripStockPhrases(text: string): string {
  const units = text.split(/(?<=[.!?…])\s+|\s+(?=\p{Lu})/u);
  return units
    .filter((u) => !isStockPhrase(u))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
