# WhatsApp Tenant-Context Echo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer cada resposta de sucesso das rotas/tools `whatsapp_*` ecoar a qual tenant pertence, via um bloco `context: { workspaceId, number: { id, label, phone } | null }` no topo do envelope `whatsapp_v1`.

**Architecture:** O **worker** é a fonte da verdade: um helper puro `tenantContext()` monta o bloco e cada `reply.send({ schema:'whatsapp_v1', ... })` das rotas WhatsApp passa a incluir `context`. O **bloquim-mcp** herda `context` por passthrough (`textResult(data)`) em 11 das 12 tools; a exceção é o short-circuit local `groups_not_exposed` (export/thread_messages), que injeta `context` manualmente via um helper espelho.

**Tech Stack:** Fastify + pg (worker, ESM, `node --test --import tsx`); Hono + axios + zod (bloquim-mcp, ESM, `node --test --import tsx`). Testes do worker rodam contra Postgres efêmero/real via `src/db.js` `pool` + `app.inject`.

## Global Constraints

- **Envelope:** todo `reply.send` de sucesso (2xx) das rotas WhatsApp deve manter `schema: 'whatsapp_v1'` e adicionar `context`. Respostas de erro (4xx/5xx) **não** carregam `context`.
- **Formato do bloco:** `context: { workspaceId: string, number: { id: number; label: string | null; phone: string | null } | null }`. Uma vez por envelope (nunca por item).
- **Guard anti-leak (rotas workspace-scoped `/threads`, `/search`, `/stats`):** `context.number` só é preenchido se `getNumber(number_id).workspaceId === workspace_id` validado; senão `null`.
- **Autoridade do `workspaceId`:** rotas number-derived (`/messages`, `/export`, `/lead`, `/bulk-lead`, `/group-exposure`, `/backfill`) usam `num.workspaceId`; rotas workspace-scoped usam o `workspace_id` já validado pelo gate.
- **Campos do number:** os 3 (`id`, `label`, `phone`) — decisão do owner. `label`/`phone` podem ser `null`.
- **Sem migração de DB.** Sem mudança de authz. Sem estado de "workspace atual".
- **FORA DE ESCOPO — `src/mcp/tools.ts` (MCP do próprio worker).** As tools baked-in do worker (`whatsapp_list_numbers`/`whatsapp_list_threads`/`whatsapp_thread_messages`, consumidas pelo agente mercúrio) também retornam `schema: 'whatsapp_v1'`, mas são uma superfície **agent-facing e single-tenant por agente** (cada instância opera 1 projeto) — o problema de confusão multi-tenant não se aplica, e o não-objetivo da spec proíbe reintroduzir/alterar tools WhatsApp no MCP do worker. **Não tocar.** Follow-up trivial se um dia quiser uniformizar.
- **Commits frequentes**, mensagens em pt-BR, terminando com `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Runner de testes (worker):** o repo usa `node --test --import tsx <arquivo>`. Os arquivos `*.db.test.ts` (incl. `context-echo.db.test.ts`) precisam de **Postgres** — não há banco de teste local por padrão; usar o harness de Postgres efêmero descrito na memory `reference-rodar-suite-worker-postgres-efemero` (embedded-postgres isolado por arquivo, dummies de env, drop/create/migrate). O `tenant-context.test.ts` (puro) roda sem DB. Substituir `npx tsx --test <arquivo>` por `node --test --import tsx <arquivo>` se a primeira forma não pegar o tsx.

---

## File Structure

**Worker (`c:/Users/gusta/Projetos/semente-platform-worker`):**
- Create: `src/whatsapp/tenant-context.ts` — helper puro `tenantContext()` + tipo `TenantContext`.
- Create: `tests/whatsapp/tenant-context.test.ts` — unit test puro do helper.
- Modify: `src/whatsapp/read-routes.ts` — injeta `context` em numbers/threads/stats/messages/search/disqualify-reasons/source-signals/export/audit.
- Modify: `src/whatsapp/write-routes.ts` — injeta `context` em lead/bulk-lead/disqualify-reasons POST/source-signals POST.
- Modify: `src/whatsapp/provision-routes.ts` — injeta `context` em group-exposure/backfill/sync-groups.
- Test: `tests/whatsapp/context-echo.db.test.ts` (novo) — cobre o echo por rota (read+write+provision).

**MCP (`c:/Users/gusta/Projetos/bloquim-mcp`):**
- Modify: `src/tools/_whatsapp_shared.ts` — `resolveNumber` passa a retornar `{ id, label, phone, workspaceId, exposeGroupsInMcp }`; add `tenantContext()` + `groupsNotExposedResult()`.
- Modify: `src/tools/whatsapp_thread_messages.ts` e `src/tools/whatsapp_export_conversation.ts` — usar `groupsNotExposedResult(...)` no short-circuit.
- Test: `tests/whatsapp-context.test.ts` (novo) — unit puro de `tenantContext`/`groupsNotExposedResult`.

---

## Task 1: Helper `tenantContext` no worker

**Files:**
- Create: `src/whatsapp/tenant-context.ts`
- Test: `tests/whatsapp/tenant-context.test.ts`

**Interfaces:**
- Consumes: `WhatsappNumber` de `src/whatsapp/numbers.js` (tem `id: number`, `workspaceId: string`, `label: string | null`, `phone: string | null`).
- Produces:
  - `type TenantContext = { workspaceId: string; number: { id: number; label: string | null; phone: string | null } | null }`
  - `function tenantContext(input: WhatsappNumber): TenantContext`
  - `function tenantContext(input: { workspaceId: string }): TenantContext`

- [ ] **Step 1: Escrever o teste que falha**

Create `tests/whatsapp/tenant-context.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantContext } from '../../src/whatsapp/tenant-context.js';
import type { WhatsappNumber } from '../../src/whatsapp/numbers.js';

const num: WhatsappNumber = {
  id: 7, workspaceId: 'ws-1', phone: '+5511999998888', evolutionInstance: 'inst',
  label: 'Comercial SP', status: 'connected', mode: 'monitored', exposeGroupsInMcp: false,
  createdBy: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  removedAt: null,
};

test('tenantContext(WhatsappNumber) → workspaceId + number completo', () => {
  assert.deepEqual(tenantContext(num), {
    workspaceId: 'ws-1',
    number: { id: 7, label: 'Comercial SP', phone: '+5511999998888' },
  });
});

test('tenantContext({ workspaceId }) → number null', () => {
  assert.deepEqual(tenantContext({ workspaceId: 'ws-9' }), { workspaceId: 'ws-9', number: null });
});

test('tenantContext preserva label/phone null', () => {
  const n = { ...num, label: null, phone: null };
  assert.deepEqual(tenantContext(n).number, { id: 7, label: null, phone: null });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx tsx --test tests/whatsapp/tenant-context.test.ts`
Expected: FAIL — `Cannot find module '.../tenant-context.js'`.

- [ ] **Step 3: Implementar o helper**

Create `src/whatsapp/tenant-context.ts`:

```ts
import type { WhatsappNumber } from './numbers.js';

export type TenantContext = {
  workspaceId: string;
  number: { id: number; label: string | null; phone: string | null } | null;
};

export function tenantContext(input: WhatsappNumber): TenantContext;
export function tenantContext(input: { workspaceId: string }): TenantContext;
export function tenantContext(input: WhatsappNumber | { workspaceId: string }): TenantContext {
  if ('id' in input) {
    return { workspaceId: input.workspaceId, number: { id: input.id, label: input.label, phone: input.phone } };
  }
  return { workspaceId: input.workspaceId, number: null };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx tsx --test tests/whatsapp/tenant-context.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck` (ou `npx tsc --noEmit`)
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/whatsapp/tenant-context.ts tests/whatsapp/tenant-context.test.ts
git commit -m "feat(whatsapp): helper tenantContext p/ echo de contexto de tenant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Echo de `context` nas rotas de leitura (worker)

**Files:**
- Modify: `src/whatsapp/read-routes.ts`
- Test: `tests/whatsapp/context-echo.db.test.ts` (create)

**Interfaces:**
- Consumes: `tenantContext` (Task 1); `getNumber(pool, id)` de `./numbers.js` (já importado em `read-routes.ts`).
- Produces: cada `reply.send` de sucesso das rotas de leitura inclui `context`.

**Padrão de guard (workspace-scoped: threads/search/stats-com-número):**
```ts
const numForCtx = await getNumber(deps.pool, Number(number_id));
const ctx = numForCtx && numForCtx.workspaceId === workspace_id
  ? tenantContext(numForCtx)
  : tenantContext({ workspaceId: workspace_id });
```
**Padrão number-derived (messages/export): reusar o `num` já buscado → `tenantContext(num)`.**
**Padrão workspace-only (numbers/disqualify-reasons/source-signals/audit/stats-sem-número): `tenantContext({ workspaceId: workspace_id })`.**

- [ ] **Step 1: Escrever os testes que falham**

Create `tests/whatsapp/context-echo.db.test.ts`:

```ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';

const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
function buildApp() {
  const app = Fastify();
  registerReadRoutes(app, { pool, panelToken: 'test-panel', authz: passAuthz });
  return app;
}
const H = { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' };

async function seedNumber(ws: string, instance: string, label: string | null, phone: string | null) {
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, label, phone, status) VALUES ($1,$2,$3,$4,'connected')`,
    [ws, instance, label, phone],
  );
  const { rows: [{ id }] } = await pool.query<{ id: number }>(`SELECT id FROM whatsapp_numbers WHERE evolution_instance = $1`, [instance]);
  return id as number;
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages, whatsapp_thread_meta RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('/whatsapp/numbers ecoa context workspace-only (number null)', async () => {
  await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: '/whatsapp/numbers?workspace_id=ws-1', headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: null });
});

test('/whatsapp/threads ecoa context com number {id,label,phone}', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Comercial SP', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/threads?workspace_id=ws-1&number_id=${id}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Comercial SP', phone: '+5511900000001' } });
});

test('/whatsapp/threads: number de OUTRO workspace → number null (anti-leak)', async () => {
  await seedNumber('ws-1', 'i1', 'A', '+5511900000001');
  const idB = await seedNumber('ws-2', 'i2', 'SecretoB', '+5511900000002');
  // membro de ws-1 passa number_id de ws-2 (gate fake passa; SQL filtra vazio)
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/threads?workspace_id=ws-1&number_id=${idB}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: null });
  assert.deepEqual(res.json().threads, []);
});

test('/whatsapp/search ecoa context com number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/search?workspace_id=ws-1&number_id=${id}&query=oi`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});

test('/whatsapp/stats sem number_id → context workspace-only', async () => {
  await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: '/whatsapp/stats?workspace_id=ws-1', headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: null });
});

test('/whatsapp/stats com number_id → context com number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/stats?workspace_id=ws-1&number_id=${id}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});

test('/whatsapp/threads/:id/messages ecoa context derivado do number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,'ws-1','whatsapp','+5511988887777','inbound','oi', NOW())`, [id]);
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/threads/${encodeURIComponent('+5511988887777')}/messages?number_id=${id}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});

test('erro 400 (number_id não-numérico) NÃO carrega context', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/whatsapp/threads?workspace_id=ws-1&number_id=abc', headers: H });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().context, undefined);
});

test('/whatsapp/disqualify-reasons e /source-signals ecoam context workspace-only', async () => {
  await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const dr = await buildApp().inject({ method: 'GET', url: '/whatsapp/disqualify-reasons?workspace_id=ws-1', headers: H });
  assert.deepEqual(dr.json().context, { workspaceId: 'ws-1', number: null });
  const ss = await buildApp().inject({ method: 'GET', url: '/whatsapp/source-signals?workspace_id=ws-1', headers: H });
  assert.deepEqual(ss.json().context, { workspaceId: 'ws-1', number: null });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test tests/whatsapp/context-echo.db.test.ts`
Expected: FAIL — `context` é `undefined` nas asserções (rotas ainda não ecoam).

- [ ] **Step 3: Implementar o echo em `read-routes.ts`**

No topo, adicionar o import:
```ts
import { tenantContext } from './tenant-context.js';
```

Em `/whatsapp/numbers` — trocar o `reply.send` final:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: ws }), numbers });
```

Em `/whatsapp/threads` — antes do `logAccess`, montar o context com guard e incluir no send:
```ts
    const numForCtx = await getNumber(deps.pool, Number(number_id));
    const ctx = numForCtx && numForCtx.workspaceId === workspace_id
      ? tenantContext(numForCtx) : tenantContext({ workspaceId: workspace_id });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_threads', workspaceId: workspace_id, numberId: Number(number_id) });
    return reply.send({ schema: 'whatsapp_v1', context: ctx, ...result });
```

Em `/whatsapp/stats` — number_id opcional:
```ts
    let ctx;
    if (number_id !== undefined) {
      const numForCtx = await getNumber(deps.pool, Number(number_id));
      ctx = numForCtx && numForCtx.workspaceId === workspace_id
        ? tenantContext(numForCtx) : tenantContext({ workspaceId: workspace_id });
    } else {
      ctx = tenantContext({ workspaceId: workspace_id });
    }
    // ...logAccess inalterado...
    return reply.send({ schema: 'whatsapp_v1', context: ctx, ...stats });
```

Em `/whatsapp/threads/:identifier/messages` — reusar `num` (já buscado via getNumber):
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ...result });
```

Em `/whatsapp/search` — mesmo guard das threads:
```ts
    const numForCtx = await getNumber(deps.pool, Number(number_id));
    const ctx = numForCtx && numForCtx.workspaceId === workspace_id
      ? tenantContext(numForCtx) : tenantContext({ workspaceId: workspace_id });
    logAccess(deps.pool, { actor: req.actingUser, action: 'search', workspaceId: workspace_id, numberId: Number(number_id), meta: { query, count: result.results.length } });
    return reply.send({ schema: 'whatsapp_v1', context: ctx, ...result });
```

Em `/whatsapp/disqualify-reasons`:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), reasons });
```

Em `/whatsapp/source-signals`:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), signals });
```

Em `/whatsapp/threads/:identifier/export` — reusar `num`:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ...out });
```

Em `/whatsapp/audit` — workspace-only (sempre number null):
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ...result });
```

- [ ] **Step 4: Rodar o teste novo e confirmar que passa**

Run: `npx tsx --test tests/whatsapp/context-echo.db.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Rodar a suíte de read-routes p/ garantir zero regressão**

Run: `npx tsx --test tests/whatsapp/read-routes.test.ts tests/whatsapp/read-routes-search-export.db.test.ts tests/whatsapp/stats-routes.test.ts tests/whatsapp/read-routes.period.test.ts`
Expected: PASS (nenhuma quebra — o campo `context` é aditivo).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add src/whatsapp/read-routes.ts tests/whatsapp/context-echo.db.test.ts
git commit -m "feat(whatsapp): rotas de leitura ecoam context de tenant no envelope (guard anti-leak em workspace-scoped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Echo de `context` nas rotas de escrita e provisionamento (worker)

**Files:**
- Modify: `src/whatsapp/write-routes.ts`
- Modify: `src/whatsapp/provision-routes.ts`
- Test: `tests/whatsapp/context-echo.db.test.ts` (append)

**Interfaces:**
- Consumes: `tenantContext` (Task 1); `getNumber` (já importado em ambos os arquivos); em `write-routes.ts` as rotas `lead`/`bulk-lead` já têm `num` buscado; `group-exposure`/`backfill` em `provision-routes.ts` já têm `n`.
- Produces: `reply.send` de sucesso de lead/bulk-lead/group-exposure/backfill/reasons-POST/signals-POST inclui `context`.

- [ ] **Step 1: Escrever os testes que falham (append em context-echo.db.test.ts)**

Adicionar ao mesmo arquivo (novo bloco com registro das rotas de escrita/provisionamento):

```ts
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';

function buildWriteApp() {
  const app = Fastify();
  registerWriteRoutes(app, { pool, panelToken: 'test-panel', authz: passAuthz });
  return app;
}

test('POST /whatsapp/threads/:id/lead ecoa context derivado do number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,'ws-1','whatsapp','+5511988887777','inbound','oi', NOW())`, [id]);
  const res = await buildWriteApp().inject({
    method: 'POST', url: `/whatsapp/threads/${encodeURIComponent('+5511988887777')}/lead`,
    headers: { ...H, 'content-type': 'application/json' },
    payload: { number_id: id, status: 'lead' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
  assert.equal(res.json().ok, true);
});

test('POST /whatsapp/threads/bulk-lead ecoa context derivado do number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,'ws-1','whatsapp','+5511988887777','inbound','oi', NOW())`, [id]);
  const res = await buildWriteApp().inject({
    method: 'POST', url: '/whatsapp/threads/bulk-lead',
    headers: { ...H, 'content-type': 'application/json' },
    payload: { number_id: id, updates: [{ identifier: '+5511988887777', status: 'lead' }] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});
```

> Nota: `registerProvisionRoutes(app, { pool, evolution, panelToken, webhook })` exige `evolution` e `webhook`. A rota `group-exposure` **não** toca o Evolution (só `getNumber` + `setGroupExposure(pool)`), então dá pra testá-la passando deps dummy. Já `backfill`/`sync-groups` disparam chamadas ao Evolution — **não** testar por inject (ficariam pendentes/erro de rede); validar só por typecheck + revisão do diff. Teste de group-exposure abaixo.

```ts
function buildProvisionApp() {
  const app = Fastify();
  registerProvisionRoutes(app, {
    pool,
    evolution: {} as any,           // group-exposure não usa evolution
    panelToken: 'test-panel',
    webhook: { url: 'http://x', secret: 's' },
  });
  return app;
}

test('POST /admin/whatsapp/numbers/:id/group-exposure ecoa context', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildProvisionApp().inject({
    method: 'POST', url: `/admin/whatsapp/numbers/${id}/group-exposure`,
    headers: { 'content-type': 'application/json' },
    payload: { expose: true },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
  assert.equal(res.json().expose_groups_in_mcp, true);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test tests/whatsapp/context-echo.db.test.ts`
Expected: FAIL nos 2 testes novos (`context` undefined).

- [ ] **Step 3: Implementar o echo**

`write-routes.ts` — import no topo:
```ts
import { tenantContext } from './tenant-context.js';
```

Rota `POST /whatsapp/threads/:identifier/lead` — trocar o send final:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ok: true, identifier: req.params.identifier, leadStatus: status });
```

Rota `POST /whatsapp/threads/bulk-lead` — incluir `context` no `base` e no early-return do subconjunto vazio (ambos têm `num`):
```ts
    // early-return do subconjunto vazio (mode partial):
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ok: true, mode: 'partial', updated: 0, identifiers: [], skipped });
    // ...
    // send final:
    const base = { schema: 'whatsapp_v1', context: tenantContext(num), ok: true, updated: result.updated, identifiers: result.identifiers };
    return reply.send(mode === 'partial' ? { ...base, mode: 'partial', skipped } : base);
```

Rotas `POST /whatsapp/disqualify-reasons`, `.../:code/deactivate`, `POST /whatsapp/source-signals`, `.../:pattern/deactivate` — workspace-only:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ok: true, reactivated }); // disqualify-reasons POST
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ok: true });             // deactivates
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ok: true });             // source-signals POST
```

`provision-routes.ts` — import no topo:
```ts
import { tenantContext } from './tenant-context.js';
```
Rota `POST /admin/whatsapp/numbers/:id/group-exposure` — reusar `n`:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(n), id: n.id, expose_groups_in_mcp: expose });
```
Rota `POST /admin/whatsapp/numbers/:id/backfill` (`provision-routes.ts:133`, tem `n`) — reusar `n`, preservando os campos exatos:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(n), started: true, numberId: n.id, days, maxPages, sinceTs });
```

Rota `POST /admin/whatsapp/numbers/:id/sync-groups` (`provision-routes.ts:125`, tem `n`, retorna `{ ...out }`) — reusar `n`:
```ts
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(n), ...out });
```

> Ao editar essas rotas, preserve TODOS os campos que o `reply.send` já retornava — apenas prefixe `context: tenantContext(n),` após `schema`.

- [ ] **Step 4: Rodar o teste novo e confirmar que passa**

Run: `npx tsx --test tests/whatsapp/context-echo.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Rodar suítes de escrita/provisionamento**

Run: `npx tsx --test tests/whatsapp/write-routes.db.test.ts tests/whatsapp/bulk-lead-route-partial.db.test.ts tests/whatsapp/disqualify-reasons.routes.test.ts tests/whatsapp/source-signals-routes.test.ts tests/whatsapp/provision-routes.test.ts`
Expected: PASS (campo aditivo — sem regressão).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add src/whatsapp/write-routes.ts src/whatsapp/provision-routes.ts tests/whatsapp/context-echo.db.test.ts
git commit -m "feat(whatsapp): rotas de escrita e provisionamento ecoam context de tenant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: MCP — `resolveNumber` estendido + `context` no short-circuit `groups_not_exposed`

**Files:**
- Modify: `c:/Users/gusta/Projetos/bloquim-mcp/src/tools/_whatsapp_shared.ts`
- Modify: `c:/Users/gusta/Projetos/bloquim-mcp/src/tools/whatsapp_thread_messages.ts`
- Modify: `c:/Users/gusta/Projetos/bloquim-mcp/src/tools/whatsapp_export_conversation.ts`
- Test: `c:/Users/gusta/Projetos/bloquim-mcp/tests/whatsapp-context.test.ts` (create)

**Interfaces:**
- Consumes: `getWorkerClient()` de `../lib/worker.js` (axios). O `GET /whatsapp/numbers?workspace_id=` retorna `{ numbers: Array<{ id; label; phone; workspaceId; exposeGroupsInMcp }> }` (worker já expõe esses campos por número).
- Produces (em `_whatsapp_shared.ts`):
  - `resolveNumber(workspaceId, numberId): Promise<{ id: number; label: string | null; phone: string | null; workspaceId: string; exposeGroupsInMcp: boolean }>`
  - `type TenantContext = { workspaceId: string; number: { id: number; label: string | null; phone: string | null } | null }`
  - `tenantContext(workspaceId: string, num?: { id: number; label: string | null; phone: string | null } | null): TenantContext`
  - `groupsNotExposedResult(ctx: TenantContext)` → `textResult({ schema: 'whatsapp_v1', context: ctx, error: 'groups_not_exposed' })`

- [ ] **Step 1: Escrever o teste que falha**

Create `tests/whatsapp-context.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantContext, groupsNotExposedResult } from '../src/tools/_whatsapp_shared.js';

test('tenantContext monta bloco com número', () => {
  assert.deepEqual(
    tenantContext('ws-1', { id: 5, label: 'Com', phone: '+5511900000001' }),
    { workspaceId: 'ws-1', number: { id: 5, label: 'Com', phone: '+5511900000001' } },
  );
});

test('tenantContext sem número → number null', () => {
  assert.deepEqual(tenantContext('ws-1'), { workspaceId: 'ws-1', number: null });
});

test('groupsNotExposedResult inclui context + error no envelope whatsapp_v1', () => {
  const r = groupsNotExposedResult(tenantContext('ws-1', { id: 5, label: 'Com', phone: '+5511900000001' }));
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.schema, 'whatsapp_v1');
  assert.equal(payload.error, 'groups_not_exposed');
  assert.deepEqual(payload.context, { workspaceId: 'ws-1', number: { id: 5, label: 'Com', phone: '+5511900000001' } });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run (no repo bloquim-mcp): `npx tsx --test tests/whatsapp-context.test.ts`
Expected: FAIL — `tenantContext`/`groupsNotExposedResult` não exportados.

- [ ] **Step 3: Estender `_whatsapp_shared.ts`**

Substituir `resolveNumber` e adicionar os helpers:

```ts
// src/tools/_whatsapp_shared.ts
import { getWorkerClient, formatWorkerError } from "../lib/worker.js";

export type ResolvedNumber = { id: number; label: string | null; phone: string | null; workspaceId: string; exposeGroupsInMcp: boolean };

// Lê o número do worker e REJEITA se number_id não pertencer ao workspace.
export async function resolveNumber(workspaceId: string, numberId: number): Promise<ResolvedNumber> {
  const { data } = await getWorkerClient().get<{ numbers: Array<{ id: number; label?: string | null; phone?: string | null; workspaceId?: string; exposeGroupsInMcp?: boolean }> }>(
    `/whatsapp/numbers`, { params: { workspace_id: workspaceId } },
  );
  const n = data.numbers.find((x) => x.id === numberId);
  if (!n) throw new Error(`number_id ${numberId} não pertence ao workspace ${workspaceId}.`);
  return {
    id: n.id,
    label: n.label ?? null,
    phone: n.phone ?? null,
    workspaceId: n.workspaceId ?? workspaceId,
    exposeGroupsInMcp: n.exposeGroupsInMcp === true,
  };
}

export type TenantContext = {
  workspaceId: string;
  number: { id: number; label: string | null; phone: string | null } | null;
};

export function tenantContext(workspaceId: string, num?: { id: number; label: string | null; phone: string | null } | null): TenantContext {
  return { workspaceId, number: num ? { id: num.id, label: num.label, phone: num.phone } : null };
}

export function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export function groupsNotExposedResult(ctx: TenantContext) {
  return textResult({ schema: "whatsapp_v1", context: ctx, error: "groups_not_exposed" });
}

export function errResult(prefix: string, err: unknown) {
  return { isError: true as const, content: [{ type: "text" as const, text: `${prefix}: ${formatWorkerError(err)}` }] };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx tsx --test tests/whatsapp-context.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Wire nas tools do short-circuit**

`whatsapp_thread_messages.ts` — usar o número resolvido e o helper:
```ts
    await assertMember(args.workspace_id);
    const num = await resolveNumber(args.workspace_id, args.number_id);
    if (!groupAccessAllowed(isGroupIdentifier(args.identifier), num.exposeGroupsInMcp)) {
      return groupsNotExposedResult(tenantContext(args.workspace_id, num));
    }
```
(atualizar o import: `import { resolveNumber, textResult, errResult, tenantContext, groupsNotExposedResult } from "./_whatsapp_shared.js";`)

`whatsapp_export_conversation.ts` — idem:
```ts
    await assertMember(args.workspace_id);
    const num = await resolveNumber(args.workspace_id, args.number_id);
    if (!groupAccessAllowed(isGroupIdentifier(args.identifier), num.exposeGroupsInMcp)) {
      return groupsNotExposedResult(tenantContext(args.workspace_id, num));
    }
```

> Verificar os demais consumidores de `resolveNumber` (`whatsapp_list_threads.ts`, `whatsapp_search.ts`, `whatsapp_set_group_exposure.ts`, `whatsapp_set_lead_status.ts`, `whatsapp_set_lead_status_bulk.ts`, `whatsapp_list_disqualify_reasons.ts`, `whatsapp_list_source_signals.ts`): hoje fazem `(await resolveNumber(...)).exposeGroupsInMcp` ou `await resolveNumber(...)` só pra validar. O novo retorno é um superset — **nenhum quebra**. Confirmar por typecheck.

- [ ] **Step 6: Rodar toda a suíte do MCP + typecheck**

Run: `npm test` (roda `node --import tsx --test tests/*.test.ts`)
Then: `npm run typecheck` (ou `npx tsc --noEmit`)
Expected: PASS; sem erros de tipo.

- [ ] **Step 7: Commit**

```bash
git add src/tools/_whatsapp_shared.ts src/tools/whatsapp_thread_messages.ts src/tools/whatsapp_export_conversation.ts tests/whatsapp-context.test.ts
git commit -m "feat(whatsapp): resolveNumber carrega label/phone; short-circuit groups_not_exposed injeta context

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Verificação integrada + build dos dois repos

**Files:** nenhum (gate de verificação).

- [ ] **Step 1: Worker — suíte WhatsApp completa**

Run: `npx tsx --test tests/whatsapp/*.test.ts`
Expected: PASS (incluindo `tenant-context.test.ts`, `context-echo.db.test.ts`). Se o Postgres efêmero for necessário, usar o harness de `reference-rodar-suite-worker-postgres-efemero` (memory).

- [ ] **Step 2: Worker — build**

Run: `npm run build`
Expected: sucesso.

- [ ] **Step 3: MCP — testes + build**

Run (bloquim-mcp): `npm test && npm run build`
Expected: PASS + build ok.

- [ ] **Step 4: Sanidade do envelope (grep)**

Run (worker): `grep -rn "schema: 'whatsapp_v1'" src/whatsapp/*.ts`
Expected: cada `reply.send` de sucesso listado tem `context:` na mesma chamada. Conferir manualmente que nenhum ficou sem.

- [ ] **Step 5: Commit (se houver ajuste)**

```bash
git add -A && git commit -m "test(whatsapp): verificação integrada do echo de context (worker + mcp)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deploy (pós-aprovação da execução)

1. **Worker:** merge do branch `feat/whatsapp-tenant-context-echo` → `master`; deploy manual:
   `COOLIFY_TOKEN=<bearer> pnpm deploy` (uuid `qlp2n4fi3jlklisftet1y7cz`; polling até `finished`). Migrations: **nenhuma** neste ticket.
2. **MCP (bloquim-mcp):** deploy via Coolify API `POST /api/v1/deploy?uuid=ohimzhcb5pafkwusy1ff3lsz` (Bearer do CLAUDE.md). Após deploy, **recarregar o conector bloquim** no Claude para as tools refletirem.
3. **Smoke prod:** chamar `whatsapp_list_threads` e `whatsapp_stats` em 2 workspaces distintos e confirmar `context.workspaceId`/`context.number` corretos em cada resposta; chamar `whatsapp_thread_messages` com identifier de grupo num número sem exposição e confirmar `context` + `error: groups_not_exposed`.

---

## Self-Review (preenchido)

**Spec coverage:** §2 escopo → Tasks 2/3/4; §3 decisões (2xx-only, guard anti-leak, phone, number:null, audit) → Tasks 2/3 (guard testado explicitamente) + Global Constraints; §4.1 helper → Task 1; §4.2 tabela de rotas → Tasks 2/3 (todas as rotas cobertas, incl. backfill); §4.3 MCP short-circuit → Task 4; §5 testes → Tasks 1-5 (inclui teste 2xx-only e ajuste de asserções — verificado que não há match de envelope inteiro nos testes atuais, risco nulo); §7 aceite → Task 5.

**Placeholder scan:** sem TBD/TODO. O único ponto condicional (teste de group-exposure/backfill no MCP-less provision app) está explicitado com instrução de decisão + fallback (typecheck + review), não é placeholder.

**Type consistency:** `tenantContext` no worker é overload `(WhatsappNumber) | ({workspaceId})`; no MCP é `(workspaceId, num?)` — assinaturas diferentes DE PROPÓSITO (contextos diferentes), documentadas em cada Interfaces. `ResolvedNumber` (MCP) é superset do retorno antigo `{id, exposeGroupsInMcp}` → consumidores atuais compatíveis. `TenantContext` shape idêntico nos dois repos.
