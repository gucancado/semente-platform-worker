/**
 * src/weekly-context/core.ts
 *
 * Parte PURA do resumo semanal de contexto (sem banco nem rede): qual semana está
 * "vencida", o prompt e a limpeza do texto. Testada em tests/weekly-context.
 *
 * O resumo é lido em segundos no topo da Visão Geral do painel, na reunião
 * tática interna. Ele cruza o que foi dito (grupo de WhatsApp e reuniões) com as
 * tarefas do Bloquim (abertas e concluídas): o painel já mostra saldo, métricas,
 * a lista de tarefas e a próxima reunião, e repetir isso no texto é ruído — o
 * prompt proíbe; tarefa só entra no texto quando cruza com algo dito.
 */

const SP = 'America/Sao_Paulo';

/** Dia civil (YYYY-MM-DD), dia da semana (0 = domingo) e hora em São Paulo. */
export function saoPauloParts(now: Date): { day: string; dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SP, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: `${get('year')}-${get('month')}-${get('day')}`, dow: dowMap[get('weekday')] ?? 0, hour: Number(get('hour')) };
}

export function addDays(dayIso: string, n: number): string {
  const [y = 0, m = 1, d = 1] = dayIso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Segunda-feira nesta hora (SP) o resumo da semana é gerado. */
export const MONDAY_GENERATION_HOUR = 6;

/**
 * Segunda-feira (dia SP) da semana cujo resumo deve existir agora. A partir de
 * segunda 6h é a semana corrente; antes disso (segunda de madrugada) ainda é a
 * semana anterior — o resumo novo nasce às 6h de segunda, antes da tática.
 */
export function dueWeekStart(now: Date): string {
  const { day, dow, hour } = saoPauloParts(now);
  const monday = addDays(day, -((dow + 6) % 7));
  if (dow === 1 && hour < MONDAY_GENERATION_HOUR) return addDays(monday, -7);
  return monday;
}

export type ContextMessage = { at: string; role: 'BeeAds' | 'cliente'; text: string };
export type ContextMeeting = {
  title: string | null;
  at: string;
  summary: string | null;
  points: unknown;
  decisions: unknown;
  actions: unknown;
  openQuestions: unknown;
};

export type ContextTask = {
  title: string;
  status: string;
  overdue: boolean;
  dueDate: string | null;
  completedAt: string | null;
  assigneeName: string | null;
};

export type ContextInput = {
  clientName: string;
  today: string; // dd/mm/aaaa
  messages: ContextMessage[];
  meetings: ContextMeeting[];
  /** null = o Bloquim não respondeu (o prompt diz que as tarefas estão indisponíveis). */
  openTasks?: ContextTask[] | null;
  completedTasks?: ContextTask[] | null;
};

/** Janela de leitura: o foco é a última semana; o resto é contexto. */
export const MESSAGES_WINDOW_DAYS = 14;
export const MEETINGS_WINDOW_DAYS = 21;
export const COMPLETED_TASKS_WINDOW_DAYS = 14;

/** "2026-11-27T15:00:00Z" → "27/11" no dia de São Paulo; null se inválido. */
export function dayMonthSp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const [, m, day] = saoPauloParts(d).day.split('-');
  return `${day}/${m}`;
}

const STATUS_PT: Record<string, string> = {
  pending: 'aguardando', in_progress: 'em andamento', blocked: 'bloqueada', overdue: 'atrasada', completed: 'concluída',
};

export function formatOpenTask(t: ContextTask): string {
  const bits = [t.overdue || t.status === 'overdue' ? 'ATRASADA' : (STATUS_PT[t.status] ?? t.status)];
  const due = dayMonthSp(t.dueDate);
  if (due) bits.push(`prazo ${due}`);
  if (t.assigneeName) bits.push(t.assigneeName);
  return `- ${t.title} (${bits.join(', ')})`;
}

export function formatCompletedTask(t: ContextTask): string {
  const bits: string[] = [];
  const at = dayMonthSp(t.completedAt);
  if (at) bits.push(`concluída ${at}`);
  if (t.assigneeName) bits.push(t.assigneeName);
  return bits.length ? `- ${t.title} (${bits.join(', ')})` : `- ${t.title}`;
}

export const WEEKLY_CONTEXT_SYSTEM = `Você escreve o resumo semanal de um cliente da agência BeeAds para a reunião tática interna da equipe. Ele é lido em segundos, no topo da tela do cliente, para dar o contexto da conta antes da conversa.

Formato: um parágrafo de 2 a 4 frases curtas, NO MÁXIMO 60 palavras no total, português do Brasil, sem título, sem lista, sem markdown. Não comece com o nome do cliente.

Foque nos últimos 7 dias; use o resto do material só como contexto.

Cruze as fontes: o que o cliente pediu ou a equipe prometeu no grupo e nas reuniões contra as tarefas em aberto e as concluídas.

Priorize, nesta ordem: (1) problema ou insatisfação do cliente; (2) pedido ou promessa do grupo ou da reunião sem tarefa correspondente, com tarefa atrasada ou parada, ou informação contraditória entre as fontes; (3) entrega concluída que responde a um pedido ou problema do cliente; (4) decisões e o que o cliente aprovou ou recusou; (5) mudança de quem acompanha a conta. Corte o resto: rotina de aprovação sem problema, cronologia, detalhe operacional e tarefa interna sem relação com o que foi dito.

Proibido citar (o painel já mostra): saldo, pagamentos, boletos, PIX, datas ou horários de reunião passada ou futura, contagem ou lista de tarefas, prazos, métricas de anúncios e de Instagram, alertas. Cite uma tarefa só quando ela cruzar com algo dito no grupo ou na reunião. Não use datas. Só use número se ele explicar um fato que não está no painel.

Não invente: toda afirmação precisa estar nas mensagens, nos resumos de reunião ou nas tarefas. Falta de tarefa só conta como lacuna quando o pedido é claro. Não presuma gênero: chame de "o cliente" ou pelo nome da pessoa quando ele aparecer. Se a semana não teve nada relevante, diga isso em uma frase.`;

export function buildWeeklyContextPrompt(input: ContextInput): { system: string; user: string } {
  const msgs = input.messages.map((m) => `[${m.at}] ${m.role}: ${m.text}`).join('\n') || '(nenhuma mensagem no período)';
  const meets =
    input.meetings
      .map((r) =>
        JSON.stringify({
          titulo: r.title, em: r.at, resumo: r.summary, pontos: r.points,
          decisoes: r.decisions, acoes: r.actions, pendencias: r.openQuestions,
        }),
      )
      .join('\n') || '(nenhuma reunião transcrita no período)';
  const tasksBlock = (list: ContextTask[] | null | undefined, fmt: (t: ContextTask) => string, none: string) =>
    list == null ? '(tarefas indisponíveis nesta geração)' : list.map(fmt).join('\n') || none;
  const user =
    `Cliente: ${input.clientName}\nHoje: ${input.today}\n\n` +
    `Mensagens do grupo de WhatsApp (últimos ${MESSAGES_WINDOW_DAYS} dias; "BeeAds" = equipe da agência):\n${msgs}\n\n` +
    `Resumos das reuniões (últimos ${MEETINGS_WINDOW_DAYS} dias):\n${meets}\n\n` +
    `Tarefas em aberto da equipe:\n${tasksBlock(input.openTasks, formatOpenTask, '(nenhuma tarefa em aberto)')}\n\n` +
    `Tarefas concluídas (últimos ${COMPLETED_TASKS_WINDOW_DAYS} dias):\n${tasksBlock(input.completedTasks, formatCompletedTask, '(nenhuma tarefa concluída no período)')}`;
  return { system: WEEKLY_CONTEXT_SYSTEM, user };
}

/** Uma linha, sem markdown residual nem aspas de abertura/fecho. */
export function cleanSummary(text: string): string {
  return text
    .replace(/\*\*|__|^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“](.*)["”]$/, '$1')
    .trim();
}

/** "Hoenka + BeeAds" → "Hoenka". */
export function clientNameFromGroup(subject: string | null): string {
  const s = (subject ?? '').replace(/\s*\+\s*bee\s*ads\s*$/i, '').trim();
  return s || 'cliente';
}
