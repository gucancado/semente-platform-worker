// Amostrador estratificado do golden set da Lua (spec §11.1, Task 10.1):
// `pnpm lua:sample`.
//
// Lê o corpus (episodes + episode_turns) e PROPÕE trechos candidatos seguindo a
// tabela estratificada da §11.1:
//   - 8  reuniao interna (Operacao BeeAds — workspace = INTERNAL_WORKSPACE_ID)
//   - 9  reuniao com cliente, de >=4 workspaces distintos
//   - 5  tipos v1.1 (papel/objetivo/ameaca/oportunidade/marco) — best effort
//   - 8  adversariais (decisao revertida, datas relativas, small talk, injection,
//        monologo longo) — best effort por heuristica
// Total alvo = 30. Best-effort dado o que existe no acervo.
//
// SAÍDA: SÓ referências (episode_id, turn_start, turn_end) + um EXCERTO curto pro
// humano localizar o trecho — NUNCA grava transcricao num arquivo commitado
// (spec §11.1: "nunca copiar texto pra fora do banco"). O humano usa as
// referencias pra anotar eval/lua/golden.jsonl à mão (com modelo distinto).
//
// DETERMINISTICO: sem Math.random. Ordena por (occurred_at, id) e faz
// stride-sampling — re-rodar dá a mesma lista (reprodutivel, spec §11.1).

import { pool } from '../../src/db.js';
import { config } from '../../src/config.js';

/** Nome do falante: nome humano > label > `Falante <turn_index>` (espelha pipeline.ts). */
export function speakerOf(r: {
  speaker_name: string | null;
  speaker_label: string | null;
  turn_index: number;
}): string {
  const name = r.speaker_name?.trim();
  if (name) return name;
  const label = r.speaker_label?.trim();
  if (label) return label;
  return `Falante ${r.turn_index}`;
}

// Tamanho da janela de trecho (spec §11.1: 20–60 turnos, contexto autocontido).
const WINDOW_TURNS = 40;
// Quantos turnos pular ao começar (evita o "oi, tudo bem" de abertura).
const HEAD_SKIP = 6;
// Limite do excerto impresso (chars) — só pra localizar, não é o golden.
const EXCERPT_CHARS = 280;

type EpisodeRow = {
  id: number;
  workspace_id: string | null;
  title: string | null;
  fonte: string;
  occurred_at: Date;
  turn_count: number;
};

/** Seleção determinística de N elementos por passada uniforme (stride). */
function stride<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return [...items];
  const out: T[] = [];
  const step = items.length / n;
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

/** Janela de turnos centrada no corpo do episódio (autocontida, §11.1). */
function windowFor(ep: EpisodeRow): { start: number; end: number } {
  const total = ep.turn_count;
  if (total <= WINDOW_TURNS) return { start: 0, end: Math.max(0, total - 1) };
  const start = Math.min(HEAD_SKIP, total - WINDOW_TURNS);
  return { start, end: start + WINDOW_TURNS - 1 };
}

/** Carrega o excerto (poucos turnos) de uma janela — só pra impressão. */
async function excerptOf(episodeId: number, start: number, end: number): Promise<string> {
  const { rows } = await pool.query<{
    turn_index: number;
    speaker_name: string | null;
    speaker_label: string | null;
    text: string;
  }>(
    `SELECT turn_index, speaker_name, speaker_label, text
       FROM episode_turns
      WHERE episode_id = $1 AND turn_index >= $2 AND turn_index <= $3
      ORDER BY turn_index ASC
      LIMIT 4`,
    [episodeId, start, end],
  );
  const txt = rows.map((r) => `${speakerOf(r)}: ${r.text}`).join(' / ');
  return txt.length > EXCERPT_CHARS ? txt.slice(0, EXCERPT_CHARS) + '…' : txt;
}

type Candidate = { estrato: string; ep: EpisodeRow; start: number; end: number };

async function main(): Promise<number> {
  const internalWs = config.INTERNAL_WORKSPACE_ID ?? null;

  // Corpus elegivel: episodios atribuidos (orfaos nao geram memoria, §5.2),
  // com turnos suficientes pra uma janela autocontida. Ordem determinística.
  const { rows: episodes } = await pool.query<EpisodeRow>(
    `SELECT id, workspace_id, title, fonte, occurred_at, turn_count
       FROM episodes
      WHERE workspace_id IS NOT NULL AND turn_count >= 20
      ORDER BY occurred_at ASC, id ASC`,
  );

  if (episodes.length === 0) {
    console.error('Nenhum episodio elegivel (atribuido, >=20 turnos). Acervo vazio?');
    return 1;
  }

  const internal = episodes.filter((e) => internalWs && e.workspace_id === internalWs);
  const clients = episodes.filter((e) => !internalWs || e.workspace_id !== internalWs);

  // Cliente: 1 por workspace distinto primeiro (cobre >=4 workspaces da §11.1),
  // depois completa por stride se faltar.
  const byWs = new Map<string, EpisodeRow>();
  for (const e of clients) {
    if (e.workspace_id && !byWs.has(e.workspace_id)) byWs.set(e.workspace_id, e);
  }
  const clientPerWs = [...byWs.values()];

  const candidates: Candidate[] = [];
  const used = new Set<number>();
  const push = (estrato: string, eps: EpisodeRow[], n: number) => {
    for (const ep of stride(eps.filter((e) => !used.has(e.id)), n)) {
      used.add(ep.id);
      const w = windowFor(ep);
      candidates.push({ estrato, ep, start: w.start, end: w.end });
    }
  };

  // Estratos da tabela §11.1 (best effort).
  push('reuniao-interna', internal, 8);
  // 9 de >=4 workspaces: prioriza 1 por workspace, completa com mais clientes.
  push('cliente', clientPerWs, 9);
  if (candidates.filter((c) => c.estrato === 'cliente').length < 9) {
    push('cliente', clients, 9 - candidates.filter((c) => c.estrato === 'cliente').length);
  }
  // Tipos v1.1 e adversariais: sem rotulo no corpus -> propomos episodios extras
  // pra o humano enquadrar (papeis/objetivos/marcos sao reconhecidos na anotacao).
  push('tipos-v1.1', episodes, 5);
  // Adversariais: monologo longo = episodio com poucos falantes distintos? sem
  // metadado confiavel; entregamos candidatos extras pro humano escolher os
  // casos (decisao revertida, datas relativas, small talk, injection, monologo).
  push('adversarial', episodes, 8);

  // Impressao: so referencias + excerto curto (NUNCA grava texto em arquivo).
  console.log('# Candidatos de golden set da Lua (spec §11.1) — SO REFERENCIAS.');
  console.log('# Anote eval/lua/golden.jsonl a mao (modelo distinto do extrator).');
  console.log(`# workspace interno: ${internalWs ?? '(INTERNAL_WORKSPACE_ID nao setado)'}`);
  console.log(`# total candidatos: ${candidates.length} (alvo §11.1: 30)`);
  console.log(`# workspaces de cliente distintos no acervo: ${byWs.size}`);
  console.log('');

  let i = 0;
  for (const c of candidates) {
    const excerpt = await excerptOf(c.ep.id, c.start, c.end);
    console.log(
      `g-${String(++i).padStart(3, '0')} [${c.estrato}] episode_id=${c.ep.id} ` +
        `turn_start=${c.start} turn_end=${c.end} ` +
        `ws=${c.ep.workspace_id} fonte=${c.ep.fonte}`,
    );
    console.log(`     titulo: ${c.ep.title ?? '(sem titulo)'} | ${c.ep.occurred_at.toISOString().slice(0, 10)}`);
    console.log(`     excerto: ${excerpt}`);
    console.log('');
  }

  // Avisos honestos de cobertura (nao chutar — spec §11.1 pede curadoria humana).
  const warn: string[] = [];
  if (internal.length < 8) warn.push(`reuniao interna: so ${internal.length} disponiveis (<8)`);
  if (byWs.size < 4) warn.push(`workspaces de cliente: so ${byWs.size} (<4 da §11.1)`);
  if (candidates.length < 30) warn.push(`total ${candidates.length} < 30 — completar manualmente`);
  if (warn.length) {
    console.log('# AVISOS DE COBERTURA (best-effort; o humano completa):');
    for (const w of warn) console.log(`#  - ${w}`);
  }
  return 0;
}

// Só roda como CLI; quando importado (run.ts usa speakerOf) NÃO executa main.
const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('sample.ts');
if (isMain) {
  main()
    .then((code) => pool.end().then(() => process.exit(code)))
    .catch((err) => {
      console.error(err);
      pool.end().finally(() => process.exit(1));
    });
}
