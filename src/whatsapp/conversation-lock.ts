import type { Pool, PoolClient } from 'pg';

/**
 * Serializa toda mutação de uma conversa (spec §4.11) sob um advisory lock
 * transacional por par (número, identifier). Duas ações concorrentes na mesma
 * conversa esperam a fila; conversas distintas não bloqueiam entre si.
 *
 * BEGIN → pg_advisory_xact_lock(hashtext($1)) com $1 = `${numberId}:${identifier}`
 * → fn(client) → COMMIT (ROLLBACK em qualquer throw, relançando o erro original).
 *
 * hashtext devolve int4: há colisão TEXT→int4 teórica (2 pares distintos podem
 * cair na mesma chave e serializar à toa) — aceitável, é só uma perda de
 * paralelismo eventual, nunca de correção (decisão fechada no brief da Task 3).
 * O lock é liberado automaticamente no COMMIT/ROLLBACK (escopo de transação),
 * então um crash mid-transação não deixa lock órfão.
 */
export async function withConversationLock<T>(
  pool: Pool,
  numberId: number,
  identifier: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${numberId}:${identifier}`]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
