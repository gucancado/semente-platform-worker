/**
 * src/openai-health/service.ts
 *
 * Sonda periódica da conta OpenAI + estado persistido em `openai_health` (mig
 * 071). Persistido, e não em memória, por dois motivos: o deploy não pode
 * reavisar "sem crédito" a cada container novo, e o poller de coleta precisa
 * saber se a conta caiu DURANTE uma reunião que começou antes do boot.
 */
import type { Pool } from 'pg';
import { classifyProbe, silentWav, transitionOf, DOWN_NOTICE, UP_NOTICE, type HealthState } from './core.js';

export type OpenAIHealth = { state: HealthState; since: Date; lastDownAt: Date | null; checkedAt: Date | null };

export async function getOpenAIHealth(pool: Pool): Promise<OpenAIHealth> {
  const r = await pool.query<{ state: HealthState; since: Date; last_down_at: Date | null; checked_at: Date | null }>(
    `SELECT state, since, last_down_at, checked_at FROM openai_health WHERE id = 1`,
  );
  const row = r.rows[0];
  if (!row) return { state: 'unknown', since: new Date(0), lastDownAt: null, checkedAt: null };
  return { state: row.state, since: row.since, lastDownAt: row.last_down_at, checkedAt: row.checked_at };
}

export type ProbeFn = () => Promise<{ status: number | null; body: string }>;

/** Sonda real: 1 s de silêncio na rota de transcrição (a mesma da Vexa). */
export function makeOpenAIProbe(apiKey: string, model = 'whisper-1'): ProbeFn {
  return async () => {
    const fd = new FormData();
    fd.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'probe.wav');
    fd.append('model', model);
    try {
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: r.status, body: (await r.text()).slice(0, 500) };
    } catch (err) {
      return { status: null, body: (err as Error).message };
    }
  };
}

export type HealthTickDeps = {
  pool: Pool;
  probe: ProbeFn;
  notify: (n: { titulo: string; detalhe: string }) => Promise<void>;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
};

/**
 * Uma rodada: sonda, grava, avisa na transição. A escrita é condicionada ao
 * estado lido (`state = $prev`) para dois containers no rolling deploy não
 * avisarem a mesma queda duas vezes — só quem efetivamente trocou o estado avisa.
 */
export async function runHealthTick(deps: HealthTickDeps): Promise<HealthState> {
  const prev = await getOpenAIHealth(deps.pool);
  const res = await deps.probe();
  const next = classifyProbe(res.status, res.body);
  if (next === 'unknown') {
    await deps.pool.query(`UPDATE openai_health SET checked_at = NOW() WHERE id = 1`);
    deps.log?.warn({ status: res.status, body: res.body.slice(0, 200) }, 'openai-health: sonda inconclusiva');
    return prev.state;
  }
  const t = transitionOf(prev.state, next);
  const upd = await deps.pool.query(
    `UPDATE openai_health
        SET state = $1,
            since = CASE WHEN state = $1 THEN since ELSE NOW() END,
            last_down_at = CASE WHEN $1 = 'down' THEN NOW() ELSE last_down_at END,
            checked_at = NOW(),
            last_error = CASE WHEN $1 = 'down' THEN $3 ELSE NULL END
      WHERE id = 1 AND state = $2`,
    [next, prev.state, `${res.status}: ${res.body.slice(0, 300)}`],
  );
  if (t && (upd.rowCount ?? 0) > 0) {
    deps.log?.[t === 'went_down' ? 'warn' : 'info']({ status: res.status }, `openai-health: ${t}`);
    try {
      await deps.notify(t === 'went_down' ? DOWN_NOTICE : UP_NOTICE);
    } catch (err) {
      deps.log?.warn({ err: (err as Error).message }, 'openai-health: aviso ao operador falhou');
    }
  }
  return next;
}
