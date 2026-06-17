import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';

// node-postgres emite 'error' em clientes ociosos quando o backend encerra a
// conexão (timeout, restart, idle-in-transaction, rede). SEM listener, o evento
// é não-tratado e DERRUBA o processo (crash do worker/bootstrap → transações
// zumbis com locks). O pool DEVE registrar um handler de erro.

test('o pool pg tem um handler de erro (nao derruba o processo em conexao ociosa)', () => {
  assert.ok(
    pool.listenerCount('error') >= 1,
    'pool.on("error") ausente — erro de conexao ociosa derrubaria o processo'
  );
});

test('o pool anexa handler de erro em cada cliente (cobre conexao EM USO na TX)', () => {
  // pool.on('connect', client => client.on('error', ...)) garante que um cliente
  // checked-out cuja conexao cai mid-transacao nao emita um 'error' nao-tratado.
  assert.ok(
    pool.listenerCount('connect') >= 1,
    'pool.on("connect") ausente — erro em cliente EM USO derrubaria o processo'
  );
});
