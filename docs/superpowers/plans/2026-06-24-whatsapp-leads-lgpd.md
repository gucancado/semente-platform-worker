# WhatsApp Leads — Ciclo de vida + LGPD: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o controle de acesso aos dados sensíveis de WhatsApp confiável (defense-in-depth + auditoria), e evoluir o modelo de lead (booleano → ciclo de vida + qualificação + proveniência), mantendo o contrato `whatsapp_v1` aditivo.

**Architecture:** 3 repos. **Bloquim** (`beeads-bloquim`) ganha 1 endpoint interno de authz server-to-server. **Worker** (`semente-platform-worker`) passa a revalidar o ator (`X-Acting-User`) contra esse endpoint antes de servir/escrever dados de WhatsApp, loga acessos, e estende schema/REST. **MCP** (`bloquim-mcp`) expõe os campos/tools novos. Rollout sempre **worker antes do MCP** (o worker coage params desconhecidos pro default em silêncio → MCP não pode anunciar filtro inexistente).

**Tech Stack:** Node/TS, Fastify (worker), Drizzle/SQL migrations (Postgres), Zod (MCP tools), pnpm.

## Global Constraints

- **Fonte canônica:** `docs/specs/whatsapp-leads-lgpd.spec.md` (v2). Em conflito, a spec vence; se a spec estiver errada vs código, **parar e corrigir a spec antes**.
- **Contrato `whatsapp_v1` é aditivo.** Nenhum campo removido; nenhum enum `status` (`lead|not_lead`) alterado. Campos novos só ADICIONADOS.
- **Sem DB de teste local** (a suíte faz TRUNCATE). Validação local = `pnpm typecheck` + build; a suíte de integração roda no servidor. Cada task: escrever o teste, garantir typecheck/build verde local, e marcar "suíte no servidor" como gate.
- **SQL parametrizado (`$n`) sempre.** NÃO copiar o padrão de interpolação de `src/whatsapp/lead-filter.ts` para inputs novos (tag/stage/source) → risco de SQLi.
- **Autorização de escrita = `role === 'admin'` ESTRITO** (igual `bloquim-mcp/src/lib/workspace-access.ts:18-24`; `editor`/`executor` NÃO contam). Leitura = membro (`role != null`). ⚠️ Enum real de role no Bloquim = `["admin","editor","executor"]` (não há `member`/`owner`).
- **Migrations numeradas sequenciais**: próximas livres a partir de `033`.
- **Deploy:** push pra master NÃO auto-deploya de forma confiável; disparar manual via Coolify API `POST /api/v1/deploy?uuid=<app_uuid>` (worker `qlp2n4fi3jlklisftet1y7cz`).
- **Não tocar** SSO, ingestão core, nem grupos (hard-gate por default permanece).
- **Decisões fixadas (2026-06-24):** authz via endpoint interno Bloquim (opção B); **reter dados, SEM eliminação/anonimização nesta fase** (5.3 da spec adiado); `admin` estrito; consentimento no site é tarefa Bloquim separada (já criada).

---

## File Structure

**Bloquim (`beeads-bloquim/repo/artifacts/api-server`):**
- Create: rota interna `POST /api/internal/authz/workspace-role` (auth por `SERVICE_TOKEN` dedicado) → `{ role }`.

**Worker (`semente-platform-worker`):**
- Create: `migrations/033_whatsapp_lead_lifecycle.sql`, `migrations/034_messages_provenance.sql`, `migrations/035_whatsapp_audit_logs.sql`
- Create: `src/whatsapp/authz.ts` (client + cache do endpoint Bloquim), `src/whatsapp/access-log.ts`
- Modify: `src/whatsapp/read-routes.ts`, `src/whatsapp/write-routes.ts` (hook de authz + log), `src/whatsapp/read-queries.ts` (campos novos, filtros parametrizados, `firstInboundText`), `src/whatsapp/thread-meta.ts` (campos qualificação + meta-log), `src/whatsapp/backfill.ts` (`ingest_source='backfill'`), `src/webhook/routes.ts`/`src/db.ts` (insert `ingest_source='live'`)
- Create: `src/whatsapp/stats.ts`, `src/whatsapp/bulk-lead.ts`

**MCP (`bloquim-mcp`):**
- Modify: `src/tools/whatsapp_set_lead_status.ts`, `whatsapp_list_threads.ts`, `whatsapp_search.ts` (campos/filtros opcionais)
- Create: `src/tools/whatsapp_set_lead_status_bulk.ts`, `src/tools/whatsapp_stats.ts`
- Modify: `src/mcp/register.ts`, `src/mcp/instructions.ts`

---

## FASE 1 — LGPD-base (bloqueante; detalhada)

### Task 1: Endpoint interno de authz no Bloquim

**Files:**
- Create/Modify (Bloquim api-server): rota `internal/authz` + registro; env `INTERNAL_SERVICE_TOKEN`.
- Test: teste de rota do api-server (padrão do repo).

**Interfaces:**
- Produces: `POST /api/internal/authz/workspace-role` — header `X-Service-Token: <INTERNAL_SERVICE_TOKEN>`; body `{ userId: string (uuid), workspaceId: string (uuid) }` → `200 { role: 'admin'|'editor'|'executor'|null }` (null = não-membro); `401` se service token inválido. ⚠️ Enum real = `["admin","editor","executor"]` (não há `member`/`owner`); reusar `getMemberRole()` de `permissions.ts:183`.
- Semântica de `role`: reaproveitar a resolução de membership já usada por `/api/auth/me/workspaces` (mesma fonte que o MCP consome), mas resolvendo por `userId` passado, não pelo JWT do request.

- [ ] **Step 1:** Ler como `/api/auth/me/workspaces` resolve role hoje (membership query) no api-server; identificar a função reaproveitável.
- [ ] **Step 2:** Escrever teste: com `X-Service-Token` válido e um `(userId, workspaceId)` de membro admin → `{ role: 'admin' }`; não-membro → `{ role: null }`; sem/!token → 401.
- [ ] **Step 3:** Implementar a rota reusando a query de membership, parametrizada.
- [ ] **Step 4:** `INTERNAL_SERVICE_TOKEN` em env (gerar `openssl rand -hex 32`); documentar no Coolify (Bloquim app) + no worker (próxima task).
- [ ] **Step 5:** typecheck/build; commit `feat(authz): internal workspace-role endpoint for service-to-service checks`.

### Task 2: Cliente de authz + cache no worker

**Files:**
- Create: `src/whatsapp/authz.ts`
- Test: `src/whatsapp/authz.test.ts`

**Interfaces:**
- Produces:
  - `resolveActorRole(userId: string, workspaceId: string): Promise<'admin'|'editor'|'executor'|null>` — chama o endpoint da Task 1 com `X-Service-Token` (env `BLOQUIM_SERVICE_TOKEN`), **cache TTL 45s** por `(userId, workspaceId)`.
  - `resolveActorRoleFresh(userId, workspaceId)` — mesma coisa, **sem cache** (para escrita/ações sensíveis).
  - `assertActorMember(actor, ws)` (lança se role==null) e `assertActorAdmin(actor, ws)` (lança se role!=='admin'; usa a versão fresh).
- Consumes: env `BLOQUIM_INTERNAL_URL`, `BLOQUIM_SERVICE_TOKEN`.

- [ ] **Step 1:** Teste: `resolveActorRole` cacheia (2 chamadas = 1 fetch dentro do TTL); `assertActorAdmin` lança para `editor`/`member`/`null` e passa só para `admin`; a versão fresh não cacheia. (mock do fetch).
- [ ] **Step 2:** Implementar com um Map de cache `{value, expiresAt}`; fresh ignora cache.
- [ ] **Step 3:** typecheck/build; commit `feat(whatsapp): worker-side actor authz client with short cache`.

### Task 3: Aplicar authz nas rotas `/whatsapp/*`

**Files:**
- Modify: `src/whatsapp/read-routes.ts` (5 GET), `src/whatsapp/write-routes.ts` (POST lead)
- Test: `src/whatsapp/read-routes.authz.test.ts`

**Interfaces:**
- Consumes: `assertActorMember`/`assertActorAdmin` (Task 2). `actingUser` já existe em `req.actingUser` (`provision-routes.ts`), mas hoje pode ser null → tornar **obrigatório** nas rotas `/whatsapp/*` (400 se ausente).
- Leitura (`numbers`, `threads`, `messages`, `search`, `export`): `assertActorMember(req.actingUser, workspace_id)`.
- Escrita (`lead`): `assertActorAdmin(...)` (fresh).

- [ ] **Step 1:** Teste: GET threads com ator não-membro → 403; membro → 200. POST lead com ator não-admin → 403; admin → 200. Ator ausente → 400.
- [ ] **Step 2:** Inserir as asserts no início de cada handler (após `requirePanelToken`, antes da query). `export` resolve `workspace_id` da query (já presente).
- [ ] **Step 3:** typecheck/build; commit `feat(whatsapp): enforce actor membership/admin at the worker (defense-in-depth)`.
- [ ] **Step 4 (gate humano):** coordenar com painel/MCP — ambos já mandam `X-Acting-User`? Confirmar antes do deploy (senão quebra leitura legítima). Ver "Gates" no fim.

### Task 4: Audit log de acesso (leitura + escrita)

**Files:**
- Create: `migrations/035_whatsapp_audit_logs.sql` (tabela `whatsapp_access_log` + `whatsapp_thread_meta_log`)
- Create: `src/whatsapp/access-log.ts`
- Modify: `read-routes.ts` (`export`, `messages`, `search`), `write-routes.ts`, `thread-meta.ts`
- Test: `src/whatsapp/access-log.test.ts`

**Interfaces:**
- `whatsapp_access_log(id BIGSERIAL, actor TEXT, action TEXT, workspace_id TEXT, number_id INT, identifier TEXT NULL, created_at TIMESTAMPTZ DEFAULT now(), meta JSONB)`.
- Produces: `logAccess({actor, action, workspaceId, numberId, identifier?, meta?})` (fire-and-forget, não bloqueia resposta; erro só loga, não derruba a request).
- Acções a logar: `export`, `thread_messages`, `search` (leitura sensível) + `set_lead` (escrita). `meta_log` registra transições de lead (old/new/field/actor).

- [ ] **Step 1:** Migration 035 (parametrizada/idempotente).
- [ ] **Step 2:** Teste: chamar `export`/`search`/`messages` cria 1 linha de access_log com o `actor` correto; `set_lead` cria access_log + meta_log com old/new.
- [ ] **Step 3:** Implementar `logAccess` + chamar nos handlers; `setLeadStatus` grava meta_log (lê valor anterior antes do upsert).
- [ ] **Step 4:** typecheck/build; commit `feat(whatsapp): access + lead-transition audit logs`.

### Task 5: Documentar base legal de retenção

**Files:**
- Modify: `docs/specs/whatsapp-leads-lgpd.spec.md` (§5.4) ou um `docs/lgpd/registro-operacoes.md`.

- [ ] **Step 1:** Registrar a operação de tratamento (finalidade, base legal de retenção = dever de guarda art.16,I; categorias de dado; retenção sem expurgo nesta fase; ausência de tooling de eliminação como risco aceito). Commit `docs(lgpd): registro de operacoes e base legal de retencao`.

---

## FASE 2 — Modelo de lead + qualificação (outline; detalhar na execução)

> Cada task abaixo vira TDD detalhado quando alcançada (subagent lê o arquivo real primeiro). Files/interfaces já fixados.

### Task 6: Migration `033_whatsapp_lead_lifecycle.sql`
- Colunas em `whatsapp_thread_meta`: `lead_stage`, `lead_temperature`, `lead_source`, `disqualify_reason TEXT REFERENCES whatsapp_disqualify_reasons(code)`, `notes`, + CHECK coerência (`lead_stage='desqualificado' ⇒ is_lead=FALSE`).
- Tabela `whatsapp_disqualify_reasons(code PK, label, active)` semeada (9 categorias da triagem).
- Tabela `whatsapp_thread_tags(number_id, identifier, tag, PK composto)` + índice `(number_id, tag)`.

### Task 7: Worker — expor campos + filtros (parametrizados)
- `read-queries.ts`: `Thread`/`SearchHit` ganham `leadStage,leadTemperature,leadSource,disqualifyReason,tags[]`; filtros `lead_stage`/`lead_source`/`tag` **parametrizados**; validar `disqualify_reason`/`stage` contra tabela ref.
- `write-routes.ts`/`thread-meta.ts`: body estendido (mantém `status`), campos opcionais; meta-log já cobre (Task 4).

### Task 8: MCP — campos opcionais nas tools
- `whatsapp_set_lead_status.ts`: campos `stage/temperature/source/disqualifyReason/tags/notes` como `z.string()/z.array(z.string())` opcionais. Enum `status` inalterado.
- `whatsapp_list_threads.ts`/`whatsapp_search.ts`: filtros novos opcionais. Atualizar `instructions.ts`/descrições.

---

## FASE 3 — Proveniência (outline)

### Task 9: Migration `034_messages_provenance.sql`
- `messages.ingest_source TEXT NOT NULL DEFAULT 'live'`.

### Task 10: Marcar origem na ingestão
- `backfill.ts`: INSERT passa `ingest_source='backfill'`; no `ON CONFLICT DO UPDATE` **não rebaixar** `live`→`backfill`.
- `db.ts`/`webhook/routes.ts`: insert live mantém default `'live'` (explicitar pra clareza).
- `lead_source` na criação da thread quando conhecível (form site / "vim pelo site").

---

## FASE 4 — Eficiência (outline)

### Task 11: Batch set_lead
- Worker `src/whatsapp/bulk-lead.ts` + `POST /whatsapp/threads/bulk-lead` (transação; valida cada identifier×number). MCP `whatsapp_set_lead_status_bulk` (admin).

### Task 12: Stats
- Worker `src/whatsapp/stats.ts` + `GET /whatsapp/stats` (`total,byLeadStatus,byStage,byKind,byIngestSource,byTag`). MCP `whatsapp_stats` (member).

### Task 13: `firstInboundText` em `list_threads`
- `read-queries.ts`: campo opcional aditivo (1ª inbound da thread) para triagem minimizada — substitui a ideia de endpoint `preview`.

---

## Self-Review (feito)
- **Cobertura da spec:** §5.1→T1-3; §5.2→T4; §5.4→T5; §2→T6-8; §3→T9-10; §4.1→T11; §4.2→T12; §4.3→T13. §5.3 (eliminação) **conscientemente fora** (decisão de reter).
- **Placeholders:** Fase 1 com passos concretos; Fases 2-4 marcadas como outline-a-detalhar-na-execução (não são placeholders de código — são tasks com files/interfaces fixados, a serem TDD-detalhadas pelo subagent que ler o arquivo real).
- **Consistência de tipos:** `resolveActorRole`/`assertActorAdmin`/`logAccess`/`whatsapp_disqualify_reasons.code` usados de forma única.

## Gates humanos / riscos de rollout
1. **Antes do deploy da Task 3:** confirmar que **painel e MCP já enviam `X-Acting-User`** em TODA chamada `/whatsapp/*` — senão a authz quebra leitura legítima em prod. (MCP envia: `bloquim-mcp/src/lib/worker.ts:17`. Painel: **verificar**.)
2. **Worker→MCP sempre:** deploy worker com filtro novo ANTES do MCP anunciar (coerção silenciosa).
3. **`INTERNAL_SERVICE_TOKEN`/`BLOQUIM_SERVICE_TOKEN`:** provisionar nos envs do Coolify (Bloquim + worker) antes da Task 3.
4. **Deploy manual** via Coolify API (push não auto-deploya).
