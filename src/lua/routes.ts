import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import { requireOwnerToken } from '../admin/auth.js';
import { searchMemoria } from './search.js';
import { getEmbeddingClient } from './embedding-provider.js';
import {
  getFatos,
  getStatusVigente,
  getRecapByWeek,
  getActiveConduta,
  listRuns,
  listProcessing,
  replayDead,
  forceReprocess,
  listReviewFacts,
  resolveFact,
  deleteRecap,
  type FactType,
  type ProcessingStatus,
} from './db.js';
import { approveConduta, rejectConduta } from './condutas.js';
import { resolveRecapPeriodStart } from './narrativa.js';

// Espelho REST de `search_memoria` (spec §8.6). Auth: X-Agent-Token (Lua,
// Saturno, GUI). `q` e `workspace_id` obrigatorios; o resto opcional.
const SearchQuery = z.object({
  workspace_id: z.string().min(1),
  q: z.string().min(1),
  k: z.coerce.number().int().optional(),
  scope: z.enum(['episodios', 'fatos', 'ambos']).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

const FACT_TYPES = [
  'decisao', 'preferencia', 'restricao', 'compromisso', 'contexto',
  'objetivo', 'ameaca', 'oportunidade', 'marco', 'papel',
] as const;

// `GET /memoria/fatos` (spec §8.3). types vem como CSV ou multi-valor.
const FatosQuery = z.object({
  workspace_id: z.string().min(1),
  types: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      v == null
        ? undefined
        : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)
    )
    .pipe(z.array(z.enum(FACT_TYPES)).optional()),
  vigente_em: z.string().optional(),
  include_invalid: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().optional(),
  episode_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
});

const StatusQuery = z.object({ workspace_id: z.string().min(1) });

// `GET /memoria/recap` (spec §8.4). `week` (YYYY-Www) ou `start` (YYYY-MM-DD);
// default: semana ISO anterior. Resposta recap_v1 (content_md null se nao gerado).
const RecapQuery = z.object({
  workspace_id: z.string().min(1),
  week: z.string().optional(),
  start: z.string().optional(),
});

// Admin (spec §7).
const ProcessingQuery = z.object({
  status: z
    .enum(['pending', 'chunked', 'done', 'failed', 'dead', 'skipped'])
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
const RunsQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});
const FactsAdminQuery = z.object({
  workspace_id: z.string().min(1),
  needs_review: z.enum(['true', 'false']).optional(),
});
const ResolveBody = z.object({
  action: z.enum(['confirm', 'invalidate', 'supersede_by']),
  targetId: z.number().int().positive().optional(),
});

const CondutasQuery = z.object({ workspace_id: z.string().min(1) });
const ApproveCondutaBody = z.object({
  approved_by: z.string().min(1),
  content_md: z.string().min(1).optional(),
});
const RejectCondutaBody = z.object({ note: z.string().min(1) });

export async function registerMemoriaRoutes(app: FastifyInstance): Promise<void> {
  // ── Leitura: X-Agent-Token (Lua, Saturno, GUI) ──────────────────────────
  app.register(async (scope) => {
    scope.addHook('preHandler', requireAgentToken);

    scope.get('/memoria/search', async (req, reply) => {
      const parsed = SearchQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { workspace_id, q, k, scope: searchScope, since, until } = parsed.data;
      const result = await searchMemoria(
        { workspaceId: workspace_id, query: q },
        { k, scope: searchScope, since, until },
        { embeddingClient: getEmbeddingClient() }
      );
      return result;
    });

    // ── GET /memoria/fatos (§8.3) ─────────────────────────────────────────
    scope.get('/memoria/fatos', async (req, reply) => {
      const parsed = FatosQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const d = parsed.data;
      try {
        const { fatos, next_cursor } = await getFatos(d.workspace_id, {
          types: d.types as FactType[] | undefined,
          vigenteEm: d.vigente_em,
          includeInvalid: d.include_invalid,
          q: d.q,
          episodeId: d.episode_id,
          limit: d.limit,
          cursor: d.cursor,
        });
        return { schema: 'memoria_fatos_v1', workspace_id: d.workspace_id, fatos, next_cursor };
      } catch (err) {
        if (err instanceof Error && err.message === 'cursor inválido') {
          return reply.code(400).send({ error: 'cursor inválido' });
        }
        throw err;
      }
    });

    // ── GET /memoria/status (§8.5) ────────────────────────────────────────
    scope.get('/memoria/status', async (req, reply) => {
      const parsed = StatusQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const status = await getStatusVigente(parsed.data.workspace_id);
      if (!status) {
        return {
          schema: 'status_v1',
          workspace_id: parsed.data.workspace_id,
          content_md: null,
          generated_at: null,
          sources: [],
        };
      }
      return {
        schema: 'status_v1',
        workspace_id: status.workspace_id,
        content_md: status.content_md,
        generated_at: status.generated_at,
        sources: status.sources,
      };
    });

    // ── GET /memoria/condutas (§8.1) ──────────────────────────────────────
    scope.get('/memoria/condutas', async (req, reply) => {
      const parsed = CondutasQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const conduta = await getActiveConduta(parsed.data.workspace_id);
      if (!conduta) {
        return {
          schema: 'conduta_v1',
          workspace_id: parsed.data.workspace_id,
          version: null,
          content_md: null,
          rules: [],
        };
      }
      return {
        schema: 'conduta_v1',
        workspace_id: conduta.workspace_id,
        version: conduta.version,
        approved_at: conduta.approved_at,
        content_md: conduta.content_md,
        rules: conduta.rules,
      };
    });

    // ── GET /memoria/recap (§8.4) ─────────────────────────────────────────
    scope.get('/memoria/recap', async (req, reply) => {
      const parsed = RecapQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      let periodStart: string;
      try {
        periodStart = resolveRecapPeriodStart({ week: parsed.data.week, start: parsed.data.start });
      } catch {
        return reply.code(400).send({ error: 'periodo inválido' });
      }
      const recap = await getRecapByWeek(parsed.data.workspace_id, periodStart);
      if (!recap) {
        return {
          schema: 'recap_v1',
          workspace_id: parsed.data.workspace_id,
          period_start: periodStart,
          period_end: null,
          content_md: null,
          sources: [],
        };
      }
      return {
        schema: 'recap_v1',
        workspace_id: recap.workspace_id,
        period_start: recap.period_start,
        period_end: recap.period_end,
        content_md: recap.content_md,
        sources: recap.sources,
      };
    });
  });

  // ── Admin: X-Owner-Token (observabilidade, DLQ, triagem — §7) ───────────
  app.register(async (scope) => {
    scope.addHook('preHandler', requireOwnerToken);

    scope.get('/admin/lua/runs', async (req, reply) => {
      const parsed = RunsQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      return { runs: await listRuns(parsed.data.limit ?? 20) };
    });

    scope.get('/admin/lua/processing', async (req, reply) => {
      const parsed = ProcessingQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      return {
        processing: await listProcessing({
          status: parsed.data.status as ProcessingStatus | undefined,
          limit: parsed.data.limit,
        }),
      };
    });

    scope.post('/admin/lua/processing/:id/replay', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const ok = await replayDead(Number(rawId));
      if (!ok) return reply.code(404).send({ error: 'linha não encontrada ou não está dead' });
      return { ok: true };
    });

    scope.post('/admin/lua/episodes/:id/reprocess', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const ok = await forceReprocess(Number(rawId));
      if (!ok) return reply.code(404).send({ error: 'episódio não encontrado' });
      return { ok: true };
    });

    scope.get('/admin/lua/facts', async (req, reply) => {
      const parsed = FactsAdminQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      // v1: o filtro de triagem é needs_review=true (§7). Sem o flag, devolve
      // a mesma lista de flagados (a triagem é o único caso de uso admin hoje).
      return { facts: await listReviewFacts(parsed.data.workspace_id) };
    });

    scope.patch('/admin/lua/facts/:id', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const parsed = ResolveBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { action, targetId } = parsed.data;
      if (action === 'supersede_by' && targetId == null) {
        return reply.code(400).send({ error: 'targetId obrigatório para supersede_by' });
      }
      const ok =
        action === 'supersede_by'
          ? await resolveFact(Number(rawId), { action, targetId: targetId! })
          : await resolveFact(Number(rawId), { action });
      if (!ok) return reply.code(404).send({ error: 'fato não encontrado' });
      return { ok: true };
    });

    scope.delete('/admin/lua/recaps/:id', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const ok = await deleteRecap(Number(rawId));
      if (!ok) return reply.code(404).send({ error: 'recap não encontrado' });
      return { ok: true };
    });

    // ── Portao de conduta (§9.5): aprovar / rejeitar sob X-Owner-Token ──────
    scope.post('/admin/condutas/:id/approve', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const parsed = ApproveCondutaBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      try {
        await approveConduta(Number(rawId), {
          approvedBy: parsed.data.approved_by,
          contentMdOverride: parsed.data.content_md,
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'conduta nao encontrada') {
          return reply.code(404).send({ error: 'conduta não encontrada' });
        }
        throw err;
      }
      return { ok: true };
    });

    scope.post('/admin/condutas/:id/reject', async (req, reply) => {
      const rawId = (req.params as { id: string }).id;
      if (!/^\d+$/.test(rawId)) return reply.code(400).send({ error: 'id inválido' });
      const parsed = RejectCondutaBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      try {
        await rejectConduta(Number(rawId), { note: parsed.data.note });
      } catch (err) {
        if (err instanceof Error && err.message === 'conduta nao encontrada') {
          return reply.code(404).send({ error: 'conduta não encontrada' });
        }
        throw err;
      }
      return { ok: true };
    });
  });
}
