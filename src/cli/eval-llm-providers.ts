// ─────────────────────────────────────────────────────────────────────────────
// CLI: avaliação de provedores/modelos das tarefas de LLM de texto.
//
//   EVAL_DATABASE_URL=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
//     pnpm tsx src/cli/eval-llm-providers.ts --task=crm1|crm2|summary \
//       --models=openai:gpt-4o-mini,anthropic:claude-haiku-5-5 [--n=100] [--out=dir]
//
// SOMENTE LEITURA: monta o MESMO prompt da produção a partir do banco, chama cada
// modelo e grava as saídas em JSON para análise; nunca aplica decisão nem grava
// no banco. Usa a camada src/llm/ (o mesmo caminho do runtime).
//
// crm1 — amostra conversas já julgadas (≥3 workspaces) e CEGA a triagem (e a
//   qualificação, quando há opp aberta) antes de montar o prompt: o modelo decide
//   sem ver o valor atual. Compara com (a) o valor HUMANO quando a dimensão é
//   sticky e (b) o valor atual no banco nos demais casos.
// crm2 — análise semanal de padrões de N workspaces (semana anterior completa).
// summary — digest de N reuniões; cada número citado é procurado na transcrição.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createTextLlm } from '../llm/factory.js';
import { llmCost } from '../llm/pricing.js';
import { JUDGMENT_SCHEMA, PATTERN_SCHEMA, DIGEST_SCHEMA } from '../llm/schemas.js';
import type { LlmEffort, LlmProviderName, TextLlm } from '../llm/types.js';
import { buildJudgmentContext, type JudgmentContext } from '../whatsapp/ai-judgment-context.js';
import { buildJudgmentPrompt, parseJudgmentDecision } from '../whatsapp/ai-judgment-prompt.js';
import { buildPatternContext } from '../whatsapp/ai-pattern-context.js';
import { buildPatternPrompt, parsePatternDecision } from '../whatsapp/ai-pattern-prompt.js';
import { buildSummaryPrompt, parseDigest } from '../meetings-summary/prompt.js';

type Args = Record<string, string>;
function parseArgs(): Args {
  const a: Args = {};
  for (const s of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(s);
    if (m) a[m[1]!] = m[2]!;
  }
  return a;
}

type ModelSpec = { provider: LlmProviderName; model: string };
function parseModels(s: string): ModelSpec[] {
  return s.split(',').map((x) => {
    const [provider, model] = x.split(':');
    return { provider: provider as LlmProviderName, model: model! };
  });
}

async function pMap<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

type Call = { text: string; costUsd: number; latencyMs: number; inTok: number; outTok: number; finish: string | null; error?: string };
async function call(
  llm: TextLlm, system: string, user: string, schema: Record<string, unknown>, maxTokens: number, effort?: LlmEffort,
): Promise<Call> {
  const t0 = Date.now();
  try {
    const r = await llm.complete({
      system, messages: [{ role: 'user', content: user }], json: { schema }, maxTokens,
      effort: llm.provider === 'anthropic' ? effort : undefined, timeoutMs: 120_000,
    });
    return {
      text: r.text, costUsd: llmCost(llm.model, r.usage), latencyMs: Date.now() - t0,
      inTok: r.usage.input, outTok: r.usage.output, finish: r.finishReason,
    };
  } catch (err) {
    return { text: '', costUsd: 0, latencyMs: Date.now() - t0, inTok: 0, outTok: 0, finish: null, error: (err as Error).message };
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

// ── CRM nível 1 ──────────────────────────────────────────────────────────────
type Blind = { triageTruth: boolean | null; triageHuman: boolean; qualifyTruth: boolean | null; qualifyHuman: boolean };

function blind(ctx: JudgmentContext): Blind {
  const b: Blind = {
    triageTruth: ctx.triage.isLead, triageHuman: ctx.sticky.isLead,
    qualifyTruth: ctx.openOpp ? ctx.openOpp.isQualified : null, qualifyHuman: Boolean(ctx.openOpp && ctx.sticky.isQualified),
  };
  ctx.triage = { isLead: null, leadSource: null, notes: null };
  ctx.sticky.isLead = false;
  if (ctx.openOpp) {
    ctx.openOpp.isQualified = null;
    ctx.sticky.isQualified = false;
  }
  return b;
}

async function evalCrm1(pool: pg.Pool, llms: TextLlm[], n: number, effort: LlmEffort | undefined, outDir: string) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (j.whatsapp_number_id, j.identifier)
            j.whatsapp_number_id AS number_id, j.identifier, j.workspace_id
       FROM whatsapp_ai_judgments j
      WHERE j.decided_at > now() - interval '45 days'
      ORDER BY j.whatsapp_number_id, j.identifier, j.decided_at DESC`,
  );
  // Embaralha de forma determinística (seed fixa) para a amostra ser reprodutível.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const cands = rows.map((r) => ({ r, k: rnd() })).sort((a, b) => a.k - b.k).map((x) => x.r);

  const human: any[] = [];
  const other: any[] = [];
  const perWs = new Map<string, number>();
  const capWs = Math.ceil(n / 3); // ≥3 workspaces por construção
  for (const r of cands) {
    if (human.length >= n / 2 && other.length >= n / 2) break;
    if ((perWs.get(r.workspace_id) ?? 0) >= capWs) continue;
    const ctx = await buildJudgmentContext(pool, {
      numberId: Number(r.number_id), identifier: r.identifier, workspaceId: r.workspace_id, watermark: null,
    });
    if (ctx.lastMessageAt == null || ctx.messages.length === 0) continue;
    const bucket = ctx.sticky.isLead && ctx.triage.isLead != null ? human : other;
    if (bucket.length >= n / 2) continue;
    bucket.push(ctx);
    perWs.set(r.workspace_id, (perWs.get(r.workspace_id) ?? 0) + 1);
  }
  const sample: JudgmentContext[] = [...human, ...other];
  console.log(`crm1: amostra ${sample.length} (humano ${human.length}, demais ${other.length}), workspaces ${perWs.size}`);

  const now = new Date().toISOString();
  const items = sample.map((ctx) => {
    const truth = blind(ctx);
    const { system, user } = buildJudgmentPrompt(ctx, now);
    return { ctx, truth, system, user };
  });

  const results: any[] = items.map((it) => ({
    numberId: it.ctx.numberId, identifier: it.ctx.identifier, workspaceId: it.ctx.workspaceId, truth: it.truth, out: {} as Record<string, any>,
  }));
  for (const llm of llms) {
    await pMap(items, 4, async (it, i) => {
      const c = await call(llm, it.system, it.user, JUDGMENT_SCHEMA, 4000, effort);
      const p = c.error ? { ok: false, error: c.error } : parseJudgmentDecision(c.text, it.ctx);
      results[i].out[llm.model] = { ...c, parsed: p };
    });
    console.log(`crm1: ${llm.model} concluído`);
  }
  fs.writeFileSync(path.join(outDir, 'crm1.json'), JSON.stringify(results, null, 1));

  const base = llms[0]!.model;
  const rowsOut = llms.map((llm) => {
    const m = llm.model;
    let valid = 0, hTot = 0, hOk = 0, hAbst = 0, oTot = 0, oOk = 0, qTot = 0, qOk = 0, agree = 0, agreeTot = 0;
    const cost: number[] = [], lat: number[] = [];
    for (const r of results) {
      const o = r.out[m];
      cost.push(o.costUsd); lat.push(o.latencyMs);
      if (!o.parsed.ok) continue;
      valid++;
      const d = o.parsed.decision;
      const tri = d.triage === 'lead' ? true : d.triage === 'not_lead' ? false : null;
      if (r.truth.triageHuman) {
        hTot++;
        if (tri === null) hAbst++;
        else if (tri === r.truth.triageTruth) hOk++;
      } else if (r.truth.triageTruth != null && tri !== null) {
        oTot++;
        if (tri === r.truth.triageTruth) oOk++;
      }
      const q = d.openOpp?.qualify ?? null;
      if (r.truth.qualifyHuman && r.truth.qualifyTruth != null && q !== null) {
        qTot++;
        if (q === r.truth.qualifyTruth) qOk++;
      }
      const b = r.out[base];
      if (m !== base && b?.parsed?.ok) {
        agreeTot++;
        if (b.parsed.decision.triage === d.triage) agree++;
      }
    }
    const tot = cost.reduce((a, b) => a + b, 0);
    return {
      modelo: m,
      json_valido: `${valid}/${results.length}`,
      triagem_vs_humano: `${hOk}/${hTot - hAbst} (abst ${hAbst})`,
      triagem_vs_atual: `${oOk}/${oTot}`,
      qualify_vs_humano: `${qOk}/${qTot}`,
      triagem_igual_base: m === base ? '—' : `${agree}/${agreeTot}`,
      usd_por_conv: (tot / results.length).toFixed(5),
      lat_p50_ms: median(lat),
    };
  });
  console.table(rowsOut);
  fs.writeFileSync(path.join(outDir, 'crm1-summary.json'), JSON.stringify(rowsOut, null, 1));
}

// ── CRM nível 2 ──────────────────────────────────────────────────────────────
async function evalCrm2(pool: pg.Pool, llms: TextLlm[], n: number, effort: LlmEffort | undefined, outDir: string) {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7; // segunda=0
  const thisMonday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const prevMonday = new Date(thisMonday.getTime() - 7 * 86400_000);
  const prevSunday = new Date(thisMonday.getTime() - 86400_000);
  const periodStart = prevMonday.toISOString().slice(0, 10);
  const periodEnd = prevSunday.toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT workspace_id, count(*)::int n FROM whatsapp_ai_judgments
      WHERE decided_at::date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC LIMIT $3`,
    [periodStart, periodEnd, n],
  );
  const out: any[] = [];
  for (const r of rows) {
    const ctx = await buildPatternContext(pool, { workspaceId: r.workspace_id, periodStart, periodEnd });
    const { system, user } = buildPatternPrompt(ctx, new Date().toISOString());
    const rec: any = { workspaceId: r.workspace_id, judgments: ctx.judgments.length, out: {} };
    for (const llm of llms) {
      const c = await call(llm, system, user, PATTERN_SCHEMA, 16000, effort);
      const p = c.error ? { ok: false, error: c.error } : parsePatternDecision(c.text, ctx);
      rec.out[llm.model] = { ...c, parsed: p };
      const dd = (p as any).decision;
      console.log(
        `crm2 ${r.workspace_id} ${llm.model}: ok=${p.ok} usd=${c.costUsd.toFixed(4)} lat=${c.latencyMs}ms` +
          (dd ? ` tags=${dd.tagSuggestions.length} motivos=${dd.newLossReasons.length} guidance=${dd.guidanceSuggestions?.length ?? 0} backfill=${dd.backfillLossReasons?.length ?? 0}` : ` erro=${(p as any).error}`),
      );
    }
    out.push(rec);
  }
  fs.writeFileSync(path.join(outDir, 'crm2.json'), JSON.stringify(out, null, 1));
}

// ── Digest de reunião ────────────────────────────────────────────────────────
const NUM_RE = /\d+(?:[.,]\d+)*/g;
function normNum(s: string): string {
  return s.replace(/[.,]/g, '');
}
/** Números citados no digest que NÃO aparecem na transcrição enviada ao modelo. */
export function unsupportedNumbers(digestText: string, transcript: string): string[] {
  const hay = new Set((transcript.match(NUM_RE) ?? []).map(normNum));
  // Também aceita números por extenso? Não — conferência estrita por dígitos; o
  // relatório lista os casos para leitura humana.
  return [...new Set((digestText.match(NUM_RE) ?? []).filter((x) => !hay.has(normNum(x))))];
}

async function evalSummary(pool: pg.Pool, llms: TextLlm[], n: number, effort: LlmEffort | undefined, outDir: string) {
  const { rows } = await pool.query(
    `SELECT e.id FROM episodes e
      WHERE e.fonte = 'reuniao' AND e.summary IS NOT NULL
        AND (SELECT count(*) FROM episode_turns t WHERE t.episode_id = e.id) >= 20
      ORDER BY e.id DESC LIMIT $1`,
    [n],
  );
  const out: any[] = [];
  for (const r of rows) {
    const ep = await pool.query(`SELECT id, title, duration_seconds, participants FROM episodes WHERE id = $1`, [r.id]);
    const turns = await pool.query(
      `SELECT speaker_name, text FROM episode_turns WHERE episode_id = $1 ORDER BY turn_index ASC`, [r.id],
    );
    const e = ep.rows[0];
    const { system, user } = buildSummaryPrompt({
      title: e.title, durationSeconds: e.duration_seconds,
      participants: Array.isArray(e.participants) ? e.participants : [],
      turns: turns.rows.map((t: any) => ({ speaker: t.speaker_name, text: String(t.text ?? '') })),
    });
    const rec: any = { episodeId: Number(r.id), title: e.title, out: {} };
    await pMap(llms, llms.length, async (llm) => {
      const c = await call(llm, system, user, DIGEST_SCHEMA, 4000, effort);
      const p = c.error ? null : parseDigest(c.text);
      const digestText = p ? JSON.stringify(p.digest) : '';
      rec.out[llm.model] = { ...c, outcome: p?.outcome ?? 'error', digest: p?.digest, unsupportedNumbers: unsupportedNumbers(digestText, user) };
    });
    rec.prompt = { system, user };
    out.push(rec);
    console.log(
      `summary ep ${r.id}: ` +
        llms.map((l) => `${l.model}=${rec.out[l.model].outcome} nums_fora=${rec.out[l.model].unsupportedNumbers.join('|') || '0'}`).join('  '),
    );
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(out, null, 1));
  const table = llms.map((l) => {
    const xs = out.map((o) => o.out[l.model]);
    return {
      modelo: l.model,
      ok: xs.filter((x) => x.outcome === 'ok').length + `/${xs.length}`,
      reunioes_com_numero_fora: xs.filter((x) => x.unsupportedNumbers.length > 0).length,
      usd_medio: (xs.reduce((a, x) => a + x.costUsd, 0) / xs.length).toFixed(5),
      lat_p50_ms: median(xs.map((x) => x.latencyMs)),
      out_tok_medio: Math.round(xs.reduce((a, x) => a + x.outTok, 0) / xs.length),
    };
  });
  console.table(table);
}

async function main() {
  const a = parseArgs();
  const task = a.task;
  const db = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!task || !db || !a.models) {
    console.error('uso: --task=crm1|crm2|summary --models=prov:modelo,... [--n=] [--effort=] (EVAL_DATABASE_URL)');
    process.exit(2);
  }
  const keys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  const llms = parseModels(a.models).map((m) => createTextLlm(`eval:${task}`, m.provider, m.model, keys));
  const effort = (a.effort as LlmEffort | undefined) ?? 'low';
  const outDir = a.out ?? '.';
  fs.mkdirSync(outDir, { recursive: true });
  const pool = new pg.Pool({ connectionString: db, max: 6 });
  try {
    if (task === 'crm1') await evalCrm1(pool, llms, Number(a.n ?? 100), effort, outDir);
    else if (task === 'crm2') await evalCrm2(pool, llms, Number(a.n ?? 2), effort, outDir);
    else if (task === 'summary') await evalSummary(pool, llms, Number(a.n ?? 20), a.effort as LlmEffort | undefined, outDir);
    else throw new Error(`task desconhecida: ${task}`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('eval-llm-providers.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
