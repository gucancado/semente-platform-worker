import { config } from '../config.js';
import { insertEpisodeWithTurns } from '../episodes/db.js';
import { resolveAttribution, resolveByTitle, loadDomainRules, loadTitleRules, DEFAULT_FREEMAIL } from '../episodes/attribution.js';
import { transcriptToEpisodeInput, type FirefliesTranscript } from '../integrations/fireflies/normalize.js';
import { FirefliesClient } from '../integrations/fireflies/client.js';
import { r2Configured, putAndVerify } from '../integrations/r2.js';

export type ImportReport = {
  total_seen: number; imported: number; duplicates: number; forced: number;
  skipped_empty: number; failed: Array<{ id: string; error: string }>;
  by_method: Record<string, number>;
  orphans: Array<{ id: string; title: string | null; participants: string[] }>;
  unresolved_domains: Record<string, number>;
  no_audio: number;
};

export async function runImport(
  source: AsyncIterable<FirefliesTranscript>,
  opts: { dryRun: boolean; force?: boolean; internalWorkspaceId?: string }
): Promise<ImportReport> {
  const rules = await loadDomainRules();
  const titleRules = await loadTitleRules();
  const freemail = [...DEFAULT_FREEMAIL, ...config.FREEMAIL_DOMAINS_EXTRA];
  const report: ImportReport = {
    total_seen: 0, imported: 0, duplicates: 0, forced: 0, skipped_empty: 0,
    failed: [], by_method: {}, orphans: [], unresolved_domains: {}, no_audio: 0,
  };

  for await (const t of source) {
    report.total_seen++;
    if (!t.sentences?.length) { report.skipped_empty++; continue; }
    try {
      const rawKey = `fireflies/${t.id}.json`;
      const input = transcriptToEpisodeInput(t, rawKey);
      let attr = resolveAttribution(
        input.participants ?? [], rules,
        { internalDomains: config.INTERNAL_DOMAINS, freemailDomains: freemail, internalWorkspaceId: opts.internalWorkspaceId }
      );
      // Título é mais específico que 'internal' (reunião "Cliente + BeeAds" só com
      // participantes beeads NÃO é interna — é do cliente). Só o 'domain' (e-mail de
      // cliente presente) vence o título. Precedência: domain > title > internal > none.
      if (attr.method !== 'domain') {
        const byTitle = resolveByTitle(t.title, titleRules);
        if (byTitle.workspace_id) attr = { ...byTitle, unresolved_domains: attr.unresolved_domains };
      }
      input.workspace_id = attr.workspace_id;
      input.project_slug = attr.project_slug;
      input.attribution_method = attr.method;
      (input.metadata as Record<string, unknown>).unresolved_domains = attr.unresolved_domains;
      for (const d of attr.unresolved_domains) report.unresolved_domains[d] = (report.unresolved_domains[d] ?? 0) + 1;
      report.by_method[attr.method] = (report.by_method[attr.method] ?? 0) + 1;
      if (attr.method === 'none') report.orphans.push({ id: t.id, title: t.title, participants: (t.participants ?? []) });

      if (opts.dryRun) continue;

      // R2 primeiro, TX depois (spec §7.6). Sem R2 configurado: raw_r2_key=null + aviso no relatório.
      if (r2Configured()) {
        await putAndVerify(rawKey, JSON.stringify(t), 'application/json');
        if (t.audio_url) {
          try {
            const audio = await fetch(t.audio_url, { signal: AbortSignal.timeout(120_000) });
            if (audio.ok) {
              await putAndVerify(`fireflies/${t.id}.mp3`, Buffer.from(await audio.arrayBuffer()), 'audio/mpeg');
              input.audio_r2_key = `fireflies/${t.id}.mp3`;
            } else report.no_audio++;
          } catch { report.no_audio++; }
        } else report.no_audio++;
      } else {
        input.raw_r2_key = null;
        report.no_audio++;
      }

      const r = await insertEpisodeWithTurns({ ...input, force: opts.force });
      if (r.duplicate && !opts.force) report.duplicates++;
      else if (r.duplicate && opts.force) report.forced++;
      else report.imported++;
    } catch (err) {
      report.failed.push({ id: t.id, error: (err as Error).message });
    }
  }
  return report;
}

// ── execução direta: pnpm import:fireflies [--dry-run] [--force] [--since=YYYY-MM-DD] ──
const isMain = process.argv[1]?.endsWith('import-fireflies.ts') || process.argv[1]?.endsWith('import-fireflies.js');
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const since = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  if (!config.FIREFLIES_API_KEY) { console.error('FIREFLIES_API_KEY não configurada'); process.exit(1); }
  const client = new FirefliesClient(config.FIREFLIES_API_KEY);
  if (args.has('--check')) {
    client.ping().then(({ status, body }) => {
      console.log(`HTTP ${status}`);
      console.log(body);
      process.exit(status === 200 ? 0 : 1);
    });
  } else
  runImport(client.iterateAll({ fromDate: since ? new Date(since).toISOString() : undefined }), {
    dryRun: args.has('--dry-run'), force: args.has('--force'), internalWorkspaceId: config.INTERNAL_WORKSPACE_ID,
  }).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    console.log(`\n${report.imported} importados · ${report.duplicates} duplicatas · ${report.skipped_empty} vazios · ${report.orphans.length} sem projeto · ${report.failed.length} falhas`);
    process.exit(report.failed.length ? 2 : 0);
  }).catch((err) => { console.error(err); process.exit(1); });
}
