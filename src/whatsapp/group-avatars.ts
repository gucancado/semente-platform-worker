import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { fetchProfilePictureUrl } from '../evolution/client.js';
import { putAndVerify, whatsappMediaBucket, r2Configured } from '../integrations/r2.js';

/** Máximo de tentativas antes de o participante sair da fila (não queima orçamento pra sempre). */
const MAX_ATTEMPTS = 3;
/** Idade a partir da qual uma foto já baixada é re-verificada. */
const REFRESH_DAYS = 30;

/**
 * Key determinística POR TELEFONE — deliberadamente sem o group_id.
 *
 * A foto é da PESSOA, não da participação dela num grupo. A mesma pessoa da
 * equipe está em dezenas dos ~54 grupos; chavear por (grupo, telefone) geraria
 * uma busca na Evolution e um objeto no R2 por participação — com ~8 pessoas em
 * ~54 grupos, ~430 itens de fila para 8 fotos distintas, e o orçamento de 30 por
 * run seria consumido re-buscando as mesmas caras sem a fila nunca zerar.
 *
 * Consequência que o sweep implementa: a fila é deduplicada por telefone e uma
 * busca bem-sucedida grava a key em TODAS as linhas daquele telefone.
 */
export function avatarKey(phone: string): string {
  return `group-avatars/${phone.replace(/\D/g, '')}.jpg`;
}

/** I/O injetável — é o que torna o sweep testável sem Evolution nem R2. */
export type AvatarIo = {
  fetchUrl: (deps: EvolutionDeps, instance: string, phone: string) => Promise<string | null>;
  download: (url: string) => Promise<Buffer>;
  upload: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

const defaultIo: AvatarIo = {
  fetchUrl: (deps, instance, phone) => fetchProfilePictureUrl(deps, instance, phone),
  download: async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`avatar download ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  },
  upload: (key, body, contentType) => putAndVerify(key, body, contentType, whatsappMediaBucket()!),
};

/**
 * Sweep de fotos com ORÇAMENTO POR RUN. Um sweep sem teto satura o rate limit
 * da Evolution — foi o que aconteceu com os vídeos do Meta no BCD, e a correção
 * lá foi exatamente esta (orçamento + serial + ordem aleatória dentro da faixa).
 *
 * Fila POR `avatar_fetched_at`, deliberadamente — não por "sem avatar_key":
 *   - NULL            = nunca tentado          → prioridade
 *   - data + key      = tem foto               → volta só após REFRESH_DAYS
 *   - data + key NULA = sem foto CONFIRMADO    → volta só após REFRESH_DAYS
 * Um predicado por `avatar_key IS NULL` colocaria o terceiro caso de volta na
 * fila em todo run, queimando orçamento até estourar MAX_ATTEMPTS.
 */
export async function sweepGroupAvatars(
  pool: Pool,
  deps: EvolutionDeps,
  instance: string,
  budget: number,
  io: AvatarIo = defaultIo,
): Promise<{ attempted: number; stored: number; missing: number; failed: number }> {
  const out = { attempted: 0, stored: 0, missing: 0, failed: 0 };
  if (budget <= 0) return out;
  // Sem R2 configurado o upload falharia em toda tentativa e só queimaria
  // avatar_attempts até expulsar todo mundo da fila. Melhor não começar.
  if (!r2Configured()) return out;

  // DISTINCT por telefone: uma pessoa em 40 grupos custa UMA busca, não 40.
  // O orçamento passa a contar pessoas, que é o recurso escasso na Evolution.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (phone) phone
       FROM whatsapp_group_participants
      WHERE avatar_attempts < ${MAX_ATTEMPTS}
        AND (avatar_fetched_at IS NULL
             OR avatar_fetched_at < NOW() - INTERVAL '${REFRESH_DAYS} days')
      ORDER BY phone, (avatar_fetched_at IS NOT NULL), random()
      LIMIT $1`,
    [budget],
  );

  for (const r of rows) {
    out.attempted++;
    const phone = r.phone as string;
    try {
      const url = await io.fetchUrl(deps, instance, phone);
      if (!url) {
        // Sem foto pública é RESULTADO, não falha: carimba (para sair da fila até
        // o refresh) e zera attempts. Todas as linhas do telefone, não só uma.
        await pool.query(
          `UPDATE whatsapp_group_participants
              SET avatar_key = NULL, avatar_fetched_at = NOW(), avatar_attempts = 0
            WHERE phone = $1`,
          [phone],
        );
        out.missing++;
        continue;
      }
      const buf = await io.download(url);
      const key = avatarKey(phone);
      await io.upload(key, buf, 'image/jpeg');
      await pool.query(
        `UPDATE whatsapp_group_participants
            SET avatar_key = $2, avatar_fetched_at = NOW(), avatar_attempts = 0
          WHERE phone = $1`,
        [phone, key],
      );
      out.stored++;
    } catch {
      await pool.query(
        `UPDATE whatsapp_group_participants
            SET avatar_attempts = whatsapp_group_participants.avatar_attempts + 1
          WHERE phone = $1`,
        [phone],
      );
      out.failed++;
    }
  }
  return out;
}
