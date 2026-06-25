# WhatsApp Backend/MCP Enabler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Habilitar (a) motivos de desqualificação por workspace com CRUD sem migração, (b) `firstInboundText` na tool MCP, e (c) recorte de período em `stats`/`list_threads` — sem quebrar o contrato `whatsapp_v1`.

**Architecture:** Worker Fastify + Postgres (pg) multi-tenant. Migração in-place torna `whatsapp_disqualify_reasons` per-workspace (template global copiado por provisionamento). `getStats`/`listThreads` ganham janela temporal com dois modos. MCP (`bloquim-mcp`) expõe os params novos. Migrations rodam no boot (CMD `node dist/migrate.js`).

**Tech Stack:** TypeScript ESM, Fastify 5, pg 8, node:test contra Postgres real, MCP SDK (`bloquim-mcp`).

## Global Constraints

- Spec canônico: `docs/specs/whatsapp-backend-enabler.spec.md` — o SQL verbatim da migração (§4.1) e os contratos estão lá; siga-os exatamente.
- Contrato de saída sempre `{ schema: 'whatsapp_v1', ... }`.
- Authz: leitura → `gateMember`; escrita → `gateAdmin`. Todo handler chama `logAccess` após o gate.
- Validação DB-backed SEMPRE depois do gate de authz (sem info-leak), padrão já usado em `write-routes.ts`.
- `workspace_id` é UUID sem FK (id cross-service).
- Testes: `node --test` contra Postgres real (sem DB de teste local; rodam no servidor). Padrão em `tests/whatsapp/*.test.ts`. Verificação local mínima: `pnpm typecheck`.
- Migration nova = nº **037** (última aplicada é 035; 036 já existe). Idempotente.
- Commits frequentes, conventional commits PT-BR, co-author trailer do projeto.
- Deploy: migrations aplicam no boot; ordem de rollout worker → bloquim-mcp → recarregar connector.

---

## File Structure

**Worker (`semente-platform-worker`):**
- Create `migrations/037_whatsapp_disqualify_reasons_per_workspace.sql` — migração S2 (§4.1 do spec).
- Create `src/whatsapp/disqualify-reasons.ts` — queries puras (list/upsert/deactivate/seed).
- Modify `src/whatsapp/lead-qualify.ts` — `validateDisqualifyReason(pool, workspaceId, code)`.
- Modify `src/whatsapp/write-routes.ts` — atualizar 2 callers de validação + rotas POST de reasons.
- Modify `src/whatsapp/read-routes.ts` — rota GET reasons + params de período em `/threads` e `/stats`.
- Modify `src/whatsapp/stats.ts` — `getStats` com período + `byTemperature`/`bySource`.
- Modify `src/whatsapp/read-queries.ts` — `listThreads` com período + cursor por `min_created`.
- Modify `src/whatsapp/provision-routes.ts` (ou `numbers.ts`) — seed de reasons no provisionamento.
- Tests: `tests/whatsapp/disqualify-reasons.test.ts`, `migration-037.test.ts`, `stats-period.test.ts`, `list-threads-period.test.ts`, `bulk-lead.authz.test.ts` (estender).

**MCP (`bloquim-mcp`, repo `c:/Users/gusta/Projetos/bloquim-mcp`):**
- Modify a definição das tools whatsapp (`src/tools/*` / `src/mcp/*`) — `whatsapp_list_threads` (+`include_first_inbound`,`since`,`until`,`period_basis`), `whatsapp_stats` (+`since`,`until`,`period_basis`), + 2 tools novas de reasons.

---

## Task 1: Migração 037 — reasons per-workspace

**Files:**
- Create: `migrations/037_whatsapp_disqualify_reasons_per_workspace.sql`
- Test: `tests/whatsapp/migration-037.test.ts`

**Interfaces:**
- Produces: tabela `whatsapp_disqualify_reason_defaults(code,label,sort_order)`; `whatsapp_disqualify_reasons` com PK `(workspace_id, code)` + `active,created_by,created_at`; FK de `thread_meta.disqualify_reason` removida.

- [ ] **Step 1: Escrever o SQL da migração** — copiar verbatim a sequência PASSO 0→8 do spec §4.1 (template + sync + drop FK + drop PK + add cols + backfill duplo + guard de órfão + delete globais + NOT NULL + PK composta). Idempotente.

- [ ] **Step 2: Escrever o teste de migração** em `tests/whatsapp/migration-037.test.ts`:
  - Seed: 1 workspace com número + 1 thread_meta com `disqualify_reason='fora_escopo'`.
  - Aplica a 037 (rodar o SQL via pool).
  - Assert: `whatsapp_disqualify_reasons` tem PK composta; o workspace recebeu os 11 defaults; a referência `fora_escopo` continua válida (existe row `(ws, 'fora_escopo')`).
  - Re-aplica a 037 → não lança (idempotente).
  - Caso órfão: insere thread_meta com `disqualify_reason='inexistente_x'` (sem estar em defaults nem em globais) e verifica que o guard ABORTA (a migração lança). *(Montar num pool isolado/transação que dá rollback.)*

- [ ] **Step 3: Rodar o teste e ver passar** — `node --test tests/whatsapp/migration-037.test.ts` (no servidor/CI com Postgres). Local: `pnpm typecheck`.

- [ ] **Step 4: Commit** — `feat(whatsapp): migration 037 — disqualify_reasons por workspace (template + backfill + guard)`

---

## Task 2: `validateDisqualifyReason` re-escopada + 2 callers

**Files:**
- Modify: `src/whatsapp/lead-qualify.ts`
- Modify: `src/whatsapp/write-routes.ts:48-51` (single) e `:131-146` (bulk batch query)
- Test: `tests/whatsapp/bulk-lead.authz.test.ts` (estender) + caso single

**Interfaces:**
- Produces: `validateDisqualifyReason(pool: Pool, workspaceId: string, code: string): Promise<boolean>`.
- Consumes: `num.workspaceId` (já disponível nos dois handlers).

- [ ] **Step 1: Teste falhando** — um code ativo no workspace B NÃO valida para o workspace A (single e bulk → 400 `invalid disqualifyReason`). Seed: code `x` ativo só em ws B; chamar lead/bulk com number de ws A usando reason `x`.

- [ ] **Step 2: Rodar e ver falhar** (hoje passa indevidamente, pois a validação é global).

- [ ] **Step 3: Implementar** — assinatura nova em `lead-qualify.ts` (`WHERE workspace_id=$1 AND code=$2 AND active=TRUE`); atualizar caller single (`validateDisqualifyReason(deps.pool, num.workspaceId, disqualifyReason)`) e a batch query do bulk (`SELECT code FROM whatsapp_disqualify_reasons WHERE code = ANY($1::text[]) AND active=TRUE AND workspace_id = $2`, params `[reasons, num.workspaceId]`).

- [ ] **Step 4: Rodar e ver passar.** Local `pnpm typecheck`.

- [ ] **Step 5: Commit** — `fix(whatsapp): valida disqualifyReason por workspace (anti-vazamento single+bulk)`

---

## Task 3: Módulo `disqualify-reasons.ts` (queries puras)

**Files:**
- Create: `src/whatsapp/disqualify-reasons.ts`
- Test: `tests/whatsapp/disqualify-reasons.test.ts`

**Interfaces:**
- Produces:
  - `listDisqualifyReasons(pool, { workspaceId, includeInactive }): Promise<{code,label,active,sortOrder}[]>`
  - `upsertDisqualifyReason(pool, { workspaceId, code, label, createdBy }): Promise<{ reactivated: boolean }>`
  - `deactivateDisqualifyReason(pool, { workspaceId, code }): Promise<void>`
  - `seedDefaultReasons(pool, workspaceId): Promise<void>` (usado no provisionamento)

- [ ] **Step 1: Testes falhando** — list só ativos por default / todos com includeInactive, ordenado por sort_order; upsert cria (reactivated=false), depois deactivate, depois upsert mesmo code → reactivated=true; seedDefaultReasons idempotente (2ª chamada não duplica).

- [ ] **Step 2: Rodar e ver falhar** (módulo não existe).

- [ ] **Step 3: Implementar** as 4 funções. `upsert` usa `INSERT ... ON CONFLICT (workspace_id, code) DO UPDATE SET label=EXCLUDED.label, active=TRUE RETURNING (xmax<>0) AS existed` e detecta reativação comparando estado anterior (ou `RETURNING` do active antigo via CTE). `seedDefaultReasons` = o INSERT idempotente do spec §4.2.

- [ ] **Step 4: Rodar e ver passar.**

- [ ] **Step 5: Commit** — `feat(whatsapp): módulo disqualify-reasons (list/upsert/deactivate/seed)`

---

## Task 4: Rotas REST de reasons (GET/POST/deactivate)

**Files:**
- Modify: `src/whatsapp/read-routes.ts` (GET) e `src/whatsapp/write-routes.ts` (POST + deactivate)
- Test: `tests/whatsapp/disqualify-reasons.routes.test.ts`

**Interfaces:**
- Consumes: funções da Task 3; `gateMember`/`gateAdmin`/`logAccess`/`requirePanelToken`.
- Produces: `GET /whatsapp/disqualify-reasons`, `POST /whatsapp/disqualify-reasons`, `POST /whatsapp/disqualify-reasons/:code/deactivate`.

- [ ] **Step 1: Testes falhando** — GET (membro) lista; não-membro → 403. POST (admin) cria + `reactivated` no body; não-admin → 403. deactivate (admin) soft. Todos logam acesso (asserir via spy/fake `logAccess`, padrão dos testes de authz existentes).

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** as 3 rotas seguindo o padrão de `read-routes.ts`/`write-routes.ts` (validar workspace_id; gate; chamar a função; `logAccess` com a ação; `reply.send({schema:'whatsapp_v1',...})`). Normalizar `code` (`/^[a-z0-9_]+$/`, 400 se inválido).

- [ ] **Step 4: Rodar e ver passar.** `pnpm typecheck`.

- [ ] **Step 5: Commit** — `feat(whatsapp): rotas REST de disqualify-reasons (membro/admin + audit)`

---

## Task 5: Seed de reasons no provisionamento

**Files:**
- Modify: `src/whatsapp/provision-routes.ts` (ou onde `createEvolutionInstance`/criação de número roda)
- Test: estender o teste de provisionamento existente OU `tests/whatsapp/provision-seed-reasons.test.ts`

**Interfaces:**
- Consumes: `seedDefaultReasons` (Task 3).

- [ ] **Step 1: Teste falhando** — provisionar 1º número de um workspace novo → workspace fica com os 11 defaults. Provisionar 2º número → sem duplicar (idempotente).

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** — chamar `await seedDefaultReasons(pool, workspaceId)` no fluxo de criação de número (após o número existir, dentro da mesma transação se houver).

- [ ] **Step 4: Rodar e ver passar.**

- [ ] **Step 5: Commit** — `feat(whatsapp): semeia disqualify-reasons default ao provisionar número`

---

## Task 6: `getStats` com período + byTemperature/bySource

**Files:**
- Modify: `src/whatsapp/stats.ts`
- Test: `tests/whatsapp/stats-period.test.ts`

**Interfaces:**
- Produces: `getStats(pool, { workspaceId, numberId?, since?, until?, periodBasis?: 'arrival'|'activity' })`; `Stats` ganha `byTemperature: Record<string,number>` e `bySource: Record<string,number>`.

- [ ] **Step 1: Testes falhando** — seed com threads de datas distintas. `arrival` numa janela conta só threads cuja 1ª msg ∈ janela; `activity` conta threads com qualquer msg na janela; sem janela = total atual. `byTemperature`/`bySource` somam (incl. bucket `null`). Workspace vazio → zero-fill. `byIngestSource` permanece nível-mensagem (documentado).

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** — CTE base `threads_in_period` (por thread: `MIN(created_at)` + flag de atividade; materializa `identifier` no período conforme `periodBasis`); os queries por-thread filtram por esse conjunto. Adicionar queries `byTemperature` e `bySource` (espelho de `byStage`). Manter `byIngestSource` nível-mensagem, filtrando msgs pela janela; documentar no tipo `Stats`.

- [ ] **Step 4: Rodar e ver passar.** `pnpm typecheck`.

- [ ] **Step 5: Commit** — `feat(whatsapp): stats com período (arrival/activity) + byTemperature/bySource`

---

## Task 7: `listThreads` com período + cursor por min_created

**Files:**
- Modify: `src/whatsapp/read-queries.ts` (`listThreads`)
- Test: `tests/whatsapp/list-threads-period.test.ts`

**Interfaces:**
- Produces: `listThreads(pool, { ..., since?, until?, periodBasis?: 'arrival'|'activity' })`.

- [ ] **Step 1: Testes falhando** — `arrival`: thread com 1ª msg fora da janela mas última dentro NÃO aparece; paginação estável (cursor por `min_created`, sem vazar threads fora da janela na 2ª página). `activity`: aparece se qualquer msg na janela. Sem janela = atual.

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** — na CTE `agg`, expor `MIN(m.created_at) AS min_created`; filtro de janela conforme `periodBasis`. Quando `arrival`: `ORDER BY min_created DESC, identifier ASC` e cursor encapsula `{minCreated, identifier}`; quando `activity`/sem-janela: manter `last_at`. Atualizar encode/decode do cursor pra carregar a chave certa conforme o modo.

- [ ] **Step 4: Rodar e ver passar.** `pnpm typecheck`.

- [ ] **Step 5: Commit** — `feat(whatsapp): listThreads com período + cursor coerente (arrival)`

---

## Task 8: Plumbing das rotas /stats e /threads (período)

**Files:**
- Modify: `src/whatsapp/read-routes.ts` (`/whatsapp/stats`, `/whatsapp/threads`)
- Test: `tests/whatsapp/read-routes.period.test.ts`

**Interfaces:**
- Consumes: `getStats`/`listThreads` (Tasks 6/7).

- [ ] **Step 1: Testes falhando** — rotas aceitam `since`/`until`/`period_basis` e repassam; `period_basis` inválido → 400; default `arrival`.

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** — ler `since`,`until`,`period_basis` do query; validar `period_basis ∈ {arrival,activity}` (senão 400); passar pros services. `emptyToUndefined` em since/until.

- [ ] **Step 4: Rodar e ver passar.** `pnpm typecheck`.

- [ ] **Step 5: Commit** — `feat(whatsapp): período (since/until/period_basis) nas rotas stats e threads`

---

## Task 9: MCP `whatsapp_list_threads` — include_first_inbound + período

**Files:**
- Modify: tool `whatsapp_list_threads` em `bloquim-mcp` (`src/tools/` ou `src/mcp/`)
- Test: conforme padrão de testes do `bloquim-mcp` (se houver) + smoke manual

**Interfaces:**
- Consumes: rota worker `/whatsapp/threads` (já aceita os params).

- [ ] **Step 1:** adicionar ao schema da tool: `include_first_inbound` (boolean, opt-in), `since`, `until`, `period_basis` (enum `arrival|activity`). Atualizar descrição (opt-in firstInbound p/ triagem sem abrir conversa; minimização LGPD). Marcar `firstInboundText` no retorno como opcional+nullable na doc.

- [ ] **Step 2:** repassar os params como query string para o worker.

- [ ] **Step 3:** `pnpm typecheck`/build do `bloquim-mcp`. Smoke: chamar a tool com `include_first_inbound:true` e ver `firstInboundText`.

- [ ] **Step 4: Commit** — `feat(whatsapp): include_first_inbound + período em whatsapp_list_threads (MCP)`

---

## Task 10: MCP `whatsapp_stats` — período

**Files:**
- Modify: tool `whatsapp_stats` em `bloquim-mcp`

- [ ] **Step 1:** adicionar `since`, `until`, `period_basis` ao schema + descrição (documentar `byIngestSource` nível-mensagem). Expor `byTemperature`/`bySource` no retorno (passthrough).

- [ ] **Step 2:** repassar pro worker.

- [ ] **Step 3:** build + smoke.

- [ ] **Step 4: Commit** — `feat(whatsapp): período em whatsapp_stats (MCP)`

---

## Task 11: MCP tools de disqualify-reasons

**Files:**
- Modify/Create: tools em `bloquim-mcp`

**Interfaces:**
- Consumes: rotas worker da Task 4.

- [ ] **Step 1:** `whatsapp_list_disqualify_reasons(workspace_id, number_id?, include_inactive?)` (membro) → GET worker.

- [ ] **Step 2:** `whatsapp_upsert_disqualify_reason(workspace_id, code, label, active?)` (admin) → POST upsert; `active:false` → POST deactivate. Descrições documentam o gate admin + reativação.

- [ ] **Step 3:** build + smoke (list, upsert, deactivate, re-list).

- [ ] **Step 4: Commit** — `feat(whatsapp): tools MCP de disqualify-reasons (list/upsert)`

---

## Self-Review (cobertura do spec)

- §4.1 migração → Task 1. §4.2 seed provisionamento → Task 5. §4.3 validação 2 callers → Task 2. §4.4 endpoints → Tasks 3+4. §4.5 tools MCP → Task 11.
- §5 firstInboundText MCP → Task 9.
- §6.2 getStats período + buckets → Task 6. §6.3 listThreads período + cursor → Task 7. §6.4 plumbing rotas → Task 8; MCP período → Tasks 9+10.
- §7 authz/logAccess → embutido em Tasks 2/4 (+ ações novas no audit).
- §8 testes → cada task tem TDD. §9 rollout → ordem worker→mcp nas tasks. §10 riscos → endereçados (guard órfão T1, cursor T7, cross-ws T2, byIngestSource doc T6).

## Rollout (pós-implementação)

1. Merge worker → deploy (037 aplica no boot, com guard de órfão; conferir logs do migrate).
2. Publicar `bloquim-mcp` (tools novas).
3. Recarregar o connector `bloquim` no Claude.
4. Smoke em prod: `whatsapp_list_disqualify_reasons`, `whatsapp_stats` com `since/until`, `whatsapp_list_threads` com `include_first_inbound`.
