import type { Pool } from 'pg';
import { resolveByWhatsapp } from '../commands/identity.js';

/** Dias até re-tentar um participante já tentado (pode ter cadastrado o WhatsApp depois). */
const RETRY_DAYS = 30;

/**
 * Casa participante (telefone) ↔ usuário do Bloquim, reusando
 * `resolveByWhatsapp` (src/commands/identity.ts) — que já bate no endpoint
 * interno com X-Internal-Secret, normaliza pra dígitos, tem timeout e degrada
 * pra null em qualquer falha.
 *
 * Limitação herdada e ACEITA: esse helper devolve `null` tanto pra "não existe
 * usuário" quanto pra "Bloquim fora do ar", então indisponibilidade adia o
 * participante em RETRY_DAYS em vez de re-tentar no ciclo seguinte. É cosmético
 * (o nome cai pro push_name) e não justifica bifurcar um helper compartilhado
 * com o dispatcher de comandos e com o export.
 *
 * Participante `is_lid` fica FORA da fila: um LID de privacidade não é telefone,
 * e mandá-lo ao endpoint só gastaria uma chamada pra receber 404 — pior, um dia
 * poderia casar com o telefone errado de alguém.
 */
export async function resolveGroupIdentities(
  pool: Pool,
  budget: number,
  resolve: typeof resolveByWhatsapp = resolveByWhatsapp,
): Promise<{ attempted: number; matched: number; unmatched: number }> {
  const out = { attempted: 0, matched: 0, unmatched: 0 };
  if (budget <= 0) return out;

  const { rows } = await pool.query(
    `SELECT id, phone
       FROM whatsapp_group_participants
      WHERE is_lid = FALSE
        AND (resolved_at IS NULL OR resolved_at < NOW() - INTERVAL '${RETRY_DAYS} days')
      ORDER BY (resolved_at IS NOT NULL), id
      LIMIT $1`,
    [budget],
  );

  for (const r of rows) {
    out.attempted++;
    // `resolveByWhatsapp` real já degrada indisponibilidade/erro pra `null` —
    // essa exceção só existe pra proteger o lote de um `resolve` injetado (ou
    // um bug futuro) que quebre a promessa. Diferente de um `null` limpo (que É
    // resposta: "perguntamos, não achamos"), uma exceção não é resposta — não
    // carimba `resolved_at` (não teria por que adiar RETRY_DAYS um participante
    // que nem chegou a ser consultado de fato) nem conta como matched/unmatched.
    // O lote segue pro próximo participante.
    let user;
    try {
      user = await resolve(r.phone as string);
    } catch {
      continue;
    }
    if (user) {
      await pool.query(
        `UPDATE whatsapp_group_participants
            SET bloquim_user_id = $2, bloquim_name = $3, resolved_at = NOW()
          WHERE id = $1`,
        [r.id, user.userId, user.name],
      );
      out.matched++;
    } else {
      // Só carimba a tentativa. NÃO limpa bloquim_user_id: uma indisponibilidade
      // do Bloquim não pode apagar um match que já foi feito.
      await pool.query(
        `UPDATE whatsapp_group_participants SET resolved_at = NOW() WHERE id = $1`,
        [r.id],
      );
      out.unmatched++;
    }
  }
  return out;
}
