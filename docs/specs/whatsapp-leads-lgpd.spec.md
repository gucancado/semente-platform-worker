# Spec — WhatsApp Leads: ciclo de vida, proveniência e conformidade LGPD

> Status: **v2 (pós-revisão adversarial)** · Escopo: `semente-platform-worker` (schema/REST/ingestão) + `bloquim-mcp` (tools) + `beeads-central-de-dados` (painel) + `bloquim` (1 endpoint interno de authz) · Contrato: `whatsapp_v1`
>
> v2 corrige os achados da revisão: §5.1 reprojetado, anonimização com inventário de PII real, audit de leitura ampliado, fim do "enum-fantasma", SQL parametrizado e ordem de rollout.

## 0. Estado atual (verificado no código — corrigido na v2)

- **Lead**: `whatsapp_thread_meta` — PK `(whatsapp_number_id, identifier)`, `is_lead BOOLEAN NOT NULL DEFAULT TRUE`, `updated_at`, `updated_by` (`migrations/032_whatsapp_thread_meta.sql:7`). **`is_lead` é NOT NULL** — o `IS NULL` do filtro só ocorre via **LEFT JOIN sem linha de meta** (thread nunca tocada), não por coluna nula.
- **Filtro** (`src/whatsapp/lead-filter.ts:6`): `lead` = `(tm.is_lead IS NULL OR tm.is_lead = TRUE)`; `not_lead` = `is_lead = FALSE`; `all`. ⚠️ **interpolado direto na SQL** (`read-queries.ts:43,112`), não parametrizado (seguro só por ser enum fechado).
- **Threads** = agregados de `messages` (`GROUP BY identifier`, `read-queries.ts:13-22`); não há tabela de thread. `name` = `webhook_logs.push_name` (DM) **ou `whatsapp_groups.subject` (grupo)** (`read-queries.ts:26-31`).
- **Cursor**: keyset `base64(JSON{lastAt,identifier})` **só em `list_threads`** (`read-queries.ts:5-6`). `thread_messages` usa cursor **degenerado** `base64(createdAt)` (só `created_at <`, sujeito a empate, `:59,:76`). **`search` não pagina** (só `limit`, `:82-115`).
- **Ingestão**: webhook grava via `insertMessage` **sem passar `created_at`** → usa DEFAULT `now()` (`src/db.ts:285-302`, `migrations/005:40`). **Backfill** grava `created_at = messageTimestamp` explícito (`src/whatsapp/backfill.ts:45,54`), `ON CONFLICT DO UPDATE`. Não há coluna `ingest_source` nem `source`.
- **REST `whatsapp_v1`**: 5 GET (`numbers`, `threads`, `threads/:id/messages`, `search`, `threads/:id/export`) + 1 POST (`threads/:id/lead`). `schema` hardcoded por resposta. Versionamento aditivo. Worker **coage params desconhecidos pro default em silêncio** (`read-routes.ts:18-19,31-32`).
- **Auth/acesso**: `requirePanelToken` compara `X-Panel-Token` (`provision-routes.ts:14-19`); `req.actingUser = X-Acting-User ?? null` (default `'panel'` no uso, `write-routes.ts:13`). **Gate de membership/admin é feito SÓ no MCP** (`bloquim-mcp/src/lib/workspace-access.ts:13-24`, `role==="admin"` exato); **o worker NÃO revalida** → `X-Acting-User` é **forjável** por quem tem o panel-token.
- **PII espalhada (inventário p/ LGPD)**: `messages.text`/`author`; **`webhook_logs.message_text` + `push_name`** (`src/webhook/routes.ts:90,213`); `whatsapp_groups.subject`; `episodes`/`episode_chunks` (embeddings com texto, migr 015/021); `pending_triggers`/`event_outbox` (possíveis cópias). `messages`/`webhook_logs` têm `ON DELETE CASCADE` por número (`migrations/026:3,8`) — apagar **número** limpa; apagar **thread** é manual e multi-tabela.

## 1. Objetivos / Não-objetivos
**Objetivos**: (1) lead além do booleano + qualificação; (2) proveniência (`source` + `ingest_source`); (3) batch + stats; (4) LGPD: acesso defense-in-depth **real**, audit de leitura+escrita, eliminação/anonimização **completas**, minimização, retenção.
**Não-objetivos**: UI nova além do necessário; reescrever ingestão; mudar o SSO.

## 2. Mudança 1 — Ciclo de vida de lead + qualificação

### 2.1 Schema (migration `033_whatsapp_lead_lifecycle.sql`) — aditivo
`is_lead` (NOT NULL) **permanece** como a verdade da *triagem* (interessado sim/não); o funil é ortogonal:
```sql
ALTER TABLE whatsapp_thread_meta
  ADD COLUMN lead_stage        TEXT,   -- funil (NULL=não qualificado): 'qualificado'|'desqualificado'|'cliente'|'perdido'
  ADD COLUMN lead_temperature  TEXT,   -- 'quente'|'morno'|'frio'
  ADD COLUMN lead_source       TEXT,   -- 'site'|'indicacao'|'ads'|'organico'|'desconhecido'
  ADD COLUMN disqualify_reason TEXT REFERENCES whatsapp_disqualify_reasons(code),
  ADD COLUMN notes             TEXT,
  ADD CONSTRAINT thread_meta_stage_coherente
    CHECK (lead_stage IS DISTINCT FROM 'desqualificado' OR is_lead = FALSE);
```
- **`disqualify_reason` NÃO é enum-fantasma.** Cria-se tabela de referência **local** (fonte de verdade no worker), semeada com as categorias da triagem; o prompt do mercúrio passa a referenciar esses `code`s (não o contrário):
```sql
CREATE TABLE whatsapp_disqualify_reasons (code TEXT PRIMARY KEY, label TEXT NOT NULL, active BOOLEAN DEFAULT TRUE);
INSERT INTO whatsapp_disqualify_reasons(code,label) VALUES
 ('interno_equipe','Equipe interna'),('profissional_busca_trabalho','Profissional buscando trabalho'),
 ('parceria_b2b','Parceria B2B'),('fornecedor','Fornecedor'),('contabilidade_nf','Contabilidade/NF'),
 ('spam_outro_negocio','Spam/outro negócio'),('agencia','Agência'),('sistema_whatsapp','Sistema WhatsApp'),
 ('fora_escopo','Fora de escopo');
```
- **tags**: tabela normalizada (não JSONB), barata pra filtrar e pra stats `byTag`:
```sql
CREATE TABLE whatsapp_thread_tags (
  whatsapp_number_id INT NOT NULL, identifier TEXT NOT NULL, tag TEXT NOT NULL,
  PRIMARY KEY (whatsapp_number_id, identifier, tag));
CREATE INDEX ON whatsapp_thread_tags (whatsapp_number_id, tag);
```

### 2.2 Histórico de transição (migration `035`, junto do audit)
`whatsapp_thread_meta_log (id, whatsapp_number_id, identifier, field, old_value, new_value, actor, created_at)`. ⚠️ **Só tem valor real depois de §5.1** (senão `actor`=forjável).

### 2.3 REST — aditivo, **mas worker antes do MCP** (ver §7)
- `Thread`/`SearchHit` ganham `leadStage, leadTemperature, leadSource, disqualifyReason, tags[]` (passthrough do MCP via `...data`, sem validação estrita — confirmado em `_whatsapp_shared.ts:14`).
- `POST /whatsapp/threads/:identifier/lead`: body estendido mantendo `status` (`'lead'|'not_lead'`) — **o enum `status` NÃO muda**; adicionam-se campos opcionais `stage|temperature|source|disqualifyReason|tags|notes`.
- Novos filtros em `list_threads`/`search`: `lead_stage`, `lead_source`, `tag` — **parametrizados (`$n`)**, nunca interpolados como o `leadFilterSql` atual. Validar `disqualify_reason`/`stage` contra a tabela de referência no worker.
- **Coerção silenciosa**: como o worker hoje joga param desconhecido pro default (`read-routes.ts:18-19`), o MCP **só pode** expor esses filtros **depois** do worker suportá-los.

### 2.4 MCP
- Campos de qualificação **opcionais** no `whatsapp_set_lead_status` como `z.string().optional()` (casa com colunas `TEXT` livres; evita acoplar enum-no-MCP × DB). Enum `status` permanece `["lead","not_lead"]`.
- Filtros novos como `z.string().optional()`.

### 2.5 Compatibilidade
Aditivo → `whatsapp_v1`. `is_lead`+`lead_stage` **separados** é a **única** opção compatível (colapsar quebraria `leadFilterSql` e o derivado `leadStatus`).

## 3. Mudança 2 — Proveniência

### 3.1 `ingest_source` (migration `034_messages_provenance.sql`)
```sql
ALTER TABLE messages ADD COLUMN ingest_source TEXT NOT NULL DEFAULT 'live';
```
- ⚠️ **Pegadinha**: `insertMessage` usa default; o **backfill precisa passar `ingest_source='backfill'` explicitamente** no INSERT (`backfill.ts:47-54`), **e** no `ON CONFLICT DO UPDATE` decidir se sobrescreve (re-backfill não deve rebaixar `live`→`backfill`; manter `LEAST`/regra). 
- Valor primário: limpeza/minimização retroativa, não distinção (timestamp já distingue).
- **Backfill retroativo das linhas atuais**: incerto — inferir por `evolution_event_id`+timestamp antigo é heurístico; documentar como best-effort.

### 3.2 `lead_source`
- Preencher na criação da thread quando a origem é conhecível (form do site marca a entrada; "vim pelo site" na 1ª msg). Senão `desconhecido`, ajustável.
- **Gancho LGPD**: `source=site` é onde se anexa o **flag de consentimento** capturado no formulário (mudança no site, fora deste repo).

## 4. Mudança 3 — Batch + Stats

### 4.1 Batch
- `POST /whatsapp/threads/bulk-lead` — `{ number_id, updates:[{identifier,status?,stage?,...}] }`, transação única. **Especificar a validação que hoje não existe**: cada `identifier` deve existir em `messages`/`thread_meta` daquele `(number_id, workspace)` antes do upsert (`write-routes.ts` hoje não valida identifier).
- MCP: `whatsapp_set_lead_status_bulk` (admin). Elimina o padrão N-POSTs (marcamos 112 em 112 chamadas).

### 4.2 Stats
- `GET /whatsapp/stats?workspace_id&number_id` → `{ total, byLeadStatus, byStage, byKind, byIngestSource, byTag }`.
- MCP `whatsapp_stats` (member). Resolve o "29 × 741" sem paginar.
- Custo: o agregado já faz `GROUP BY identifier` no número inteiro (`read-queries.ts:13-22`); `COUNT` por cima é aceitável, mas medir; `include_total` em `list_threads` fica **off por default**.

### 4.3 Minimização do "preview" (corrige redundância)
- **Não** criar `GET /threads/:id/preview`. `list_threads` já devolve `lastText|kind|leadStatus|count`. Estender com **`firstInboundText`** opcional (campo aditivo) cobre a triagem **sem** expor o histórico clínico inteiro. Triagem/qualificação usa `list_threads` (mínimo), **não** `export`.

## 5. Mudança 4 — LGPD (bloqueante)

### 5.1 Acesso defense-in-depth — **reprojetado** ⚠️ decisão registrada
Problema: worker não tem a identidade do ator; `X-Acting-User` é forjável; `/api/auth/me/*` resolve pelo JWT do próprio usuário (que o worker não possui).
**DECIDIDO — opção B**: endpoint **interno** no Bloquim, server-to-server:
```
POST /api/internal/authz/workspace-role   (auth: SERVICE_TOKEN dedicado, não o painel-token)
body: { userId, workspaceId } → { role: 'admin'|'editor'|'member'|null }
```
- Worker chama isso passando `X-Acting-User` como `userId`. **Replica a regra exata** do MCP: leitura exige `role != null` (membro); escrita/eliminação exige `role === 'admin'` (atenção: `editor`/`owner` **não** contam, igual `workspace-access.ts:18-24`).
- **Mantém o `JWT_SECRET` fora do worker** (autz numa fonte só). Alternativa (A): worker minta JWT com `JWT_SECRET` compartilhado e chama `/me/workspaces` — rejeitada por espalhar o secret.
- **Cache**: leitura `(actor,workspace)→role` TTL 30–60s. **Escrita/DELETE/anonymize: sem cache** (revalida sempre — ex-admin não apaga na janela do TTL).
- **5.1 é pré-requisito de 5.2/2.2** (sem ela, `actor` logado não é confiável).

### 5.2 Audit de leitura+escrita (migration `035`)
`whatsapp_access_log (id, actor, action, workspace_id, number_id, identifier, created_at, meta JSONB)`.
- **Leitura sensível a logar**: `export`, `thread_messages`, **e `search`** (devolve snippets, `read-queries.ts:90`). `list_threads` (devolve `lastText`) — logar ao menos volume/agregado.
- **Escrita**: `set_lead`, `bulk_lead`, `delete`, `anonymize`.

### 5.3 Eliminação / anonimização (art. 18) — **ADIADO (decisão: reter dados, sem eliminação nesta fase)**
> ⚠️ **Decisão registrada**: nesta fase **não** se constrói tooling de eliminação/anonimização; os dados são **retidos**. Consequência LGPD a aceitar conscientemente: **um pedido de exclusão de titular (art. 18, VI) não é atendível** até este item existir, e a **retenção exige base legal documentada** (dever de guarda — saúde/fiscal — art. 16, I). O inventário abaixo fica **documentado** para quando a eliminação for priorizada.

Quando for implementar, por **contato/thread** (`number_id`+`identifier`), tocar TODAS as tabelas com PII:
- `messages`: `text`, `author`.
- **`webhook_logs`: `message_text` + `push_name`** ← era o vazamento principal omitido na v1.
- `whatsapp_thread_meta`, `whatsapp_thread_tags`, `whatsapp_thread_meta_log`.
- `whatsapp_groups.subject` (quando aplicável).
- **`episodes`/`episode_chunks`** (embeddings derivados do texto) — DELETE/recompute; sem isso, PII persiste em vetor.
- `pending_triggers`/`event_outbox` residuais.
- `DELETE /whatsapp/threads/:identifier?number_id=` (hard delete) **e** `POST /whatsapp/threads/:identifier/anonymize` (mantém estrutura/métrica, zera conteúdo/identificadores). MCP: `whatsapp_erase_contact`/`whatsapp_anonymize_contact` (**admin + `confirm:true`**, logados, **sem cache de authz**).
- Decidir com jurídico **apagar × anonimizar × reter** por tabela (dever de guarda saúde/fiscal vs art. 16).

### 5.4 Retenção / backfill — **decisão: RETER**
- Política = **retenção** (sem expurgo automático nesta fase). **Documentar a base legal da retenção** (dever de guarda saúde/fiscal — art. 16, I) no registro de operações.
- `BACKFILL_SINCE_DAYS` explícito/config por número (importar só o necessário — minimização na entrada, mesmo retendo).
- Job de anonimização por inatividade: **fora de escopo** nesta fase (ver 5.3 adiado).

## 6. Versionamento
| Mudança | Tipo | Contrato |
|---|---|---|
| Lead lifecycle/qualificação, `ingest_source`/`lead_source`, batch/stats, `firstInboundText`, eliminação/anon | aditivo | `whatsapp_v1` |
| Audit/meta-log | interno | — |
| **Revalidação de acesso no worker (5.1)** | **comportamental (segurança)** | pode rejeitar chamadas que hoje passam; coordenar painel/MCP |
| Endpoint interno de authz no Bloquim | novo (interno) | — |

## 7. Ordem de rollout (corrigida)
1. **5.1 (authz no worker) + endpoint interno Bloquim** → torna `X-Acting-User` confiável. **Pré-requisito de todo o resto de LGPD.**
2. **5.2 audit** (agora com ator confiável) + documentar base legal de retenção (5.4). *(5.3 eliminação/anon: adiado por decisão.)*
3. **Modelo de lead (2)** + tabela de reasons/tags — **worker primeiro, depois MCP** (coerção silenciosa).
4. **Proveniência (3)**: `ingest_source` (cuidar do INSERT/ON CONFLICT do backfill); `lead_source` no fluxo do site.
5. **Batch/stats (4)** + `firstInboundText`.

Migrations: `033_whatsapp_lead_lifecycle` (+ reasons + tags + CHECK), `034_messages_provenance`, `035_whatsapp_audit_logs` (access_log + meta_log).

## 8. Decisões (resolvidas — 2026-06-24)
1. **5.1 credencial**: ✅ **opção B** (endpoint interno no Bloquim). JWT_SECRET fica fora do worker.
2. **Eliminação × retenção**: ✅ **reter dados; sem eliminação nesta fase** (5.3 adiado). Retenção precisa de base legal documentada (art. 16, I). Risco aceito: art. 18 (exclusão) não atendível até 5.3 existir.
3. **Embeddings (`episodes`)**: n/a nesta fase (eliminação adiada); inventário documentado em 5.3 para o futuro.
4. **`role` para escrita**: ✅ **`admin` estrito** (como hoje — `editor`/`owner` não contam).
5. **Consentimento no site (`source=site`)**: ✅ vira **tarefa no Bloquim** (criada — captura de consentimento LGPD no formulário do site da Luhma).
