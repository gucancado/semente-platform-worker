/**
 * src/whatsapp/text-safety.ts
 *
 * Saneamento de texto que vai para o corpo de uma chamada HTTP JSON. PURO.
 *
 * POR QUE: duas conversas do Bluma | Recrutamento falhavam em TODO run do motor
 * de IA com `400 Invalid body: failed to parse JSON value` — sempre as mesmas,
 * nunca as outras. A causa: `text.slice(0, MAX_TEXT_CHARS)` corta por unidade
 * UTF-16, então um emoji na fronteira do limite vira METADE de um par surrogate
 * (`\ud83d` sozinho). `JSON.stringify` propaga esse órfão como escape, e o parser
 * JSON do servidor (estrito quanto a surrogates órfãos, como serde) recusa o body
 * inteiro. O texto no banco está perfeito — quem quebra é o corte.
 *
 * Duas camadas, de propósito:
 *   - `truncateSafe` conserta a ORIGEM (corta no limite de code point).
 *   - `stripLoneSurrogates` é a rede na BORDA da chamada, porque emoji partido
 *     pode entrar por qualquer outro caminho (nome de contato, título de
 *     oportunidade, tag) e o sintoma — uma conversa que nunca é julgada, sem
 *     nada de errado no dado — custa caro pra diagnosticar.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** true se há surrogate órfão (alto sem baixo, ou baixo sem alto). */
export function hasLoneSurrogate(s: string): boolean {
  LONE_SURROGATE.lastIndex = 0;
  return LONE_SURROGATE.test(s);
}

/** Remove surrogates órfãos, preservando pares válidos. No-op em texto são. */
export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE, '');
}

/**
 * Trunca para no máximo `max` unidades UTF-16 SEM partir par surrogate: se o corte
 * cair entre o alto e o baixo, o caractere inteiro fica de fora.
 */
export function truncateSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  // Terminou num surrogate ALTO: o baixo dele ficaria de fora → recua 1.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
