// Busca hibrida da Lua (`search_memoria`, spec Lua v1 §8.2).
//
// Funde dois bracos por workspace: vetorial (pgvector HNSW, distancia cosseno)
// e lexical (tsvector PT-BR, `ts_rank` sobre `websearch_to_tsquery`). A fusao e
// por RRF (Reciprocal Rank Fusion): cada item recebe, por braco em que aparece,
// 1/(60 + rank); somamos as contribuicoes e ordenamos desc.
//
// Convencao de rank do RRF: **0-based** — o 1o colocado de um braco contribui
// 1/(60+0), o 2o 1/(60+1), etc. (consistente entre os dois bracos).
//
// Invariante inviolavel (spec §0): TUDO filtrado por `workspace_id`. Nunca ha
// consulta cross-workspace. Fatos invalidos ficam fora do default.
//
// Pos-filtragem do HNSW (achado Codex #6, spec §8.2): o indice ANN e global;
// com filtro por workspace os vizinhos globais podem ser de outro workspace e o
// resultado vir com < k. Mitigacao: rodar o braco vetorial dentro de uma
// transacao com `SET LOCAL hnsw.iterative_scan = relaxed_order` (pgvector >=0.8,
// 0.8.2 instalada) + `hnsw.ef_search` generoso. No volume atual (poucos milhares
// de chunks) isso retorna deterministicamente as linhas semeadas.
//
// Fallback (spec §8.2): se a API de embedding cair, pulamos o braco vetorial,
// respondemos so-lexical e marcamos `degraded: 'lexical_only'` — a busca nao
// pode morrer junto com a OpenAI.

import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import type { EmbeddingClient } from './embeddings.js';

// ── Tipos publicos ─────────────────────────────────────────────────────────

export interface SearchOpts {
  /** Quantidade final de resultados. Default 8, clampado em [1,30]. */
  k?: number;
  /** Camadas consultadas. Default 'ambos'. */
  scope?: 'episodios' | 'fatos' | 'ambos';
  /** Inicio do periodo (occurred_at do chunk / valid_at do fato). */
  since?: string | Date;
  /** Fim do periodo. */
  until?: string | Date;
  /** Inclui fatos invalidados (arqueologia). Default false. */
  includeInvalid?: boolean;
}

export interface ChunkProvenance {
  episode_id: number;
  episode_title: string | null;
  occurred_at: string;
  turn_start: number;
  turn_end: number;
}

export interface FactProvenance {
  episode_id: number;
  turn_start: number;
  turn_end: number;
}

export interface ChunkHit {
  kind: 'chunk';
  score: number;
  text: string;
  provenance: ChunkProvenance;
}

export interface FactHit {
  kind: 'fato';
  score: number;
  fact_id: number;
  fact_type: string;
  statement: string;
  confidence: number;
  valid_at: string;
  invalid_at: string | null;
  needs_review: boolean;
  provenance: FactProvenance;
}

export type SearchHit = ChunkHit | FactHit;

export interface SearchResult {
  schema: 'memoria_search_v1';
  /** Presente apenas quando o braco vetorial foi pulado (embedding fora do ar). */
  degraded?: 'lexical_only';
  results: SearchHit[];
}

// ── Constantes ─────────────────────────────────────────────────────────────

const DEFAULT_K = 8;
const MAX_K = 30;
const ARM_LIMIT = 50; // top-50 por braco (spec §8.2)
const RRF_K = 60; // constante classica do RRF

// ── Helpers ────────────────────────────────────────────────────────────────

function clampK(k: number | undefined): number {
  const v = Number.isFinite(k) ? Math.trunc(k as number) : DEFAULT_K;
  return Math.max(1, Math.min(MAX_K, v));
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function toIso(d: string | Date | undefined): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

// Linhas cruas de cada braco. `key` identifica o item entre bracos para o RRF
// (chunk:<id> ou fato:<id>) — somar scores exige a mesma chave.

type ChunkRaw = {
  kind: 'chunk';
  key: string;
  id: number;
  text: string;
  episode_id: number;
  episode_title: string | null;
  occurred_at: string;
  turn_start: number;
  turn_end: number;
};

type FactRaw = {
  kind: 'fato';
  key: string;
  id: number;
  fact_type: string;
  statement: string;
  confidence: number;
  valid_at: string;
  invalid_at: string | null;
  needs_review: boolean;
  episode_id: number;
  turn_start: number;
  turn_end: number;
};

type Raw = ChunkRaw | FactRaw;

function mapChunkRow(r: any): ChunkRaw {
  const id = Number(r.id);
  return {
    kind: 'chunk',
    key: `chunk:${id}`,
    id,
    text: r.text,
    episode_id: Number(r.episode_id),
    episode_title: r.episode_title ?? null,
    occurred_at: (r.occurred_at as Date).toISOString(),
    turn_start: r.turn_start,
    turn_end: r.turn_end,
  };
}

function mapFactRow(r: any): FactRaw {
  const id = Number(r.id);
  return {
    kind: 'fato',
    key: `fato:${id}`,
    id,
    fact_type: r.fact_type,
    statement: r.statement,
    confidence: Number(r.confidence),
    valid_at: (r.valid_at as Date).toISOString(),
    invalid_at: r.invalid_at ? (r.invalid_at as Date).toISOString() : null,
    needs_review: r.needs_review,
    episode_id: Number(r.episode_id),
    turn_start: r.turn_start,
    turn_end: r.turn_end,
  };
}

// ── Bracos lexicais (por scope) ────────────────────────────────────────────

async function lexicalChunks(
  q: { run: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  workspaceId: string,
  query: string,
  since: string | null,
  until: string | null
): Promise<ChunkRaw[]> {
  const { rows } = await q.run(
    `SELECT c.id, c.text, c.turn_start, c.turn_end,
            e.id AS episode_id, e.title AS episode_title, e.occurred_at
       FROM episode_chunks c
       JOIN episodes e ON e.id = c.episode_id
      WHERE c.workspace_id = $1
        AND c.tsv @@ websearch_to_tsquery('portuguese', $2)
        AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
      ORDER BY ts_rank(c.tsv, websearch_to_tsquery('portuguese', $2)) DESC, c.id ASC
      LIMIT ${ARM_LIMIT}`,
    [workspaceId, query, since, until]
  );
  return rows.map(mapChunkRow);
}

async function lexicalFacts(
  q: { run: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  workspaceId: string,
  query: string,
  since: string | null,
  until: string | null,
  includeInvalid: boolean
): Promise<FactRaw[]> {
  const { rows } = await q.run(
    `SELECT id, fact_type, statement, confidence, valid_at, invalid_at,
            needs_review, episode_id, turn_start, turn_end
       FROM facts
      WHERE workspace_id = $1
        AND tsv @@ websearch_to_tsquery('portuguese', $2)
        AND ($3::timestamptz IS NULL OR valid_at >= $3)
        AND ($4::timestamptz IS NULL OR valid_at <= $4)
        AND ($5::boolean OR invalid_at IS NULL)
      ORDER BY ts_rank(tsv, websearch_to_tsquery('portuguese', $2)) DESC, id ASC
      LIMIT ${ARM_LIMIT}`,
    [workspaceId, query, since, until, includeInvalid]
  );
  return rows.map(mapFactRow);
}

// ── Bracos vetoriais (por scope) — exigem transacao (SET LOCAL) ────────────

async function vectorChunks(
  client: PoolClient,
  workspaceId: string,
  vec: string,
  since: string | null,
  until: string | null
): Promise<ChunkRaw[]> {
  const { rows } = await client.query(
    `SELECT c.id, c.text, c.turn_start, c.turn_end,
            e.id AS episode_id, e.title AS episode_title, e.occurred_at
       FROM episode_chunks c
       JOIN episodes e ON e.id = c.episode_id
      WHERE c.workspace_id = $1
        AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
      ORDER BY c.embedding <=> $2::vector
      LIMIT ${ARM_LIMIT}`,
    [workspaceId, vec, since, until]
  );
  return rows.map(mapChunkRow);
}

async function vectorFacts(
  client: PoolClient,
  workspaceId: string,
  vec: string,
  since: string | null,
  until: string | null,
  includeInvalid: boolean
): Promise<FactRaw[]> {
  const { rows } = await client.query(
    `SELECT id, fact_type, statement, confidence, valid_at, invalid_at,
            needs_review, episode_id, turn_start, turn_end
       FROM facts
      WHERE workspace_id = $1
        AND ($3::timestamptz IS NULL OR valid_at >= $3)
        AND ($4::timestamptz IS NULL OR valid_at <= $4)
        AND ($5::boolean OR invalid_at IS NULL)
      ORDER BY embedding <=> $2::vector
      LIMIT ${ARM_LIMIT}`,
    [workspaceId, vec, since, until, includeInvalid]
  );
  return rows.map(mapFactRow);
}

// ── Fusao RRF ──────────────────────────────────────────────────────────────

/**
 * Funde N listas rankeadas (uma por braco) em scores RRF acumulados.
 * Rank 0-based: o item na posicao `i` de um braco contribui 1/(60 + i).
 * Mantemos a payload da primeira ocorrencia de cada chave.
 */
function fuseRRF(arms: Raw[][]): Array<{ raw: Raw; score: number }> {
  const scores = new Map<string, number>();
  const payload = new Map<string, Raw>();
  for (const arm of arms) {
    arm.forEach((item, rank) => {
      scores.set(item.key, (scores.get(item.key) ?? 0) + 1 / (RRF_K + rank));
      if (!payload.has(item.key)) payload.set(item.key, item);
    });
  }
  const fused = [...scores.entries()].map(([key, score]) => ({
    raw: payload.get(key)!,
    score,
  }));
  // Ordena por score desc; desempate estavel por chave para determinismo.
  fused.sort((a, b) => b.score - a.score || a.raw.key.localeCompare(b.raw.key));
  return fused;
}

function toHit(raw: Raw, score: number): SearchHit {
  if (raw.kind === 'chunk') {
    return {
      kind: 'chunk',
      score,
      text: raw.text,
      provenance: {
        episode_id: raw.episode_id,
        episode_title: raw.episode_title,
        occurred_at: raw.occurred_at,
        turn_start: raw.turn_start,
        turn_end: raw.turn_end,
      },
    };
  }
  return {
    kind: 'fato',
    score,
    fact_id: raw.id,
    fact_type: raw.fact_type,
    statement: raw.statement,
    confidence: raw.confidence,
    valid_at: raw.valid_at,
    invalid_at: raw.invalid_at,
    needs_review: raw.needs_review,
    provenance: {
      episode_id: raw.episode_id,
      turn_start: raw.turn_start,
      turn_end: raw.turn_end,
    },
  };
}

// ── Entrada publica ────────────────────────────────────────────────────────

export async function searchMemoria(
  args: { workspaceId: string; query: string },
  opts: SearchOpts,
  deps: { embeddingClient: EmbeddingClient }
): Promise<SearchResult> {
  const { workspaceId, query } = args;
  const k = clampK(opts.k);
  const scope = opts.scope ?? 'ambos';
  const since = toIso(opts.since);
  const until = toIso(opts.until);
  const includeInvalid = opts.includeInvalid ?? false;
  const wantChunks = scope === 'episodios' || scope === 'ambos';
  const wantFacts = scope === 'fatos' || scope === 'ambos';

  // ── 1. Embed da query (request-time). Falha => so-lexical degradado. ──────
  let vec: string | null = null;
  let degraded = false;
  try {
    const out = await deps.embeddingClient.embed([query]);
    const v = out?.[0];
    if (v && v.length > 0) vec = toVectorLiteral(v);
    else degraded = true;
  } catch {
    degraded = true;
  }

  // ── 2. Braco lexical (fora de transacao, queries simples). ───────────────
  const lex = { run: (sql: string, params: unknown[]) => pool.query(sql, params) };
  const lexChunkArm = wantChunks
    ? await lexicalChunks(lex, workspaceId, query, since, until)
    : [];
  const lexFactArm = wantFacts
    ? await lexicalFacts(lex, workspaceId, query, since, until, includeInvalid)
    : [];

  // ── 3. Braco vetorial (so se embed deu certo). Transacao p/ SET LOCAL. ────
  let vecChunkArm: ChunkRaw[] = [];
  let vecFactArm: FactRaw[] = [];
  if (vec !== null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Pos-filtragem robusta do HNSW (spec §8.2): iterative_scan + ef_search
      // alto garantem que o filtro por workspace nao sub-retorne.
      await client.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await client.query(`SET LOCAL hnsw.ef_search = 200`);
      if (wantChunks) {
        vecChunkArm = await vectorChunks(client, workspaceId, vec, since, until);
      }
      if (wantFacts) {
        vecFactArm = await vectorFacts(
          client,
          workspaceId,
          vec,
          since,
          until,
          includeInvalid
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── 4. Fusao RRF. Chunks e fatos sao fundidos juntos quando scope='ambos'. ─
  const arms: Raw[][] = [];
  if (vecChunkArm.length) arms.push(vecChunkArm);
  if (lexChunkArm.length) arms.push(lexChunkArm);
  if (vecFactArm.length) arms.push(vecFactArm);
  if (lexFactArm.length) arms.push(lexFactArm);

  const fused = fuseRRF(arms).slice(0, k);
  const results = fused.map(({ raw, score }) => toHit(raw, score));

  const out: SearchResult = { schema: 'memoria_search_v1', results };
  if (degraded) out.degraded = 'lexical_only';
  return out;
}
