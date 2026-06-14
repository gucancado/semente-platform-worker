// Chunking deterministico de turnos da Lua (spec Lua v1 §5.3, Estagio A, passo 1).
//
// Um chunk = turnos consecutivos concatenados, cada turno renderizado como
// `"<falante>: <texto>"` e juntados por "\n", acumulando ate ~targetTokens e
// cortando SEMPRE em fronteira de turno. A unica excecao e o monologo: um turno
// cujo render passa de maxTurnTokens e fatiado intra-turno em pedacos de
// ~targetTokens, cada pedaco virando um chunk com char_start/char_end preenchidos
// (offsets de caractere DENTRO do texto daquele turno) e turnStart == turnEnd.
//
// Puro: sem DB, sem rede, sem LLM. O shape de retorno espelha `ChunkInput`
// (src/lua/db.ts) menos os campos de embedding (embedding/embeddingModel), que
// sao preenchidos no Estagio A do pipeline. O estimador de tokens mora aqui e e
// compartilhado com o batching de embeddings (src/lua/embeddings.ts) para que a
// heuristica nunca seja duplicada.

export type Turn = {
  turn_index: number;
  speaker: string;
  text: string;
};

export type ChunkOpts = {
  /** Alvo de tokens por chunk (corte em fronteira de turno ao atingir). Default 450. */
  targetTokens?: number;
  /** Acima disso, um turno isolado e tratado como monologo e fatiado intra-turno. Default 700. */
  maxTurnTokens?: number;
};

/** Chunk produzido pelo chunking (= `ChunkInput` sem os campos de embedding). */
export type ChunkResult = {
  chunkIndex: number;
  turnStart: number;
  turnEnd: number;
  charStart: number | null;
  charEnd: number | null;
  text: string;
  tokenCount: number;
};

const DEFAULT_TARGET_TOKENS = 450;
const DEFAULT_MAX_TURN_TOKENS = 700;

/**
 * Estimativa barata de tokens a partir do tamanho do texto.
 *
 * Heuristica chars/4 (`Math.ceil(text.length / 4)`, spec §5.3-A1). Nao e exata —
 * serve para dimensionar lotes e chunks com folga, nunca para cobranca. Exportada
 * para que chunking e batching de embeddings usem EXATAMENTE o mesmo estimador.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Renderiza um turno como linha "<falante>: <texto>". */
function renderTurn(turn: Turn): string {
  return `${turn.speaker}: ${turn.text}`;
}

/**
 * Agrupa turnos consecutivos em chunks de ~targetTokens, cortando em fronteira de
 * turno. Turno isolado maior que maxTurnTokens vira monologo e e fatiado intra-turno.
 * chunkIndex e 0-based e sequencial ao longo do episodio inteiro.
 */
export function chunkTurns(turns: Turn[], opts: ChunkOpts = {}): ChunkResult[] {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const maxTurnTokens = opts.maxTurnTokens ?? DEFAULT_MAX_TURN_TOKENS;

  const chunks: ChunkResult[] = [];
  let chunkIndex = 0;

  // Acumulador de turnos consecutivos do chunk multi-turno corrente.
  let bufLines: string[] = [];
  let bufStart = -1;
  let bufEnd = -1;

  const flushBuffer = (): void => {
    if (bufLines.length === 0) return;
    const text = bufLines.join('\n');
    chunks.push({
      chunkIndex: chunkIndex++,
      turnStart: bufStart,
      turnEnd: bufEnd,
      charStart: null,
      charEnd: null,
      text,
      tokenCount: estimateTokens(text),
    });
    bufLines = [];
    bufStart = -1;
    bufEnd = -1;
  };

  for (const turn of turns) {
    const rendered = renderTurn(turn);
    const renderedTokens = estimateTokens(rendered);

    // Monologo: turno isolado maior que o teto duro => fatia intra-turno.
    // Fecha qualquer buffer multi-turno pendente antes, para preservar a ordem.
    if (renderedTokens > maxTurnTokens) {
      flushBuffer();
      for (const piece of splitMonologue(turn, targetTokens)) {
        chunks.push({ ...piece, chunkIndex: chunkIndex++ });
      }
      continue;
    }

    // Se adicionar este turno estouraria o alvo e ja ha conteudo no buffer,
    // corta na fronteira (fecha o buffer atual) antes de comecar o novo.
    if (bufLines.length > 0) {
      const candidateTokens = estimateTokens([...bufLines, rendered].join('\n'));
      if (candidateTokens > targetTokens) {
        flushBuffer();
      }
    }

    if (bufLines.length === 0) bufStart = turn.turn_index;
    bufLines.push(rendered);
    bufEnd = turn.turn_index;
  }

  flushBuffer();
  return chunks;
}

/**
 * Fatia o texto de um turno-monologo em pedacos de ~targetTokens, preferindo
 * fronteiras de paragrafo/sentenca. Cada pedaco recebe o prefixo "<falante>: ",
 * mas os offsets char_start/char_end apontam para o texto ORIGINAL do turno
 * (sem o prefixo) e cobrem o texto inteiro em ordem, sem buraco nem sobreposicao.
 */
function splitMonologue(
  turn: Turn,
  targetTokens: number,
): Omit<ChunkResult, 'chunkIndex'>[] {
  const src = turn.text;
  const prefix = `${turn.speaker}: `;
  // Orcamento de tokens para o texto dentro de um pedaco, ja descontado o prefixo.
  const prefixTokens = estimateTokens(prefix);
  const budgetTokens = Math.max(1, targetTokens - prefixTokens);
  // Orcamento em caracteres (estimador e chars/4): cada token ~= 4 chars.
  const budgetChars = Math.max(1, budgetTokens * 4);

  // Pontos de corte candidatos: fim de paragrafo (\n) ou de sentenca (. ! ?),
  // ordenados. O corte real e a ultima fronteira <= cursor+budget; se nenhuma
  // existir na janela (parede de texto sem pontuacao), corta no budget bruto.
  const boundaries = findBoundaries(src);

  const pieces: Omit<ChunkResult, 'chunkIndex'>[] = [];
  let cursor = 0;
  while (cursor < src.length) {
    const hardEnd = Math.min(src.length, cursor + budgetChars);
    let end: number;
    if (hardEnd >= src.length) {
      end = src.length;
    } else {
      // Maior fronteira no intervalo (cursor, hardEnd]; senao corte bruto.
      const b = lastBoundaryAtMost(boundaries, hardEnd, cursor);
      end = b > cursor ? b : hardEnd;
    }

    const text = prefix + src.slice(cursor, end);
    pieces.push({
      turnStart: turn.turn_index,
      turnEnd: turn.turn_index,
      charStart: cursor,
      charEnd: end,
      text,
      tokenCount: estimateTokens(text),
    });
    cursor = end;
  }

  // Turno vazio (defensivo): emite um pedaco cobrindo [0,0].
  if (pieces.length === 0) {
    pieces.push({
      turnStart: turn.turn_index,
      turnEnd: turn.turn_index,
      charStart: 0,
      charEnd: 0,
      text: prefix,
      tokenCount: estimateTokens(prefix),
    });
  }
  return pieces;
}

/**
 * Indices de FIM (exclusivo: posicao logo apos o delimitador, ja incluindo
 * espacos seguintes) de paragrafos e sentencas no texto. Inclui o fim de cada
 * "\n" e de cada grupo de pontuacao terminal (. ! ?) seguido de espaco/fim.
 */
function findBoundaries(src: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\n') {
      out.push(i + 1);
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      // Avanca sobre pontuacao terminal repetida (ex.: "?!", "...").
      let j = i;
      while (j + 1 < src.length && '.!?'.includes(src[j + 1]!)) j++;
      // So conta como fronteira se vier espaco/quebra ou fim do texto a seguir.
      const next = src[j + 1];
      if (next === undefined || next === ' ' || next === '\n' || next === '\t') {
        // Inclui o espaco seguinte no pedaco para nao deixa-lo orfao no proximo.
        let k = j + 1;
        while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
        out.push(k);
      }
      i = j;
    }
  }
  return out;
}

/** Maior fronteira `b` com `lo < b <= hi`; 0 se nenhuma existir. */
function lastBoundaryAtMost(boundaries: number[], hi: number, lo: number): number {
  let best = 0;
  // boundaries esta em ordem crescente; varredura simples (lista pequena por chunk).
  for (const b of boundaries) {
    if (b > hi) break;
    if (b > lo) best = b;
  }
  return best;
}
