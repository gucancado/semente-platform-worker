/**
 * src/cli/strip-meeting-hallucinations.ts
 *
 * Tira do HISTÓRICO de reuniões do Vexa as frases que o Whisper inventa em
 * trecho sem fala ("Tchau, tchau", "Legendas pela comunidade Amara.org"…). A
 * importação nova já descarta na entrada (`vexaMeetingToEpisodeInput`); aqui é
 * o mesmo critério (`stripStockPhrases`) aplicado às falas já gravadas.
 *
 * - Fala que fica vazia é apagada; `turn_index` não é renumerado (leitores
 *   ordenam por ele, buraco não importa).
 * - Participante que perde todas as falas sai de `participants` e de
 *   `metadata.speaker_counts` (é o "Speaker" genérico, que só falava frase inventada).
 * - Cópia de segurança antes de mexer: `_bkp_episode_turns_hallucinations` e
 *   `_bkp_episodes_hallucinations` (só as linhas tocadas). Reverter = restaurar dali.
 * - O digest não muda: o prompt dele já ignorava essas frases.
 *
 * `--source=fireflies`: só créditos de legenda e encerramento de vídeo (`stripJunk`).
 *   Lá "Tchau, tchau." é despedida real, e `participants` são os CONVIDADOS (não os
 *   falantes), então a lista de participantes não é tocada.
 *
 * Uso (no container):
 *   node dist/cli/strip-meeting-hallucinations.js            # simulação
 *   node dist/cli/strip-meeting-hallucinations.js --apply
 *   node dist/cli/strip-meeting-hallucinations.js --apply --episode=519
 */
import { pool } from '../db.js';
import { stripStockPhrases, stripJunk } from '../integrations/vexa/stock-phrases.js';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

type Turn = { id: string; speaker_name: string | null; text: string };

async function main(): Promise<void> {
  const apply = flag('apply') !== undefined;
  const only = flag('episode');
  const source = flag('source') || 'vexa';
  if (source !== 'vexa' && source !== 'fireflies') throw new Error('--source=vexa|fireflies');
  const clean = source === 'vexa' ? stripStockPhrases : stripJunk;

  const eps = await pool.query<{ id: string }>(
    `SELECT id FROM episodes WHERE external_source = $1 ${only ? 'AND id = $2' : ''} ORDER BY id`,
    only ? [source, only] : [source],
  );

  if (apply) {
    await pool.query(`CREATE TABLE IF NOT EXISTS _bkp_episode_turns_hallucinations AS SELECT * FROM episode_turns WITH NO DATA`);
    await pool.query(`CREATE TABLE IF NOT EXISTS _bkp_episodes_hallucinations AS
      SELECT id, participants, metadata FROM episodes WITH NO DATA`);
  }

  let touchedEpisodes = 0, changed = 0, deleted = 0, charsBefore = 0, charsAfter = 0;
  for (const { id } of eps.rows) {
    const turns = (await pool.query<Turn>(
      `SELECT id, speaker_name, text FROM episode_turns WHERE episode_id = $1 ORDER BY turn_index`, [id],
    )).rows;
    const plan = turns.map((t) => ({ ...t, next: clean(t.text) })).filter((t) => t.next !== t.text);
    if (!plan.length) continue;
    touchedEpisodes++;
    for (const t of plan) {
      charsBefore += t.text.length; charsAfter += t.next.length;
      if (t.next) changed++; else deleted++;
    }
    if (!apply) continue;

    const removedIds = new Set(plan.filter((t) => !t.next).map((t) => t.id));
    const before = new Set(turns.map((t) => t.speaker_name).filter(Boolean) as string[]);
    const after = new Set(turns.filter((t) => !removedIds.has(t.id)).map((t) => t.speaker_name).filter(Boolean) as string[]);
    const gone = source === 'vexa' ? [...before].filter((n) => !after.has(n)) : [];

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO _bkp_episode_turns_hallucinations SELECT * FROM episode_turns WHERE id = ANY($1::bigint[])`,
        [plan.map((t) => t.id)]);
      for (const t of plan) {
        if (t.next) await c.query(`UPDATE episode_turns SET text = $2 WHERE id = $1`, [t.id, t.next]);
        else await c.query(`DELETE FROM episode_turns WHERE id = $1`, [t.id]);
      }
      if (gone.length) {
        await c.query(`INSERT INTO _bkp_episodes_hallucinations SELECT id, participants, metadata FROM episodes WHERE id = $1`, [id]);
        await c.query(
          `UPDATE episodes SET
             participants = (SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(coalesce(participants, '[]'::jsonb)) p
                             WHERE NOT (p->>'name' = ANY($2::text[]))),
             metadata = CASE WHEN metadata ? 'speaker_counts'
                             THEN jsonb_set(metadata, '{speaker_counts}', (metadata->'speaker_counts') - $2::text[])
                             ELSE metadata END
           WHERE id = $1`,
          [id, gone],
        );
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run', source, episodes: eps.rows.length, touchedEpisodes,
    turnsChanged: changed, turnsDeleted: deleted, charsRemoved: charsBefore - charsAfter,
  }));
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
