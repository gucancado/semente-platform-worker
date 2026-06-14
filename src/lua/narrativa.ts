// Narradora minima da Lua: status descritivo do projeto + recap semanal.
//
// Duas funcoes de sintese com proposito e TOM diferentes (spec §10):
//  - generateStatus (§10.2): "onde o projeto esta agora". Informacao de painel —
//    objetivo, descritivo, SEM voz narrativa. Insumo: fatos VIGENTES priorizados
//    por tipo, excluindo needs_review (status nao publica suspeita).
//  - generateRecap (§10.1): "como foi a semana". Narradora com style guide do
//    Norte §5 — sutil, gentil, cotidiano, micro-politico, NUNCA epico corporativo;
//    fecha com pendencias vivas. Idempotente por semana (UNIQUE workspace+semana):
//    re-rodar nao chama o LLM de novo nem reescreve.
//
// O LlmClient vem injetado (src/lua/llm.ts) — testes usam fakes sem rede; em prod
// ambos usam getRecapClient() (Sonnet, mesma familia — spec §10.2).

import type { LlmClient } from './llm.js';
import {
  getVigenteFactsForStatus,
  insertProjectStatus,
  getRecapByWeek,
  insertRecap,
  getWeekActivity,
  getWeekFacts,
} from './db.js';

export interface NarrativaDeps {
  llm: LlmClient;
  runId?: number;
}

// ── Status do projeto (§10.2) ────────────────────────────────────────────────

const STATUS_SYSTEM_PROMPT = `Voce produz o STATUS DESCRITIVO de um projeto da BeeAds — uma
ficha curta que diz ONDE O PROJETO ESTA AGORA, lida na visao geral de um painel.

Tom e forma:
- 3 a 6 frases, em PT-BR.
- OBJETIVO e DESCRITIVO. Isto NAO e uma narrativa: SEM voz narrativa, sem contar uma
  historia, sem adjetivos decorativos, sem floreio. Informacao factual de painel.
- Use APENAS os fatos fornecidos abaixo (cada um vigente e confiavel). Nao invente,
  nao especule, nao acrescente contexto que nao esteja nos fatos.
- Priorize: objetivos e decisoes/parametros atuais -> compromissos em aberto (com prazo)
  -> ameacas/oportunidades vigentes -> marcos recentes -> quem responde pelo que.

Responda chamando a ferramenta de saida com { content_md: string } — apenas o texto do status.`;

const STATUS_SCHEMA = {
  type: 'object',
  properties: { content_md: { type: 'string' } },
  required: ['content_md'],
} as const;

function renderStatusUser(facts: { fact_type: string; statement: string; attributes: Record<string, unknown> }[]): string {
  const lines = facts.map((f) => {
    const attrs = Object.keys(f.attributes ?? {}).length
      ? ` (${JSON.stringify(f.attributes)})`
      : '';
    return `- [${f.fact_type}] ${f.statement}${attrs}`;
  });
  return `## Fatos vigentes do projeto (em ordem de prioridade)\n${lines.join('\n')}`;
}

/**
 * Regenera o status descritivo de um workspace (spec §10.2). Carrega os fatos
 * vigentes nao-flagados (priorizados por tipo no db), sintetiza via LLM (3-6
 * frases descritivas, sem voz narrativa) e faz append em project_status +
 * fontes. Workspace sem fato vigente publicavel => retorna null SEM chamar o LLM
 * (a Central mostra vazio honesto, nunca placeholder inventado).
 */
export async function generateStatus(
  workspaceId: string,
  deps: NarrativaDeps
): Promise<number | null> {
  const facts = await getVigenteFactsForStatus(workspaceId);
  if (facts.length === 0) return null;

  const { content_md } = await deps.llm.complete<{ content_md: string }>({
    system: STATUS_SYSTEM_PROMPT,
    user: renderStatusUser(facts),
    schema: STATUS_SCHEMA as unknown as object,
  });

  return insertProjectStatus({
    workspaceId,
    contentMd: content_md,
    model: deps.llm.model,
    runId: deps.runId ?? null,
    factIds: facts.map((f) => f.id),
  });
}

// ── Recap semanal (§10.1) ────────────────────────────────────────────────────

const RECAP_SYSTEM_PROMPT = `Voce e a narradora da Lua, a memoria do ecossistema BeeAds. Escreva
o RECAP da semana de um projeto — para a equipe interna (tatica), nunca para o cliente.

Tom e forma (style guide do Norte §5):
- 4 a 8 frases, em PT-BR.
- Sutil, gentil, cotidiano, micro-politico. NUNCA epico corporativo, nunca grandiloquente.
- Cite decisoes e viradas concretas com leveza ("a verba dobrou; a aposta agora e Reels").
- Feche com as pendencias vivas (compromissos em aberto, prazos que se aproximam).
- Use apenas o que esta nos insumos abaixo. Nao invente.

Responda chamando a ferramenta de saida com { content_md: string } — apenas o texto do recap.`;

const RECAP_SCHEMA = {
  type: 'object',
  properties: { content_md: { type: 'string' } },
  required: ['content_md'],
} as const;

function renderRecapUser(
  period: { start: string; end: string },
  episodes: { title: string | null }[],
  facts: { statement: string; fact_type: string; status: 'novo' | 'invalidado' }[]
): string {
  const epLines = episodes.length
    ? episodes.map((e) => `- ${e.title ?? '(sem titulo)'}`).join('\n')
    : '- (nenhum episodio nesta semana)';
  const factLines = facts.length
    ? facts.map((f) => `- [${f.fact_type}/${f.status}] ${f.statement}`).join('\n')
    : '- (nenhum fato novo ou invalidado)';
  return [
    `## Semana ${period.start} a ${period.end}`,
    '',
    '## Episodios da semana (titulos)',
    epLines,
    '',
    '## Fatos novos / supersedidos na semana',
    factLines,
  ].join('\n');
}

/**
 * Gera o recap semanal de um workspace (spec §10.1). Gate de atividade: so gera
 * para workspaces com >=1 episodio na semana OU >=1 fato novo/invalidado no
 * periodo; sem atividade => null (sem ruido). Idempotente por semana (UNIQUE
 * workspace+period_start): se o recap ja existe, devolve o id existente SEM
 * chamar o LLM de novo e SEM reescrever (regenerar exige delete admin).
 */
export async function generateRecap(
  workspaceId: string,
  period: { start: string; end: string },
  deps: NarrativaDeps
): Promise<number | null> {
  // Idempotencia primeiro: se ja existe, nem chega a chamar o LLM.
  const existing = await getRecapByWeek(workspaceId, period.start);
  if (existing) return existing.id;

  const activity = await getWeekActivity(workspaceId, period.start, period.end);
  if (activity.episodes.length === 0 && activity.factsChanged === 0) return null;

  const weekFacts = await getWeekFacts(workspaceId, period.start, period.end);

  const { content_md } = await deps.llm.complete<{ content_md: string }>({
    system: RECAP_SYSTEM_PROMPT,
    user: renderRecapUser(period, activity.episodes, weekFacts),
    schema: RECAP_SCHEMA as unknown as object,
  });

  const { id } = await insertRecap({
    workspaceId,
    periodStart: period.start,
    periodEnd: period.end,
    contentMd: content_md,
    model: deps.llm.model,
    runId: deps.runId ?? null,
    episodeIds: activity.episodes.map((e) => e.id),
  });
  return id;
}

// ── Resolucao de periodo ISO-week (get_recap, §8.4) ──────────────────────────

/**
 * Converte 'YYYY-Www' (semana ISO) para a janela [segunda, domingo] (datas
 * YYYY-MM-DD em UTC). ISO-8601: a semana 1 e a que contem a primeira quinta-feira
 * do ano; semana comeca na segunda.
 */
export function isoWeekToPeriod(week: string): { start: string; end: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error('semana ISO invalida (esperado YYYY-Www)');
  const year = Number(m[1]);
  const wk = Number(m[2]);
  if (wk < 1 || wk > 53) throw new Error('semana ISO fora do intervalo 01-53');
  // Quinta-feira da semana 1 = a quinta mais proxima de 4 de janeiro.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay(); // 1=seg..7=dom
  // Segunda da semana 1.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  // Segunda da semana pedida.
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (wk - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(monday), end: iso(sunday) };
}

/**
 * Resolve o period_start (segunda) a partir das opcoes de get_recap (§8.4):
 *  - week='YYYY-Www' -> segunda dessa semana ISO;
 *  - start='YYYY-MM-DD' -> usado direto (assume-se segunda);
 *  - nenhum -> semana ISO ANTERIOR a hoje (default).
 */
export function resolveRecapPeriodStart(opts: { week?: string; start?: string }): string {
  if (opts.start) return opts.start;
  if (opts.week) return isoWeekToPeriod(opts.week).start;
  // Default: semana anterior. Segunda desta semana, menos 7 dias.
  const now = new Date();
  const dow = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  thisMonday.setUTCDate(thisMonday.getUTCDate() - (dow - 1));
  const prevMonday = new Date(thisMonday);
  prevMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  return prevMonday.toISOString().slice(0, 10);
}
