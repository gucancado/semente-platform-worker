# Spec — WhatsApp Backend/MCP Enabler (S2 + S3 + S6)

> Status: draft v2 (2026-06-25, refinado pós-revisão adversarial Codex).
> Habilitadores de backend/MCP extraídos da análise de qualificação de leads da
> Luhma. Tornam o próximo "qualificar cliente do zero" e a GUI de funil viáveis
> sem migração manual nem leitura conversa-a-conversa.
> Canon: `docs/specs/whatsapp-leads-lgpd.spec.md` (modelo de lead v2),
> `migrations/033_whatsapp_lead_lifecycle.sql`, `036_whatsapp_disqualify_reasons_patient.sql`.

## 1. Contexto e motivação

A qualificação dos 258 leads da Luhma expôs três atritos de sistema:

1. **`disqualifyReason` é um enum validado no banco**, mas adicionar um motivo novo
   exigiu uma migração aplicada em produção — caro e travado por infra. Precisamos
   de **CRUD de motivos por workspace, sem migração**.
2. **Classificar exigiu abrir cada conversa** porque a lista não trazia o 1º texto
   do lead. O backend já suporta `firstInboundText`, mas a **tool MCP não expõe**.
3. **`whatsapp_stats` e `list_threads` não têm recorte de período**, impedindo
   qualquer visão de funil "no período" alinhada aos dashboards Meta/Google.

Esta spec cobre os três (S2, S3, S6). GUI, auto-enriquecimento de ingestão,
workflow reutilizável e modo parcial do bulk ficam **fora de escopo**.

## 2. Escopo

- **S2** — Motivos de desqualificação por workspace + CRUD (worker + MCP).
- **S3** — Expor `firstInboundText` na tool MCP `whatsapp_list_threads`.
- **S6** — `since`/`until` + `period_basis` em `getStats` e `listThreads`; `stats`
  passa a devolver `byTemperature` e `bySource`.

**Fora de escopo:** GUI do painel (G1–G6); auto-tag de `source` na ingestão (S4);
heurística de fragmento na ingestão (S5); workflow/skill de qualificação (S10);
bulk com modo parcial (S7); correção do connector `mcp__bloquim__*` (config, não código).

## 3. Decisões de design (fechadas com o owner)

- **Motivos são SEMPRE por workspace e editáveis.** Não há motivo "global de
  verdade". Existe um **template global** (`*_defaults`) **copiado** para o workspace
  ao provisionar a integração; depois cada workspace é dono da sua cópia. Editar/remover
  num workspace **não** afeta outro. Adicionar um default novo ao template **não**
  retroage para workspaces existentes.
- **"Remover" = soft-delete** (`active=false`): some das opções oferecidas mas
  preserva integridade histórica/auditoria.
- **Período tem dois modos** com toggle na GUI; backend expõe `period_basis`:
  `'arrival'` (default — 1ª mensagem na janela; = lead captado) e `'activity'`
  (qualquer mensagem na janela).
- **`firstInboundText` é opt-in** (`include_first_inbound`), por minimização LGPD.

## 4. S2 — Motivos de desqualificação por workspace

### 4.1 Schema + migração (nova, nº 037)

A migração é **idempotente** (rodando no boot via `migrate.js`, um boot duplo pós-falha
parcial não pode travar). Sequência (validada com Codex):

```sql
-- PASSO 0: tabela-template (idempotente)
CREATE TABLE IF NOT EXISTS whatsapp_disqualify_reason_defaults (
  code TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INT NOT NULL DEFAULT 0
);
INSERT INTO whatsapp_disqualify_reason_defaults (code, label, sort_order) VALUES
  ('interno_equipe','Equipe interna',1),
  ('profissional_busca_trabalho','Profissional buscando trabalho',2),
  ('parceria_b2b','Parceria B2B',3),
  ('fornecedor','Fornecedor',4),
  ('contabilidade_nf','Contabilidade/NF',5),
  ('spam_outro_negocio','Spam/outro negócio',6),
  ('agencia','Agência',7),
  ('sistema_whatsapp','Sistema WhatsApp',8),
  ('fora_escopo','Fora de escopo',9),
  ('fora_area_cobertura','Fora da área de cobertura',10),
  ('servico_nao_oferecido','Serviço/especialidade não oferecido',11)
ON CONFLICT (code) DO NOTHING;

-- PASSO 1: sincroniza o template com QUALQUER code global em uso hoje que não
-- esteja nos defaults (defende contra codes inseridos fora desta spec) → evita órfão.
INSERT INTO whatsapp_disqualify_reason_defaults (code, label, sort_order)
SELECT r.code, r.label, 99 FROM whatsapp_disqualify_reasons r
 WHERE r.code NOT IN (SELECT code FROM whatsapp_disqualify_reason_defaults)
ON CONFLICT (code) DO NOTHING;

-- PASSO 2: drop FK de thread_meta (integridade passa pro app, escopada por workspace)
ALTER TABLE whatsapp_thread_meta
  DROP CONSTRAINT IF EXISTS whatsapp_thread_meta_disqualify_reason_fkey;

-- PASSO 3: drop PK antiga (code)
DO $$ BEGIN
  ALTER TABLE whatsapp_disqualify_reasons DROP CONSTRAINT IF EXISTS whatsapp_disqualify_reasons_pkey;
EXCEPTION WHEN OTHERS THEN NULL; END; $$;

-- PASSO 4: colunas novas (idempotente)
ALTER TABLE whatsapp_disqualify_reasons
  ADD COLUMN IF NOT EXISTS workspace_id UUID,
  ADD COLUMN IF NOT EXISTS created_by   UUID,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- PASSO 5: backfill por workspace — DUAS fontes (números E thread_meta), cobre
-- workspaces sem número ativo mas com reasons em uso.
INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
SELECT n.workspace_id, d.code, d.label, TRUE
  FROM (SELECT DISTINCT workspace_id FROM whatsapp_numbers) n
  CROSS JOIN whatsapp_disqualify_reason_defaults d
ON CONFLICT DO NOTHING;
INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
SELECT DISTINCT wn.workspace_id, d.code, d.label, TRUE
  FROM whatsapp_thread_meta tm
  JOIN whatsapp_numbers wn ON wn.id = tm.whatsapp_number_id
  CROSS JOIN whatsapp_disqualify_reason_defaults d
ON CONFLICT DO NOTHING;

-- PASSO 6: GUARD — aborta a migração se algum thread ficaria com reason órfã
DO $$ DECLARE orphan_count INT; BEGIN
  SELECT COUNT(*) INTO orphan_count
    FROM whatsapp_thread_meta tm
    JOIN whatsapp_numbers wn ON wn.id = tm.whatsapp_number_id
   WHERE tm.disqualify_reason IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM whatsapp_disqualify_reasons r
                      WHERE r.workspace_id = wn.workspace_id AND r.code = tm.disqualify_reason);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % threads ficariam com disqualify_reason órfã', orphan_count;
  END IF;
END; $$;

-- PASSO 7: remove linhas globais
DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id IS NULL;

-- PASSO 8: NOT NULL + PK composta
ALTER TABLE whatsapp_disqualify_reasons ALTER COLUMN workspace_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE whatsapp_disqualify_reasons ADD PRIMARY KEY (workspace_id, code);
EXCEPTION WHEN invalid_table_definition THEN NULL; END; $$;
```

`workspace_id` é UUID **sem FK** (id cross-service, como em `whatsapp_numbers`).

### 4.2 Seed no provisionamento

Ao provisionar a integração WhatsApp do workspace (criação de número, em
`provision-routes.ts`/`numbers.ts` junto de `createEvolutionInstance`), copiar os
defaults, idempotente:
```sql
INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
SELECT $1, d.code, d.label, TRUE FROM whatsapp_disqualify_reason_defaults d
ON CONFLICT (workspace_id, code) DO NOTHING;
```
Roda em todo provisionamento (idempotente cobre o 2º número). Default novo no
template **não** retroage para workspaces existentes (só novas integrações).

### 4.3 Validação (re-escopada — ATUALIZAR AMBOS OS CALLERS)

`src/whatsapp/lead-qualify.ts`:
```ts
export async function validateDisqualifyReason(pool, workspaceId, code): Promise<boolean>
// SELECT 1 FROM whatsapp_disqualify_reasons WHERE workspace_id=$1 AND code=$2 AND active=TRUE
```
**Mudança de assinatura → os DOIS callers em `write-routes.ts` precisam mudar JUNTOS:**
- Rota single (`/threads/:id/lead`): `validateDisqualifyReason(pool, num.workspaceId, disqualifyReason)`.
- Rota bulk (`/threads/bulk-lead`): a query batch `SELECT code ... WHERE code = ANY($1) AND active=TRUE`
  ganha **`AND workspace_id = $2`** (`num.workspaceId`).
> ⚠️ Sem isso há **vazamento cross-workspace**: um code ativo/inativo em OUTRO
> workspace passaria/bloquearia indevidamente. Ambos os callers já têm `num.workspaceId`
> em mãos antes da validação.

### 4.4 Endpoints (worker, `whatsapp_v1`)

- `GET /whatsapp/disqualify-reasons?workspace_id=&include_inactive=` — **membro**
  (`gateMember`) **+ `logAccess({action:'list_disqualify_reasons'})`**. Retorna
  `{ schema, reasons:[{code,label,active,sortOrder}] }` ordenado por `sort_order, code`.
  Default só `active=true`.
- `POST /whatsapp/disqualify-reasons` — **admin** (`gateAdmin`) + `logAccess('upsert_disqualify_reason')`.
  Body `{ workspace_id, code, label }`. Upsert: cria ou atualiza `label`/reativa.
  `code` normalizado (slug `[a-z0-9_]+`). **Reativação explícita no response:** se o
  upsert reativou um code antes `active=false`, retorna `{ ok:true, reactivated:true }`
  (auditável); senão `reactivated:false`.
- `POST /whatsapp/disqualify-reasons/:code/deactivate` — **admin** +
  `logAccess('deactivate_disqualify_reason')`. Soft-delete (`active=false`), idempotente.

Arquivo novo `src/whatsapp/disqualify-reasons.ts` (queries puras) + registro nas rotas
read/write seguindo o padrão `gateMember`/`gateAdmin` + `logAccess`.

### 4.5 Tools MCP (repo `bloquim-mcp`)

- `whatsapp_list_disqualify_reasons(workspace_id, number_id?, include_inactive?)` — membro.
- `whatsapp_upsert_disqualify_reason(workspace_id, code, label, active?)` — admin
  (`active:false` → atalho pro deactivate).

## 5. S3 — `firstInboundText` na tool MCP

Backend pronto: `GET /whatsapp/threads?include_first_inbound=true` já devolve
`firstInboundText` (`read-queries.ts` + `read-routes.ts`).

**Mudança única (bloquim-mcp):** adicionar `include_first_inbound` (boolean, default
false) à tool `whatsapp_list_threads`, repassado como query string.

**Contrato a tratar na tool/schema:**
- `include_first_inbound=false` → campo `firstInboundText` **ausente** (`undefined`) no objeto thread.
- `include_first_inbound=true` → campo **presente**; `null` quando o thread não tem
  mensagem inbound. Marcar no schema como **opcional + nullable**.

Descrição da tool documenta: opt-in pra triar lead/não-lead e inferir origem **sem
abrir cada conversa** (minimização LGPD). Sem migração, sem mudança no worker.

## 6. S6 — Período em `stats` e `list_threads`

### 6.1 Semântica

Ambos ganham `since?`, `until?` e `period_basis: 'arrival' | 'activity'` (default
`'arrival'`):
- **arrival**: thread entra se `MIN(m.created_at)` (1ª msg) ∈ `[since, until]` (default).
- **activity**: thread entra se existe **qualquer** `m.created_at` ∈ janela.

Sem `since`/`until`, comportamento atual (sem janela) preservado. **`period_basis`
inválido → HTTP 400** (não silenciar; explicita bug de integração cedo).

### 6.2 `getStats` (`src/whatsapp/stats.ts`)

- Assinatura: `getStats(pool, { workspaceId, numberId?, since?, until?, periodBasis })`.
- **CTE base compartilhada** `threads_in_period` (resolve a inconsistência entre os 4
  queries paralelos): computa, por thread, `MIN(created_at)` e flag de atividade na
  janela, e materializa o conjunto de `identifier` no período. Os queries de
  `total/byKind/byLeadStatus/byStage/byTemperature/bySource` filtram por esse conjunto
  (`WHERE identifier = ANY(...)` ou JOIN na CTE), garantindo buckets **homogêneos**.
- **Novos buckets** (por-thread, mesma mecânica de `byStage`, incl. bucket `null`):
  - `byTemperature: Record<string,number>` (`quente|morno|frio|null`).
  - `bySource: Record<string,number>` (`null` = sem origem).
- **`byIngestSource` permanece nível-MENSAGEM** (não thread). Sob janela, conta
  mensagens cujo `created_at` ∈ janela. **Documentar explicitamente** (no tipo `Stats`
  e na descrição da tool MCP) que, com filtro de período, `byIngestSource` pode
  divergir dos buckets por-thread por ser nível-mensagem — não é incoerência, é
  granularidade diferente. (Decisão: manter semântica atual; não migrar pra thread-level.)
- `byStage`/`byTemperature`/`bySource` refletem o valor **atual** do thread que caiu
  na janela (não histórico).

### 6.3 `listThreads` (`src/whatsapp/read-queries.ts`)

- Add `since?`, `until?`, `periodBasis` aos params; a CTE `agg` calcula `min_created`
  e aplica a janela conforme `period_basis`.
- **Cursor coerente com o filtro (corrige incompatibilidade MAX vs MIN):**
  - `period_basis='activity'` (ou sem janela): mantém `ORDER BY last_at DESC, identifier ASC`
    e cursor por `last_at` (atual).
  - `period_basis='arrival'`: ordena e cursoriza por **`min_created`** (`ORDER BY
    min_created DESC, identifier ASC`; cursor encapsula `min_created`). Sem isso, a
    paginação por `last_at` traz threads fora da janela de chegada em páginas seguintes.

### 6.4 Plumbing

- Rotas `/whatsapp/stats` e `/whatsapp/threads`: aceitam `since`, `until`,
  `period_basis` (coerção `emptyToUndefined`; `period_basis` inválido → 400).
- Tools MCP `whatsapp_stats` e `whatsapp_list_threads`: ganham `since`, `until`,
  `period_basis`. `search`/`thread_messages` já têm `since/until`.

## 7. Authz & LGPD

- Leitura (`list_disqualify_reasons`, `stats`, `list_threads`) → `gateMember` **+ `logAccess`**.
- Escrita (`upsert`/`deactivate` reasons) → `gateAdmin` + `logAccess`.
- Novas ações no audit (`whatsapp_audit_logs`, migr 035): `list_disqualify_reasons`,
  `upsert_disqualify_reason`, `deactivate_disqualify_reason`.
- `firstInboundText` opt-in para minimizar exposição de conteúdo.

## 8. Testes

Suíte `node:test` contra **Postgres real** (sem DB de teste local — rodar no servidor;
memory `reference-tests-need-postgres-no-local-db`). Cobrir:
- **S2 migração:** idempotente (re-run sem erro); guard de órfão dispara quando há
  reason em uso fora do template; backfill cobre workspace só-com-número E só-com-thread_meta;
  PK composta + colunas finais corretas.
- **S2 runtime:** upsert cria/atualiza/reativa (com `reactivated` no response);
  deactivate soft + idempotente; validação rejeita code de OUTRO workspace (single E
  bulk — anti-vazamento); gate admin nas escritas / membro na leitura; seed no
  provisionamento idempotente no 2º número.
- **S3:** tool MCP repassa `include_first_inbound`; campo ausente vs `null` vs texto.
- **S6:** `arrival` vs `activity` contam threads certos numa janela; sem janela =
  comportamento atual; paginação `arrival` estável (cursor por `min_created`);
  `byTemperature`/`bySource` somam corretamente (bucket `null`); `byIngestSource`
  permanece nível-mensagem; zero-fill em workspace vazio; `period_basis` inválido → 400.

## 9. Rollout

Migrations **rodam no start do container** (CMD `node dist/migrate.js && node dist/index.js`;
memory `reference-worker-migrations-apply-server-side-only`). Ordem: merge no worker →
deploy (037 aplica no boot, com guard de órfão) → publicar `bloquim-mcp` com tools novas
→ recarregar connector `bloquim` no Claude. **Compatível para trás:** sem `since/until`,
`period_basis` (default arrival) e `include_first_inbound`, o comportamento é o atual.

## 10. Riscos / pontos de atenção

- **Migração FK+PK** é o passo mais delicado — a sequência idempotente + guard de órfão
  (§4.1) é mandatória. Testar contra dados reais (Luhma já tem reasons em uso).
- **Validação cross-workspace** (§4.3): os dois callers DEVEM mudar juntos com a
  assinatura, senão há vazamento de autorização entre workspaces.
- **Cursor de `listThreads` em `arrival`** (§6.3): ordenar por `min_created`, não `last_at`.
- **`byIngestSource`** (§6.2) é nível-mensagem por design — documentar a divergência sob janela.
- `whatsapp_thread_meta` não tem `workspace_id` direto (deriva de `whatsapp_number_id`);
  por isso a integridade de `disqualify_reason` fica no app, não em FK.
- `arrival` exige `MIN(created_at)` por thread — conferir índice em
  `messages(whatsapp_number_id, identifier, created_at)`.
