/**
 * src/whatsapp/media-retention.ts
 *
 * Expiração por idade dos arquivos de WhatsApp (mídia e áudio) no R2.
 *
 * CONSTRUÍDA E DESLIGADA. Por decisão do owner (2026-09-16), a expiração de 180
 * dias só é ligada — e a primeira limpeza só roda — com aprovação explícita dele,
 * quando o uso passar de 70% do orçamento (ver src/cli/whatsapp-media-usage.ts).
 * Com WHATSAPP_MEDIA_RETENTION_DAYS=0 nada aqui executa.
 *
 * Age no ARQUIVO, nunca na mensagem: a linha, o marcador e a transcrição ficam; só
 * `media_key` volta a NULL e `media_status` vira `expired`. A conversa não perde
 * nenhuma bolha.
 *
 * Dirigida pelo BANCO, não por listagem do bucket nem por regra de ciclo de vida
 * do R2: uma regra no bucket apagaria o objeto e deixaria `media_key` apontando
 * pro nada — o painel mostraria imagem quebrada em vez de "arquivo expirado".
 */
import type { Pool } from 'pg';
import { retentionEnabled } from './media-policy.js';

export type RetentionIo = { deleteObject: (key: string) => Promise<void> };

export type RetentionResult = { selected: number; expired: number; failed: number };

export async function sweepExpiredMedia(
  pool: Pick<Pool, 'query'>,
  io: RetentionIo,
  p: { days: number; budget: number; dryRun?: boolean },
): Promise<RetentionResult> {
  const out: RetentionResult = { selected: 0, expired: 0, failed: 0 };
  // Guarda repetida aqui (e não só no boot) porque o CLI também chama esta função.
  if (!retentionEnabled(p.days) || p.budget <= 0) return out;

  const { rows } = await pool.query<{ id: number; media_key: string }>(
    `SELECT id, media_key FROM messages
      WHERE media_key IS NOT NULL
        AND created_at < NOW() - make_interval(days => $1)
      ORDER BY created_at ASC
      LIMIT $2`,
    [p.days, p.budget],
  );
  out.selected = rows.length;
  if (p.dryRun) return out;

  for (const r of rows) {
    try {
      // Apaga o objeto ANTES de soltar a referência. Na ordem inversa, uma falha
      // do delete deixaria um objeto que nenhuma linha aponta — órfão pra sempre.
      // Nesta ordem a pior falha é a linha apontar pra um objeto já apagado, e a
      // próxima varredura conserta (delete de key inexistente é sucesso no R2).
      await io.deleteObject(r.media_key);
      // Casa a key: se o arquivo foi regravado no meio-tempo, não solta a referência nova.
      const u = await pool.query(
        `UPDATE messages SET media_key = NULL, media_status = 'expired' WHERE id = $1 AND media_key = $2`,
        [r.id, r.media_key],
      );
      if (u.rowCount) out.expired += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
