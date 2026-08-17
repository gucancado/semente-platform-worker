/**
 * src/whatsapp/board-routes.ts
 *
 * CRM WhatsApp v3 — Fase C, Task C1: rota `GET /whatsapp/board` (contrato §10).
 * Padrão `whatsapp_v1` de leitura: auth X-Panel-Token, envelope {schema,context},
 * gateMember. SEM `workspace_id` na query — o board é por número (página
 * [numberId]); o workspace é derivado do `number_id` (mesmo padrão de
 * /threads/:identifier/messages e /media/:messageId em read-routes.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { tenantContext } from './tenant-context.js';
import { emptyToUndefined } from './query-coerce.js';
import {
  getBoard, isBoardColumn, decodeBoardCursor,
  DEFAULT_LIMIT_PER_COLUMN, MAX_LIMIT_PER_COLUMN, type BoardCursor,
} from './board.js';

export function registerBoardRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string; authz?: RouteAuthz; logAccess?: LogAccessFn },
) {
  const auth = requirePanelToken(deps.panelToken);
  const authz = deps.authz ?? defaultRouteAuthz;
  const logAccess = deps.logAccess ?? defaultLogAccess;

  // ── GET /whatsapp/board ──────────────────────────────────────────────────────
  // Sem column → primeira página das 4 colunas. Com column (+cursor) → só aquela.
  // `status` (toggle Em andamento/Perdidas, default em_andamento) filtra as 3 colunas
  // de posição; `ganhos` sempre entra (spec §2). `since`/`until` (toggle Novas/Todas)
  // recortam por data de CRIAÇÃO da oportunidade e valem pras 4 colunas.
  app.get('/whatsapp/board', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, limit_per_column, column, cursor, status, since, until } =
      req.query as Record<string, string | undefined>;
    if (!number_id) return reply.code(400).send({ error: 'number_id required' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });

    // limit_per_column: default 30, 1..100.
    let limitPerColumn = DEFAULT_LIMIT_PER_COLUMN;
    const limRaw = emptyToUndefined(limit_per_column);
    if (limRaw !== undefined) {
      const n = Number(limRaw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT_PER_COLUMN) {
        return reply.code(400).send({ error: `limit_per_column must be between 1 and ${MAX_LIMIT_PER_COLUMN}` });
      }
      limitPerColumn = n;
    }

    // column: opcional; se presente, deve ser uma das 4 chaves canônicas.
    const col = emptyToUndefined(column);
    if (col !== undefined && !isBoardColumn(col)) return reply.code(400).send({ error: 'invalid column' });

    // status: toggle do funil (default 'em_andamento'); só {em_andamento, perdido}.
    let statusFilter: 'em_andamento' | 'perdido' = 'em_andamento';
    const statRaw = emptyToUndefined(status);
    if (statRaw !== undefined) {
      if (statRaw !== 'em_andamento' && statRaw !== 'perdido') return reply.code(400).send({ error: 'invalid status' });
      statusFilter = statRaw;
    }

    // since/until: janela de criação da opp (toggle Novas/Todas). Validadas AQUI e
    // não deixadas pro `::timestamptz` porque data inválida no cast vira 500 opaco
    // (o pg lança) — o caller merece o 400 que diz o que está errado.
    const sinceRaw = emptyToUndefined(since);
    if (sinceRaw !== undefined && Number.isNaN(Date.parse(sinceRaw))) {
      return reply.code(400).send({ error: 'since must be a valid timestamp' });
    }
    const untilRaw = emptyToUndefined(until);
    if (untilRaw !== undefined && Number.isNaN(Date.parse(untilRaw))) {
      return reply.code(400).send({ error: 'until must be a valid timestamp' });
    }

    // cursor: só faz sentido "carregar mais" DENTRO de uma coluna (spec §10) → exige column.
    let cursorDecoded: BoardCursor | undefined;
    const curRaw = emptyToUndefined(cursor);
    if (curRaw !== undefined) {
      if (col === undefined) return reply.code(400).send({ error: 'cursor requires column' });
      const decoded = decodeBoardCursor(curRaw);
      if (!decoded) return reply.code(400).send({ error: 'invalid cursor' });
      cursorDecoded = decoded;
    }

    // Actor check ANTES da leitura do número (não vaza existência de número a caller sem ator).
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const num = await getNumber(deps.pool, Number(number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;

    const result = await getBoard(deps.pool, {
      workspaceId: num.workspaceId,
      numberId: num.id,
      limitPerColumn,
      column: col,
      cursor: cursorDecoded,
      statusFilter,
      since: sinceRaw,
      until: untilRaw,
    });
    logAccess(deps.pool, { actor: req.actingUser, action: 'board', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({
      schema: 'whatsapp_v1',
      context: tenantContext(num),
      columns: result.columns,
      generatedAt: new Date().toISOString(),
    });
  });
}
