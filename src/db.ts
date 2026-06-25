import pg from 'pg';
import type { PoolClient } from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  // Mata pool.connect() se nenhuma conexão livre em 10s (defesa contra hang
  // permanente esperando slot — preferimos falhar rápido e deixar requests
  // novos rodarem).
  connectionTimeoutMillis: 10_000,
  // Mata query individual após 30s no Postgres-side. Defende contra query
  // pendurada bloqueando connection no pool indefinidamente.
  statement_timeout: 30_000,
  // Mata transação ociosa após 60s (BEGIN sem COMMIT/ROLLBACK). Crítico pra
  // claimDuePendingTriggers que usa FOR UPDATE SKIP LOCKED — se poller crashar
  // mid-transação, Postgres libera após 60s em vez de manter lock pra sempre.
  idle_in_transaction_session_timeout: 60_000,
} as any);

// node-postgres emite um evento 'error' em clientes OCIOSOS do pool quando o
// backend encerra a conexão (statement/idle-in-transaction timeout, restart do
// Postgres, rede). SEM um listener, esse evento é não-tratado e DERRUBA o
// processo inteiro (crash do worker em prod E do bootstrap — deixando transações
// zumbis que seguram locks e travam os claims seguintes). A query em curso já
// rejeita na própria call (try/catch local); aqui só logamos e seguimos.
pool.on('error', (err) => {
  console.error('[pg pool] erro em conexão ociosa (recuperado, não-fatal):', err.message);
});

// O pool.on('error') acima só cobre clientes OCIOSOS. Um cliente CHECKED OUT
// (em uso numa transação — ex.: a TX2 do estágio B, que segura o cliente durante
// busca de vizinhos + judges + inserts) cujo backend cai mid-transação emite
// 'error' no PRÓPRIO cliente; sem listener nele, o evento é não-tratado e derruba
// o processo (matava o bootstrap após poucos episódios, deixando TX zumbi). Anexa
// um listener a cada cliente no momento da conexão. A query em curso já rejeita.
pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('[pg client] erro em conexão em uso (recuperado, não-fatal):', err.message);
  });
});

export type ContactRoute = {
  id: number;
  agent: string;
  channel: 'whatsapp' | 'email';
  identifier: string;
  workspace_id: string;
  display_name: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function lookupContact(
  agent: string,
  channel: string,
  identifier: string
): Promise<ContactRoute | null> {
  const { rows } = await pool.query<ContactRoute>(
    `SELECT * FROM contact_routes WHERE agent = $1 AND channel = $2 AND identifier = $3 LIMIT 1`,
    [agent, channel, identifier]
  );
  return rows[0] ?? null;
}

export async function upsertContact(args: {
  agent: string;
  channel: string;
  identifier: string;
  workspace_id: string;
  display_name?: string | null;
  notes?: string | null;
}): Promise<ContactRoute> {
  const { rows } = await pool.query<ContactRoute>(
    `INSERT INTO contact_routes (agent, channel, identifier, workspace_id, display_name, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (agent, channel, identifier)
     DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       display_name = COALESCE(EXCLUDED.display_name, contact_routes.display_name),
       notes = COALESCE(EXCLUDED.notes, contact_routes.notes),
       updated_at = NOW()
     RETURNING *`,
    [
      args.agent,
      args.channel,
      args.identifier,
      args.workspace_id,
      args.display_name ?? null,
      args.notes ?? null,
    ]
  );
  return rows[0]!;
}

export async function listContactsByWorkspace(
  agent: string,
  workspace_id: string
): Promise<ContactRoute[]> {
  const { rows } = await pool.query<ContactRoute>(
    `SELECT * FROM contact_routes WHERE agent = $1 AND workspace_id = $2 ORDER BY created_at DESC`,
    [agent, workspace_id]
  );
  return rows;
}

export async function deleteContact(agent: string, id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM contact_routes WHERE agent = $1 AND id = $2`,
    [agent, id]
  );
  return (rowCount ?? 0) > 0;
}

export async function logWebhook(args: {
  agent: string | null;
  channel: string;
  identifier: string | null;
  evolution_event_id: string | null;
  payload_summary: string | null;
  bloquim_task_id: string | null;
  fallback_used: boolean;
  instance?: string | null;
  push_name?: string | null;
  message_text?: string | null;
  workspace_id?: string | null;
  author?: string | null;
  whatsapp_number_id?: number | null;
}): Promise<{ id: number; duplicate: boolean }> {
  // Dedup: índice único parcial em (evolution_event_id) — global por evento.
  // Se Evolution re-emite o mesmo evento, ON CONFLICT cai no DO NOTHING e a
  // query principal não retorna linha — buscamos o id existente num segundo SELECT.
  const insert = await pool.query<{ id: number }>(
    `INSERT INTO webhook_logs
       (agent, channel, identifier, evolution_event_id, payload_summary, bloquim_task_id, fallback_used,
        instance, push_name, message_text, workspace_id, author, whatsapp_number_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (evolution_event_id) WHERE evolution_event_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      args.agent,
      args.channel,
      args.identifier,
      args.evolution_event_id,
      args.payload_summary,
      args.bloquim_task_id,
      args.fallback_used,
      args.instance ?? null,
      args.push_name ?? null,
      args.message_text ?? null,
      args.workspace_id ?? null,
      args.author ?? null,
      args.whatsapp_number_id ?? null,
    ]
  );
  if (insert.rows[0]) {
    return { id: insert.rows[0].id, duplicate: false };
  }
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM webhook_logs WHERE evolution_event_id = $1 LIMIT 1`,
    [args.evolution_event_id]
  );
  return { id: existing.rows[0]!.id, duplicate: true };
}

export type InboxItem = {
  id: number;
  agent: string;
  channel: string;
  instance: string | null;
  identifier: string | null;
  author: string | null;
  push_name: string | null;
  message_text: string | null;
  workspace_id: string | null;
  evolution_event_id: string | null;
  created_at: Date;
};

/**
 * Lista mensagens recebidas e ainda não processadas pelo agente.
 * Default: mais antigas primeiro (FIFO) — não perde mensagem em fila longa.
 */
export async function listUnreadInbox(
  agent: string,
  limit = 20,
  instance?: string,
  identifier?: string
): Promise<InboxItem[]> {
  const args: unknown[] = [agent, limit];
  let where = `agent = $1 AND processed_at IS NULL`;
  if (instance) {
    args.push(instance);
    where += ` AND instance = $${args.length}`;
  }
  // Filtro por identifier (remetente/grupo). Como o LIMIT é aplicado depois do
  // WHERE, filtrar aqui faz o FIFO devolver as N mais antigas DAQUELE escopo —
  // resolve a "parede FIFO" em que mensagens de outros grupos ocupavam o teto.
  if (identifier) {
    args.push(identifier);
    where += ` AND identifier = $${args.length}`;
  }
  const { rows } = await pool.query<InboxItem>(
    `SELECT id, agent, channel, instance, identifier, author, push_name, message_text,
            workspace_id, evolution_event_id, created_at
       FROM webhook_logs
      WHERE ${where}
      ORDER BY created_at ASC
      LIMIT $2`,
    args
  );
  return rows;
}

/**
 * Marca uma mensagem como processada. Idempotente — re-marcar não falha
 * mas não altera processed_at original.
 */
export async function markInboxRead(
  agent: string,
  id: number,
  processedBy: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE webhook_logs
        SET processed_at = NOW(),
            processed_by = COALESCE(processed_by, $3)
      WHERE id = $2 AND agent = $1 AND processed_at IS NULL`,
    [agent, id, processedBy]
  );
  return (rowCount ?? 0) > 0;
}

// ── Fase 1: messages + llm_metrics ──────────────────────────────────────

export type MessageRow = {
  id: number;
  agent: string;
  channel: string;
  identifier: string;
  direction: 'inbound' | 'outbound';
  text: string;
  evolution_event_id: string | null;
  evolution_send_id: string | null;
  tier: string | null;
  model: string | null;
  provider: string | null;
  classifier_intent: string | null;
  cost_usd: string | null;
  latency_ms: number | null;
  created_at: Date;
};

/**
 * Insere uma mensagem na linha do tempo conversacional.
 * Dedup automático pra inbound via índice único parcial em (agent, evolution_event_id).
 * Retorna { id, duplicate } no padrão de logWebhook — duplicate=true quando o
 * INSERT cai em ON CONFLICT e a row já existia.
 */
export async function insertMessage(args: {
  agent: string | null;
  project?: string | null;
  channel: string;
  identifier: string;
  author?: string | null;
  direction: 'inbound' | 'outbound';
  text: string;
  evolution_event_id?: string | null;
  evolution_send_id?: string | null;
  tier?: string | null;
  model?: string | null;
  provider?: string | null;
  classifier_intent?: string | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
  whatsapp_number_id?: number | null;
  workspace_id?: string | null;
}): Promise<{ id: number; duplicate: boolean }> {
  // ingest_source: todas as linhas inseridas aqui recebem 'live' via DEFAULT da coluna (migration 034).
  // Number-path (monitored/agent_operated): dedup por (whatsapp_number_id, evolution_event_id).
  // Cobre inbound E outbound — cada número grava sua própria cópia, mesmo que a mesma
  // mensagem (mesmo evolution_event_id) seja vista por outro número do mesmo worker.
  if (args.evolution_event_id && args.whatsapp_number_id != null) {
    const insert = await pool.query<{ id: number }>(
      `INSERT INTO messages
         (agent, project, channel, identifier, author, direction, text, evolution_event_id, whatsapp_number_id, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (whatsapp_number_id, evolution_event_id)
         WHERE whatsapp_number_id IS NOT NULL AND evolution_event_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [args.agent, args.project ?? null, args.channel, args.identifier, args.author ?? null, args.direction, args.text, args.evolution_event_id, args.whatsapp_number_id, args.workspace_id ?? null]
    );
    if (insert.rows[0]) return { id: insert.rows[0].id, duplicate: false };
    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM messages WHERE whatsapp_number_id = $1 AND evolution_event_id = $2 LIMIT 1`,
      [args.whatsapp_number_id, args.evolution_event_id]
    );
    return { id: existing.rows[0]!.id, duplicate: true };
  }

  // Pra inbound com evolution_event_id E agent presente, tenta ON CONFLICT (dedup).
  // Pra outbound, inbound sem event_id, ou agent null, insert direto.
  if (args.direction === 'inbound' && args.evolution_event_id && args.agent) {
    const insert = await pool.query<{ id: number }>(
      `INSERT INTO messages
         (agent, project, channel, identifier, author, direction, text, evolution_event_id, whatsapp_number_id, workspace_id)
       VALUES ($1, $2, $3, $4, $5, 'inbound', $6, $7, $8, $9)
       ON CONFLICT (agent, evolution_event_id)
         WHERE direction = 'inbound' AND evolution_event_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [args.agent, args.project ?? null, args.channel, args.identifier, args.author ?? null, args.text, args.evolution_event_id, args.whatsapp_number_id ?? null, args.workspace_id ?? null]
    );
    if (insert.rows[0]) return { id: insert.rows[0].id, duplicate: false };

    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM messages
        WHERE agent = $1 AND direction = 'inbound' AND evolution_event_id = $2
        LIMIT 1`,
      [args.agent, args.evolution_event_id]
    );
    return { id: existing.rows[0]!.id, duplicate: true };
  }

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO messages
       (agent, project, channel, identifier, author, direction, text,
        evolution_event_id, evolution_send_id,
        tier, model, provider, classifier_intent, cost_usd, latency_ms,
        whatsapp_number_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      args.agent,
      args.project ?? null,
      args.channel,
      args.identifier,
      args.author ?? null,
      args.direction,
      args.text,
      args.evolution_event_id ?? null,
      args.evolution_send_id ?? null,
      args.tier ?? null,
      args.model ?? null,
      args.provider ?? null,
      args.classifier_intent ?? null,
      args.cost_usd ?? null,
      args.latency_ms ?? null,
      args.whatsapp_number_id ?? null,
      args.workspace_id ?? null,
    ]
  );
  return { id: rows[0]!.id, duplicate: false };
}

// ── Fase 3: config por (agent, project) — hoje só quiet_hours ──

export type AgentProjectConfig = {
  agent: string;
  project: string;
  quiet_hours_enabled: boolean;
  quiet_start: string; // HH:MM:SS
  quiet_end: string; // HH:MM:SS
  quiet_tz: string;
  created_at: Date;
  updated_at: Date;
};

export async function getAgentProjectConfig(
  agent: string,
  project: string
): Promise<AgentProjectConfig | null> {
  const { rows } = await pool.query<AgentProjectConfig>(
    `SELECT agent, project, quiet_hours_enabled,
            quiet_start::text AS quiet_start,
            quiet_end::text AS quiet_end,
            quiet_tz, created_at, updated_at
       FROM agent_project_config
      WHERE agent = $1 AND project = $2`,
    [agent, project]
  );
  return rows[0] ?? null;
}

/**
 * Upsert atômico. Campos não-fornecidos preservam valor existente (COALESCE
 * com EXCLUDED). Defaults aplicam só em INSERT inicial.
 */
export async function upsertAgentProjectConfig(args: {
  agent: string;
  project: string;
  quiet_hours_enabled?: boolean;
  quiet_start?: string;
  quiet_end?: string;
  quiet_tz?: string;
}): Promise<AgentProjectConfig> {
  const { rows } = await pool.query<AgentProjectConfig>(
    `INSERT INTO agent_project_config
       (agent, project, quiet_hours_enabled, quiet_start, quiet_end, quiet_tz)
     VALUES (
       $1, $2,
       COALESCE($3, false),
       COALESCE($4::time, '23:00'::time),
       COALESCE($5::time, '07:00'::time),
       COALESCE($6, 'America/Sao_Paulo')
     )
     ON CONFLICT (agent, project) DO UPDATE SET
       quiet_hours_enabled = COALESCE($3, agent_project_config.quiet_hours_enabled),
       quiet_start = COALESCE($4::time, agent_project_config.quiet_start),
       quiet_end = COALESCE($5::time, agent_project_config.quiet_end),
       quiet_tz = COALESCE($6, agent_project_config.quiet_tz),
       updated_at = NOW()
     RETURNING agent, project, quiet_hours_enabled,
               quiet_start::text AS quiet_start,
               quiet_end::text AS quiet_end,
               quiet_tz, created_at, updated_at`,
    [
      args.agent,
      args.project,
      args.quiet_hours_enabled ?? null,
      args.quiet_start ?? null,
      args.quiet_end ?? null,
      args.quiet_tz ?? null,
    ]
  );
  return rows[0]!;
}

// ── Fase 2: pending_triggers (burst smoothing + quiet-hours fail-safe) ──

export type MeetingReconcilePayload =
  | { event: 'cancelled_by_organizer'; meeting_id: number; old_slot_iso: string }
  | { event: 'moved_by_organizer'; meeting_id: number; old_slot_iso: string; new_slot_iso: string };

export type PendingTrigger = {
  id: number;
  agent: string;
  project: string | null;
  identifier: string;
  last_inbox_id: number | null;
  msg_count: number;
  attempt_count: number;
  trigger_type: 'inbox' | 'meeting_reconcile';
  payload: MeetingReconcilePayload | null;
};

/**
 * Enfileira (ou atualiza) um trigger pendente.
 *
 * Se já existe um trigger 'pending' pra esse (agent, identifier), o UPSERT
 * empurra `scheduled_at` pra frente — esse é o **debounce/burst smoothing**:
 * lead manda 5 msgs em 10s, mercurio recebe 1 trigger só.
 *
 * `scheduled_at` é computado pelo caller (`computeScheduledAt`), que considera
 * tanto debounce quanto quiet hours.
 */
export async function enqueuePendingTrigger(args: {
  agent: string;
  project: string | null;
  identifier: string;
  inbox_id: number;
  scheduled_at: Date;
}): Promise<{ id: number; msg_count: number }> {
  // ON CONFLICT precisa bater EXATAMENTE com a expressão do índice parcial
  // `uq_pending_triggers_pending_inbox` (migration 011), que é
  // `WHERE status = 'pending' AND trigger_type = 'inbox'`. Sem `trigger_type`
  // aqui o Postgres rejeita com "no unique or exclusion constraint matching the
  // ON CONFLICT specification" e o webhook não consegue enfileirar.
  const { rows } = await pool.query<{ id: number; msg_count: number }>(
    `INSERT INTO pending_triggers (agent, project, identifier, last_inbox_id, scheduled_at, trigger_type)
     VALUES ($1, $2, $3, $4, $5, 'inbox')
     ON CONFLICT (agent, identifier) WHERE status = 'pending' AND trigger_type = 'inbox'
     DO UPDATE SET
       last_inbox_id = EXCLUDED.last_inbox_id,
       project = COALESCE(EXCLUDED.project, pending_triggers.project),
       scheduled_at = EXCLUDED.scheduled_at,
       msg_count = pending_triggers.msg_count + 1,
       updated_at = NOW()
     RETURNING id, msg_count`,
    [args.agent, args.project, args.identifier, args.inbox_id, args.scheduled_at]
  );
  return rows[0]!;
}

/**
 * Claim atômico de triggers prontos pra disparar. `FOR UPDATE SKIP LOCKED`
 * defende contra múltiplos pollers em paralelo. Empurra `scheduled_at` pra
 * +60s e bumpa `attempt_count` — se o poller crashar antes de marcar fired,
 * o próximo ciclo pega de novo após 60s (zero perda, dedup via flock no
 * mercurio absorve double-fire eventual).
 */
export async function claimDuePendingTriggers(batchSize = 50): Promise<PendingTrigger[]> {
  const { rows } = await pool.query<PendingTrigger>(
    `WITH due AS (
       SELECT id FROM pending_triggers
        WHERE status = 'pending' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE pending_triggers t
        SET attempt_count = t.attempt_count + 1,
            scheduled_at = NOW() + INTERVAL '60 seconds',
            updated_at = NOW()
       FROM due
      WHERE t.id = due.id
      RETURNING t.id, t.agent, t.project, t.identifier, t.last_inbox_id, t.msg_count, t.attempt_count, t.trigger_type, t.payload`,
    [batchSize]
  );
  return rows;
}

export async function markTriggerFired(id: number): Promise<void> {
  await pool.query(
    `UPDATE pending_triggers
        SET status = 'fired', fired_at = NOW(), updated_at = NOW(), last_error = NULL
      WHERE id = $1`,
    [id]
  );
}

/**
 * Marca falha. Se ainda há tentativas disponíveis, devolve a row pra status
 * 'pending' com backoff (30s * attempt, capado em 5min). Senão marca 'failed'.
 */
export async function markTriggerRetryOrFail(
  id: number,
  currentAttempt: number,
  maxAttempts: number,
  error: string
): Promise<{ retried: boolean }> {
  if (currentAttempt >= maxAttempts) {
    await pool.query(
      `UPDATE pending_triggers
          SET status = 'failed', last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [id, error]
    );
    return { retried: false };
  }
  const backoffSec = Math.min(currentAttempt * 30, 300);
  await pool.query(
    `UPDATE pending_triggers
        SET status = 'pending',
            scheduled_at = NOW() + ($2 || ' seconds')::INTERVAL,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [id, String(backoffSec), error]
  );
  return { retried: true };
}

/**
 * Enfileira um trigger de reconcile (mudança detectada via cron em meeting).
 * NÃO usa ON CONFLICT — cada cancel/move é evento próprio, não pode ser absorvido
 * pelo debounce de inbox. Roda dentro da transação aberta pelo caller
 * (handleCancelled / handleMoved em reconcile.ts).
 */
export async function enqueueReconcileTrigger(
  client: PoolClient,
  args: {
    agent: string;
    project: string;
    identifier: string;
    payload: MeetingReconcilePayload;
    scheduled_at?: Date;
  }
): Promise<{ id: number }> {
  const scheduledAt = args.scheduled_at ?? new Date();
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO pending_triggers (agent, project, identifier, last_inbox_id, scheduled_at, trigger_type, payload, msg_count)
     VALUES ($1, $2, $3, NULL, $4, 'meeting_reconcile', $5, 0)
     RETURNING id`,
    [args.agent, args.project, args.identifier, scheduledAt, args.payload]
  );
  return rows[0]!;
}

export async function insertLlmMetric(args: {
  agent: string;
  message_id?: number | null;
  task: string;
  provider: string;
  model: string;
  tier?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
  cache_hit?: boolean;
  fallback_used?: boolean;
  error?: string | null;
}): Promise<{ id: number }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO llm_metrics
       (agent, message_id, task, provider, model, tier,
        tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
        cost_usd, latency_ms, cache_hit, fallback_used, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      args.agent,
      args.message_id ?? null,
      args.task,
      args.provider,
      args.model,
      args.tier ?? null,
      args.tokens_in ?? null,
      args.tokens_out ?? null,
      args.cache_read_tokens ?? null,
      args.cache_write_tokens ?? null,
      args.cost_usd ?? null,
      args.latency_ms ?? null,
      args.cache_hit ?? false,
      args.fallback_used ?? false,
      args.error ?? null,
    ]
  );
  return { id: rows[0]!.id };
}
