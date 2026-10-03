/**
 * src/meetings-read/failure-label.ts
 *
 * Rótulo pt-BR curto do `failure_reason` de uma coleta, para quem lê a lista de
 * falhas (MCP/painel) entender a causa sem conhecer os códigos internos. PURO.
 *
 * O texto do silent_room recebe o timeout de config porque o número ESTÁ na
 * frase: hardcoded, ele mentiria no dia em que MEETINGS_ADMISSION_TIMEOUT_MIN
 * mudar (já mudou uma vez: default 10, prod 20).
 */
export function failureLabel(reason: string | null, opts: { admissionTimeoutMin: number }): string {
  switch (reason) {
    case 'silent_room':
      return `Ninguém falou nos primeiros ${opts.admissionTimeoutMin} min (sala vazia, bot na sala de espera ou reunião não aconteceu)`;
    case 'vexa_failed':
      return 'O bot falhou no Vexa';
    case 'vexa_send_failed':
      return 'O Vexa recusou o bot (ex.: outro bot já estava na sala)';
    case 'no_slot':
      return 'Sem vaga de bot no horário';
    case 'not_admitted':
      // Rótulo antigo de silent_room (ver service.ts): a causa real é ambígua.
      return 'Bot não admitido (registro antigo)';
    case 'stopped_empty':
      return 'Parada manual sem fala';
    case null:
      return 'Falha sem motivo registrado';
    default:
      return `Falha na coleta (${reason})`;
  }
}
