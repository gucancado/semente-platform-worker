/**
 * src/cli/summarize-meetings.ts
 *
 * Backfill do digest de reunião. Enfileira episódios e drena a fila com o MESMO
 * `processSummaryJob` do poller — sem política paralela de retry, custo ou
 * validação. Se o backfill e o cron divergirem em comportamento, é bug.
 *
 * Uso:
 *   pnpm meetings:summarize -- --dry-run
 *   pnpm meetings:summarize -- --episode=453
 *   pnpm meetings:summarize -- --limit=50
 *   pnpm meetings:summarize -- --limit=300 --redo
 */
import { config } from '../config.js';
import { pool } from '../db.js';
import { OpenAISummaryLlm } from '../meetings-summary/provider.js';
import { runSummaryBatch } from '../meetings-summary/poller.js';
import {
  enqueuePendingEpisodes, enqueueOneEpisode, countPendingSummaryJobs,
} from '../meetings-summary/db.js';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

const log = {
  info: (o: unknown, m?: string) => console.log(m ?? '', JSON.stringify(o)),
  warn: (o: unknown, m?: string) => console.warn(m ?? '', JSON.stringify(o)),
};

async function main(): Promise<void> {
  const dryRun = flag('dry-run') !== undefined;
  const redo = flag('redo') !== undefined;
  const episode = flag('episode');
  const limit = Number(flag('limit') ?? '25');

  if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ausente');
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit inválido');

  let enqueued = 0;
  if (episode) {
    const id = Number(episode);
    if (!Number.isFinite(id)) throw new Error('--episode inválido');
    if (dryRun) {
      console.log(`[dry-run] enfileiraria o episódio ${id}`);
      return;
    }
    enqueued = (await enqueueOneEpisode(id)) ? 1 : 0;
    if (enqueued === 0) console.log(`episódio ${id} não existe, não é reunião ou não tem turnos`);
  } else {
    if (dryRun) {
      // Conta sem escrever: mesma condição do INSERT ... SELECT do enqueue.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM episodes
          WHERE fonte='reuniao' AND turn_count > 0 AND ($1::bool OR summary IS NULL)`,
        [redo],
      );
      console.log(`[dry-run] ${rows[0].n} episódio(s) elegíveis; enfileiraria até ${limit}`);
      return;
    }
    enqueued = await enqueuePendingEpisodes({ limit, redo });
  }
  console.log(`enfileirados: ${enqueued}`);
  if (enqueued === 0) return;

  const llm = new OpenAISummaryLlm({ apiKey: config.OPENAI_API_KEY, model: config.MEETING_SUMMARY_MODEL });
  let processed = 0;
  // Drena em lotes até a fila esvaziar. Serial (o batch do poller já é), então
  // não há rajada contra a API — o que importa numa chave compartilhada com a
  // Vexa, o áudio do WhatsApp e a IA do CRM.
  for (;;) {
    const n = await runSummaryBatch({ llm, log });
    if (n === 0) break;
    processed += n;
    console.log(`  processados ${processed}…`);
  }
  console.log(`concluído: ${processed} processado(s); ${await countPendingSummaryJobs()} ainda pendente(s)`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
