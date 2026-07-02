# Task 3 Report — Echo de `context` nas rotas de escrita e provisionamento (worker)

## Status
DONE (implementação + typecheck). DB tests NOT run — no Postgres in this environment.

## Arquivos tocados
- `src/whatsapp/write-routes.ts`
- `src/whatsapp/provision-routes.ts`
- `tests/whatsapp/context-echo.db.test.ts` (append)

## Implementação — write-routes.ts
- Import: `import { tenantContext } from './tenant-context.js';`
- `POST /whatsapp/threads/:identifier/lead` — send final: `context: tenantContext(num)` (reusa `num` já buscado via `getNumber`).
- `POST /whatsapp/threads/bulk-lead` — dois `reply.send` de sucesso ecoam `context: tenantContext(num)`:
  - early-return do subconjunto vazio (`mode === 'partial' && candidates.length === 0`)
  - `base` usado no send final (cobre tanto `mode: 'strict'` quanto `'partial'`, já que `base` é espalhado em ambos)
- `POST /whatsapp/disqualify-reasons` — `context: tenantContext({ workspaceId: workspace_id })` (workspace-only, sem number).
- `POST /whatsapp/disqualify-reasons/:code/deactivate` — idem.
- `POST /whatsapp/source-signals` — idem.
- `POST /whatsapp/source-signals/:pattern/deactivate` — idem.

## Implementação — provision-routes.ts
- Import: `import { tenantContext } from './tenant-context.js';`
- `POST /admin/whatsapp/numbers/:id/sync-groups` — `context: tenantContext(n)` prefixado antes de `...out`, preservando todos os campos originais.
- `POST /admin/whatsapp/numbers/:id/backfill` — `context: tenantContext(n)` prefixado, campos `started/numberId/days/maxPages/sinceTs` preservados intactos.
- `POST /admin/whatsapp/numbers/:id/group-exposure` — `context: tenantContext(n)` prefixado, `id`/`expose_groups_in_mcp` preservados.
- Nenhuma rota 4xx/5xx (`not found`, `deprecated`, etc.) foi tocada — `context` só em sucesso 2xx, como exigido.

## Testes (append em context-echo.db.test.ts)
Adicionados exatamente conforme o brief:
- imports de `registerWriteRoutes`/`registerProvisionRoutes`
- helper `buildWriteApp()` (reusa `pool`/`passAuthz` já existentes no arquivo)
- teste `POST /whatsapp/threads/:id/lead ecoa context derivado do number`
- teste `POST /whatsapp/threads/bulk-lead ecoa context derivado do number`
- helper `buildProvisionApp()` (evolution dummy `{} as any`, webhook dummy)
- teste `POST /admin/whatsapp/numbers/:id/group-exposure ecoa context`

### Desvio do brief (corrigido, não verbatim)
O teste de `group-exposure` no brief tinha `headers: { 'content-type': 'application/json' }` — **sem** `x-panel-token`. `registerProvisionRoutes` registra um hook `preHandler` que exige `x-panel-token` para qualquer rota sob `/admin/whatsapp/` (confirmado contra todos os testes existentes em `provision-routes.test.ts`, que sempre enviam esse header). Sem ele, a request cairia em 401 antes mesmo de chegar na rota — um bug de auth no teste, não relacionado ao echo de `context`. Corrigido para `headers: { 'x-panel-token': 'test-panel', 'content-type': 'application/json' }`. Sinalizando explicitamente essa mudança em relação ao texto literal do brief.

Não foram testados por inject: `backfill` e `sync-groups` (disparam chamadas reais/pendentes ao Evolution) — conforme instrução do brief, validados só por typecheck + revisão manual do diff (ver acima, campos preservados).

## Typecheck
`npm run typecheck` (tsc --noEmit) → saída vazia, exit 0, sem erros novos.

## DB tests — NÃO EXECUTADOS
Ambiente sem Postgres disponível. Os testes em `tests/whatsapp/context-echo.db.test.ts` (incluindo os 3 novos) requerem banco real (TRUNCATE, INSERT, embedded-postgres) e não puderam ser rodados aqui. Ficam pendentes de execução pelo controller (ex.: harness `scratchpad/pgtest/run2.mjs` documentado na memória do projeto, ou suíte no servidor).

## Self-review
- Todos os 8 pontos de edição do brief foram aplicados palavra-por-palavra (exceto o fix de header no teste de group-exposure, documentado acima).
- Confirmado por `git diff` que nenhum `reply.code(4xx/5xx).send()` foi tocado.
- `bulk-lead`: os DOIS sends de sucesso (early-return vazio + `base`) usam `tenantContext(num)` — o `num` é o mesmo objeto buscado uma única vez via `getNumber`, então ambos os pontos refletem o mesmo tenant.
- `backfill`/`sync-groups`: todos os campos pré-existentes no `reply.send` foram preservados; só `context` foi prefixado logo após `schema`.
- Nenhuma rota nova de importação de `tenant-context.js` conflita com imports já existentes.

## Concerns
- DB tests não executados (sem Postgres) — pendente de validação pelo controller antes de considerar a task fechada com PASS real.
- Um desvio do texto literal do brief foi necessário (header `x-panel-token` faltando no teste de group-exposure); ver seção "Desvio do brief" acima para justificativa.
