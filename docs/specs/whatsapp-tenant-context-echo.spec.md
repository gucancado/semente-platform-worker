# Spec — Echo de contexto de tenant nas respostas WhatsApp (`context` no envelope `whatsapp_v1`)

> Status: draft v1 (2026-07-02).
> Torna cada resposta das tools/rotas `whatsapp_*` **auto-descritiva**, ecoando a qual tenant
> aquele resultado pertence: um bloco `context: { workspaceId, number: { id, label, phone } | null }`
> no topo de todo envelope `whatsapp_v1`. Fonte da verdade = **worker** (envelope REST); o MCP
> herda o echo sem mudança de código porque toda tool já repassa `data` do worker.
> Canon: `src/whatsapp/read-routes.ts`, `src/whatsapp/write-routes.ts`,
> `src/whatsapp/provision-routes.ts` (rota `group-exposure`), `src/whatsapp/numbers.ts`
> (`getNumber`/`WhatsappNumber`), `bloquim-mcp/src/tools/whatsapp_*.ts` +
> `bloquim-mcp/src/tools/_whatsapp_shared.ts` (`textResult`).

## 1. Contexto e motivação

As 7+ tools `whatsapp_*` (diagnóstico/gestão de leads) vivem no **bloquim-mcp** e consomem o
**worker** como fonte REST (contrato `whatsapp_v1`). `workspace_id` + `number_id` são **sempre
explícitos por chamada** — não há "workspace ativo" com estado (e não deve haver: é o
anti-padrão que causa confusão).

O gap: **a resposta não é auto-descritiva**. Toda rota retorna `{ schema: 'whatsapp_v1', ...result }`
sem ecoar de qual `workspaceId`/número aquele dado veio. Rotas que já derivam o número
(`/messages`, `/export`, `/lead`, `/bulk-lead`, `/group-exposure`) têm o objeto na mão e mesmo
assim não o ecoam; `/threads`, `/stats`, `/search` sequer o carregam. O MCP repassa `data` cru
(`textResult(data)`), herdando a lacuna.

**Consequência (risco cognitivo, não de segurança):** um agente operando ≥2 workspaces no mesmo
turno depende 100% da própria memória de "o que consultei" para atribuir cada resultado. Ao
resumir pro usuário pode **misturar/atribuir errado** workspace/número. O isolamento server-side
já está sólido (authz `gateMember`/`gateAdmin` + `logAccess`; `messages`/`export` derivam o
workspace do `number_id`; MCP `assertMember`/`assertAdmin` + `resolveNumber`) — **isso não muda**.
O que falta é a âncora de tenant **no dado**.

## 2. Escopo

- **Worker:** injetar um bloco `context` em **todo** envelope `whatsapp_v1` das rotas WhatsApp
  (leitura + escrita + `group-exposure` + `backfill`), via helper único.
- **MCP:** 11 das 12 tools herdam `context` por passthrough (`textResult(data)`) — **sem mudança**.
  A exceção é o short-circuit local `groups_not_exposed` (`export`/`thread_messages`), que **exige**
  injeção manual do `context` (mudança pequena: estender `resolveNumber` + helper). Ver 4.3.
- **Testes:** asserções de `context` na suíte com Postgres efêmero do worker
  (`tests/whatsapp/*.db.test.ts`).

**Fora de escopo (não reabrir):**
- Modelo de authz (já resolvido — não tocar).
- Qualquer tool/estado de "workspace atual" (anti-padrão que CAUSA a confusão).
- Reintroduzir tools de WhatsApp no MCP do worker (decisão: vivem no bloquim-mcp).
- UI do painel.

## 3. Decisões de design (fechadas com o owner)

- **Fonte da verdade = worker (envelope REST).** Single source of truth, DRY. Confiável mesmo
  para quem consome o REST direto. MCP só repassa.
- **Formato — bloco único no topo do envelope:**
  ```jsonc
  {
    "schema": "whatsapp_v1",
    "context": {
      "workspaceId": "<uuid>",
      "number": { "id": 123, "label": "Comercial SP", "phone": "+5511999999999" } // ou null
    },
    // ...resto do payload da rota (threads/results/messages/ok/etc.)
  }
  ```
- **`context` é O(1) por resposta** (uma vez por envelope, nunca por item). Custo de tokens
  irrisório mesmo em respostas paginadas grandes → **não suprimir em resposta nenhuma**.
- **`context` só em respostas de sucesso (2xx).** Respostas de erro (400/404/500 — `workspace_id`
  ausente, `number_id` não-numérico, actor ausente, número inexistente, gate negado) **não**
  carregam `context`: o workspace pode nem ser válido, e o agente já sabe o que chamou. Os
  critérios de aceite e testes valem para o caminho 2xx. (Refino Codex.)
- **Campos do `number`: `id` + `label` + `phone`** (owner escolheu os 3, mantido após revisão).
  `phone` é o número do **próprio workspace** (não do lead/cliente) e já é exposto por
  `list_numbers`. `label` pode ser `null` (número sem rótulo) — nesse caso vem `null`, sem
  fallback.
  > **Dissídio do reviewer (Codex):** recomendou cortar `phone`, argumentando que o `context` vai
  > no corpo de toda resposta HTTP (logável em Coolify/proxies em cada chamada) e que `number.id`
  > já basta como âncora técnica + `label` como rótulo humano. **Decisão do owner: manter `phone`**
  > — é o número da própria empresa (não de terceiro), já exposto em `list_numbers`, e o rótulo
  > mais citável pelo agente. Reversível trivialmente (dropar 1 campo) se mudar de ideia.
- **`number: null`** nas rotas sem número específico: `/stats` sem `number_id`, `/numbers`,
  `/disqualify-reasons`, `/source-signals`, `/audit`. Nessas, `workspaceId` presente e `number`
  nulo (o array `numbers` já traz os detalhes por número em `list_numbers`).
- **`/audit` sempre `number: null`, mesmo com `number_id` de filtro.** A rota aceita `number_id`
  opcional como filtro, mas o `context.number` fica `null` de propósito (simplificação): o número
  efetivamente filtrado aparece em cada `entries[].numberId` do payload. (Refino Codex.)
- **Autoridade do `workspaceId`:** onde a rota **deriva** o workspace do `number_id` (`/messages`,
  `/export`, `/lead`, `/bulk-lead`, `/group-exposure`, `/backfill`), o `context.workspaceId` vem do
  `num.workspaceId` derivado (autoritativo), **não** do `workspace_id` do query/body. Onde a rota
  é workspace-scoped por query (`/threads`, `/stats`, `/search`, `/numbers`, reasons, signals), vem
  do `workspace_id` já validado pelo `gateMember`/`gateAdmin`.

## 4. Implementação

### 4.1 Helper único (worker)

Novo helper puro (ex.: em `src/whatsapp/tenant-context.ts`) que monta o bloco a partir de um
`WhatsappNumber` **ou** de um `workspaceId` avulso:

```ts
export type TenantContext = {
  workspaceId: string;
  number: { id: number; label: string | null; phone: string | null } | null;
};

export function tenantContext(input: WhatsappNumber): TenantContext;            // número derivado
export function tenantContext(input: { workspaceId: string }): TenantContext;   // sem número
```

- Recebendo um `WhatsappNumber` → `{ workspaceId: n.workspaceId, number: { id, label, phone } }`.
- Recebendo `{ workspaceId }` → `{ workspaceId, number: null }`.

Cada `reply.send({ schema: 'whatsapp_v1', ... })` das rotas WhatsApp passa a incluir
`context: tenantContext(...)`.

### 4.2 Rotas e como cada uma obtém o número

| Rota | Já tem `num`? | Ação |
|---|---|---|
| `GET /whatsapp/threads` | não | `getNumber(number_id)` (1 lookup indexado) → `tenantContext(num)` |
| `GET /whatsapp/search` | não | `getNumber(number_id)` → `tenantContext(num)` |
| `GET /whatsapp/stats` | não | com `number_id`: `getNumber` → `tenantContext(num)`; sem: `tenantContext({ workspaceId })` |
| `GET /whatsapp/threads/:id/messages` | **sim** (`num`) | reuso → `tenantContext(num)` |
| `GET /whatsapp/threads/:id/export` | **sim** (`num`) | reuso → `tenantContext(num)` |
| `GET /whatsapp/numbers` | n/a | `tenantContext({ workspaceId })` (`number: null`) |
| `GET /whatsapp/disqualify-reasons` | n/a | `tenantContext({ workspaceId })` |
| `GET /whatsapp/source-signals` | n/a | `tenantContext({ workspaceId })` |
| `GET /whatsapp/audit` | não | `tenantContext({ workspaceId })` (número opcional; sempre `number: null`) |
| `POST /whatsapp/threads/:id/lead` | **sim** (`num`) | reuso → `tenantContext(num)` |
| `POST /whatsapp/threads/bulk-lead` | **sim** (`num`) | reuso → `tenantContext(num)` |
| `POST /admin/whatsapp/numbers/:id/group-exposure` | **sim** (`n`) | reuso → `tenantContext(n)` |
| `POST /admin/whatsapp/numbers/:id/backfill` (`provision-routes.ts:133`) | **sim** (`n`) | reuso → `tenantContext(n)` |
| reasons/signals `POST` (upsert/deactivate) | n/a | `tenantContext({ workspaceId })` |

> **Rota `backfill`** (`provision-routes.ts:133`) também retorna `schema: 'whatsapp_v1'` e tem `n`
> carregado; incluída para consistência do contrato (não tem tool MCP exposta — é admin-only, mas
> o envelope REST fica uniforme). (Refino Codex.)

- **Custo:** `getNumber` extra só em `threads`/`search`/`stats(com número)` — query por PK
  indexada, barata. As demais reusam objeto já carregado ou não têm número.
- **Ordem vs. authz:** onde a rota é workspace-scoped (`/threads`, `/search`, `/stats`), o
  `getNumber` para o context roda **após** o `gateMember` (não antes) — não introduzir lookup de
  número antes do gate de autorização. O `number_id` já é validado (numérico) e filtrado no SQL
  por `workspace_id`; se `getNumber` retornar `null` (número inexistente/de outro workspace), o
  `context.number` vira `null` e a query segue devolvendo vazio como hoje (sem vazar existência).

### 4.3 MCP (bloquim-mcp)

**Caminho feliz (11 das 12 tools): passthrough sem mudança de código.** `whatsapp_list_threads`/
`search` fazem `textResult({ ...data, groupsHidden })` e as demais `textResult(data)` — o
`context` do worker é repassado automaticamente.

**Exceção que EXIGE mudança no MCP — short-circuit local `groups_not_exposed`.** Em
`whatsapp_export_conversation.ts:17-19` e `whatsapp_thread_messages.ts:22-24`, quando o
identifier é de grupo e o número não expõe grupos, o MCP retorna
`textResult({ error: "groups_not_exposed" })` **sem chamar o worker** — então o `context` sumiria,
violando a promessa de auto-descrição. Correção:
- Estender `resolveNumber` (`_whatsapp_shared.ts`) para também retornar `label` e `phone` (já vêm
  no `/whatsapp/numbers` que ele busca) e o `workspaceId`.
- Adicionar um helper `tenantContext(workspaceId, num)` em `_whatsapp_shared.ts` (espelho do do
  worker) e injetá-lo nesses dois retornos: `textResult({ schema: 'whatsapp_v1', context, error: 'groups_not_exposed' })`.
- Assim o MCP vira uma mudança **pequena e real** (não "zero"), corrigindo a afirmação otimista
  anterior. (Refino Codex.)

**Descrições das tools (opcional, PR separado):** mencionar nas descrições que a resposta inclui
`context` identificando workspace/número ajuda o LLM a citar corretamente ao resumir. Fica fora do
critério de aceite deste ticket (implica re-deploy do MCP por outro motivo).

## 5. Testes

- **Worker (Postgres efêmero, `tests/whatsapp/*.db.test.ts`):** para cada rota, asserção de que a
  resposta traz `context.workspaceId` correto e `context.number` = `{ id, label, phone }` (ou
  `null` onde aplicável). Casos-chave:
  - `threads`/`search`/`stats(com número)`: `number` preenchido com label/phone reais do seed.
  - `stats` sem `number_id`, `numbers`, `disqualify-reasons`, `source-signals`: `number: null`.
  - `messages`/`export`/`lead`/`bulk-lead`: `workspaceId` = derivado do `number_id`
    (autoritativo), não o eventual `workspace_id` do query.
  - número sem `label` → `label: null` no context.
  - **erro 2xx-only:** um caso de erro (ex.: `number_id` não-numérico → 400) confirma que a
    resposta de erro **não** tem `context` (evita regressão da cláusula 2xx-only).
- **Atualizar asserções de envelope existentes:** varrer `tests/whatsapp/*.db.test.ts` por
  matches estritos de envelope (`deepEqual`/`toStrictEqual`/`assert.deepStrictEqual` do body
  inteiro) que quebrariam com o campo novo `context` e ajustá-los. (Refino Codex.)
- **MCP (`bloquim-mcp`, `node --test --import tsx`):** teste do short-circuit `groups_not_exposed`
  garantindo que o retorno agora inclui `context` (workspaceId + number). O passthrough do caminho
  feliz é coberto pelos testes do worker (não duplicar no MCP).

## 6. Riscos e mitigação

- **Consumidores do envelope que fazem parse estrito** (ex.: painel) podem quebrar com campo
  novo? Não: `context` é aditivo; `schema` permanece `whatsapp_v1` (retrocompatível — só adiciona
  chave). Verificar rapidamente que o painel não valida o envelope com `strict()`/rejeição de
  chaves extras.
- **PII (`phone`) em log/telemetria:** o `context` vai no corpo da resposta HTTP, não em
  `logAccess` (que não muda). Sem novo caminho de PII para auditoria.

## 7. Critérios de aceite

1. Toda **resposta de sucesso (2xx)** das rotas `whatsapp_*` do worker retorna `context` no
   envelope, com `workspaceId` autoritativo e `number` = `{ id, label, phone }` (ou `null` onde não
   há número). Respostas de erro (4xx/5xx) **não** carregam `context`.
2. As 12 tools `whatsapp_*` do bloquim-mcp ecoam `context` — 11 por passthrough e o short-circuit
   `groups_not_exposed` por injeção — sem regressão nas flags existentes (`groupsHidden`).
3. Suíte WhatsApp do worker verde no Postgres efêmero, incluindo as novas asserções de `context` e
   as asserções de envelope existentes ajustadas.
4. `typecheck`/`build` verdes nos dois repos; testes do MCP (`node --test`) verdes.
5. Deploy do worker **e** do MCP (mudou por causa do short-circuit) em prod via Coolify.
