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
  (leitura + escrita + `group-exposure`), via helper único.
- **MCP:** **zero mudança de comportamento de runtime** — as tools já fazem `textResult(data)` e
  passam a ecoar `context` automaticamente. (Ajuste opcional só em descrições de tool e 1 teste
  de passthrough.)
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
- **Campos do `number`: `id` + `label` + `phone`** (owner escolheu os 3). `phone` é o número do
  **próprio workspace** (não do lead/cliente) e já é exposto por `list_numbers`. `label` pode ser
  `null` (número sem rótulo) — nesse caso vem `null`, sem fallback.
- **`number: null`** nas rotas sem número específico: `/stats` sem `number_id`, `/numbers`,
  `/disqualify-reasons`, `/source-signals`. Nessas, `workspaceId` presente e `number` nulo (o
  array `numbers` já traz os detalhes por número em `list_numbers`).
- **Autoridade do `workspaceId`:** onde a rota **deriva** o workspace do `number_id` (`/messages`,
  `/export`, `/lead`, `/bulk-lead`, `/group-exposure`), o `context.workspaceId` vem do
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
| `GET /whatsapp/audit` | não | `tenantContext({ workspaceId })` (número opcional; manter simples: `number: null`) |
| `POST /whatsapp/threads/:id/lead` | **sim** (`num`) | reuso → `tenantContext(num)` |
| `POST /whatsapp/threads/bulk-lead` | **sim** (`num`) | reuso → `tenantContext(num)` |
| `POST /admin/whatsapp/numbers/:id/group-exposure` | **sim** (`n`) | reuso → `tenantContext(n)` |
| reasons/signals `POST` (upsert/deactivate) | n/a | `tenantContext({ workspaceId })` |

- **Custo:** `getNumber` extra só em `threads`/`search`/`stats(com número)` — query por PK
  indexada, barata. As demais reusam objeto já carregado ou não têm número.
- **Ordem vs. authz:** onde a rota é workspace-scoped (`/threads`, `/search`, `/stats`), o
  `getNumber` para o context roda **após** o `gateMember` (não antes) — não introduzir lookup de
  número antes do gate de autorização. O `number_id` já é validado (numérico) e filtrado no SQL
  por `workspace_id`; se `getNumber` retornar `null` (número inexistente/de outro workspace), o
  `context.number` vira `null` e a query segue devolvendo vazio como hoje (sem vazar existência).

### 4.3 MCP (bloquim-mcp)

Nenhuma mudança de runtime necessária: `whatsapp_list_threads`/`search` fazem
`textResult({ ...data, groupsHidden })` e as demais `textResult(data)` — o `context` do worker é
repassado automaticamente. Opcional (nice-to-have, não bloqueante):
- Mencionar nas descrições das tools que a resposta inclui `context` identificando
  workspace/número (ajuda o LLM a usar o campo ao resumir).

## 5. Testes

- **Worker (Postgres efêmero, `tests/whatsapp/*.db.test.ts`):** para cada rota, asserção de que a
  resposta traz `context.workspaceId` correto e `context.number` = `{ id, label, phone }` (ou
  `null` onde aplicável). Casos-chave:
  - `threads`/`search`/`stats(com número)`: `number` preenchido com label/phone reais do seed.
  - `stats` sem `number_id`, `numbers`, `disqualify-reasons`, `source-signals`: `number: null`.
  - `messages`/`export`/`lead`/`bulk-lead`: `workspaceId` = derivado do `number_id`
    (autoritativo), não o eventual `workspace_id` do query.
  - número sem `label` → `label: null` no context.
- **MCP:** 1 teste leve de passthrough (código puro, `node --test --import tsx`) garantindo que
  o wrapper não descarta `context` — ou, se custoso, cobrir só via inspeção do `textResult`.

## 6. Riscos e mitigação

- **Consumidores do envelope que fazem parse estrito** (ex.: painel) podem quebrar com campo
  novo? Não: `context` é aditivo; `schema` permanece `whatsapp_v1` (retrocompatível — só adiciona
  chave). Verificar rapidamente que o painel não valida o envelope com `strict()`/rejeição de
  chaves extras.
- **PII (`phone`) em log/telemetria:** o `context` vai no corpo da resposta HTTP, não em
  `logAccess` (que não muda). Sem novo caminho de PII para auditoria.

## 7. Critérios de aceite

1. Toda rota `whatsapp_*` do worker retorna `context` no envelope, com `workspaceId` autoritativo
   e `number` = `{ id, label, phone }` (ou `null` onde não há número).
2. As 12 tools `whatsapp_*` do bloquim-mcp ecoam `context` (verificado por chamada real ou teste
   de passthrough), sem regressão nas flags existentes (`groupsHidden`).
3. Suíte WhatsApp do worker verde no Postgres efêmero, incluindo as novas asserções de `context`.
4. `typecheck`/`build` verdes nos dois repos.
5. Deploy do worker (e do MCP, se descrições mudarem) em prod via Coolify.
