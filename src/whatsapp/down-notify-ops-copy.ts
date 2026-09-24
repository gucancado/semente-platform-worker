import { fmtBrtShort } from './down-notify.js';

/**
 * Cópia do aviso de queda para o OPERADOR.
 *
 * Hoje o aviso vai só para o telefone que caiu (`down-notify-sender.ts`), então
 * o dono da operação nunca fica sabendo — descobre quando alguém reclama. Esta
 * cópia usa o mesmo número Cloud, mas o template `aviso_operacional_v1`
 * (o do painel), e NÃO o `conexao_whatsapp_caiu_v2`: aquele texto manda
 * "escaneie o QR com este celular", instrução falsa para quem só está
 * acompanhando.
 *
 * ⚠️ A cópia NÃO leva o link de reconexão, de propósito. O link é travado no
 * telefone esperado (`expected_phone`, CHECK no banco): se o operador tentar
 * parear o próprio aparelho, `settleReconnectLinks` detecta a divergência,
 * faz `logoutInstance` na instância DO CLIENTE e marca o link como `blocked`.
 * Mandar o link para quem não pode usá-lo transforma um aviso em um incidente.
 *
 * Módulo PURO: sem config, sem pool, sem rede — o teste roda sem .env.
 */

export type OpsCopyInput = {
  /** Nome do workspace, ou o rótulo da instância. Ausente = só o telefone. */
  name: string | null;
  phone: string;
  downSince: Date;
  /** Contagem deste aviso no episódio (1 = o primeiro) e o teto configurado. */
  notifyNumber: number;
  maxNotifies: number;
};

/**
 * `{titulo, detalhe}` na forma que o template espera: UMA linha cada, sem
 * quebra, tab, espaço repetido nem vazio — a Meta recusa o envio inteiro.
 * `opsAlertTemplateParams` sanitiza de novo do lado do envio; o que importa
 * aqui é que quem sabe RESUMIR é quem tem o dado.
 */
export function opsCopyFor(p: OpsCopyInput): { titulo: string; detalhe: string } {
  const quem = p.name ? `${oneLine(p.name)} (${p.phone})` : p.phone;
  const titulo = oneLine(`WhatsApp de ${quem} caiu`);
  const detalhe = oneLine(
    `Fora do ar desde ${fmtBrtShort(p.downSince)}. ` +
      `Aviso ${p.notifyNumber} de ${p.maxNotifies} enviado ao proprio aparelho, com o link de reconexao. ` +
      `Reconectar e no celular do numero — o link e travado nele.`,
  );
  return { titulo, detalhe };
}

/**
 * O alvo do aviso JÁ é o número do operador?
 *
 * Sem este teste o dono recebe a mesma queda duas vezes: uma pelo aviso
 * principal (que vai para o número que caiu) e outra pela cópia.
 *
 * Compara só os DÍGITOS, porque os dois valores vêm de fontes com formatos
 * diferentes: `whatsapp_numbers.phone` / `expected_phone` guardam E.164 com '+'
 * (`+553195950748`) e `OPS_NOTIFY_TO` é E.164 sem ele (`553196039118`).
 *
 * O nono dígito é tratado à parte porque é real e determinístico no Brasil: o
 * MESMO celular aparece como 55 + DDD + 9 dígitos e como 55 + DDD + 8 dígitos
 * conforme quem gravou. A tolerância é NARROW — só entre um número de 13 e um
 * de 12 dígitos, ambos começando em 55, e só quando o de 13 tem o '9' inicial
 * no assinante. Fora disso, igualdade exata: errar para o lado de duplicar uma
 * mensagem é barato; errar para o lado de suprimir um aviso legítimo, não.
 */
export function sameWhatsappNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = digits(a);
  const y = digits(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return withoutNinthDigit(x) === withoutNinthDigit(y);
}

function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D+/g, '');
}

/** `5531 9 95950748` → `553195950748`. Qualquer outra forma volta intacta. */
function withoutNinthDigit(n: string): string {
  if (n.length !== 13 || !n.startsWith('55') || n[4] !== '9') return n;
  return n.slice(0, 4) + n.slice(5);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
