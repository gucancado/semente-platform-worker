# Task 3 Report — Módulo `disqualify-reasons.ts` (queries puras)

## Status
DONE — typecheck EXIT 0, módulo implementado, testes escritos.

## Arquivos criados
- `src/whatsapp/disqualify-reasons.ts` — módulo de queries puras (4 funções)
- `tests/whatsapp/disqualify-reasons.test.ts` — suite de testes (server-gated)

## Funções implementadas

### `listDisqualifyReasons(pool, { workspaceId, includeInactive })`
LEFT JOIN com `whatsapp_disqualify_reason_defaults` para obter `sort_order`;
`COALESCE(d.sort_order, 999)` faz códigos customizados ordenarem por último, depois por `r.code`.
Filtro `AND r.active = TRUE` omitido quando `includeInactive=true`.
Mapeamento: `active === true` (boolean estrito), `sortOrder` via `Number()`.

### `upsertDisqualifyReason(pool, { workspaceId, code, label, createdBy })`
CTE `prev` captura `active` antes do upsert. `RETURNING (SELECT prev_active FROM prev)`:
- `NULL` → linha nova → `reactivated: false`
- `true` → já estava ativa → `reactivated: false`
- `false` → estava inativa → `reactivated: true`

Não usa `xmax<>0` (inseguro: detecta UPDATE vs INSERT, não reativação).
`created_by` só é escrito no INSERT; DO UPDATE não toca o campo (preserva criador original).

### `deactivateDisqualifyReason(pool, { workspaceId, code })`
UPDATE simples. Idempotente: zero linhas afetadas não lança erro.

### `seedDefaultReasons(pool, workspaceId)`
`INSERT INTO ... SELECT FROM whatsapp_disqualify_reason_defaults ... ON CONFLICT DO NOTHING`.
Idempotente por design — segunda chamada não duplica nenhum row.

## Testes (RED/GREEN)

### RED
Antes de criar o módulo: `import ... from '../../src/whatsapp/disqualify-reasons.js'`
falha com `ERR_MODULE_NOT_FOUND` (runtime) e `tsc` reporta erro de tipo (compile-time).

### GREEN (requer Postgres no servidor)
- `listDisqualifyReasons`: retorna só ativos por default; `includeInactive=true` retorna todos;
  `interno_equipe` (sort_order=1) vem primeiro, código custom (sem default) vem por último com sortOrder=999.
- `upsertDisqualifyReason`: novo → `reactivated:false`; deactivate+upsert → `reactivated:true`;
  relabel de ativo → `reactivated:false` e label atualizado.
- `deactivateDisqualifyReason`: não lança para código ausente nem para já inativo.
- `seedDefaultReasons`: duas chamadas consecutivas → count=11 (sem duplicatas); todos ativos.

### Verificação local
`pnpm typecheck` (tsc --noEmit) → EXIT 0, zero erros. Suite completa roda no servidor via DATABASE_URL.

## Preocupações / observações
- Nenhuma preocupação. Implementação direta, reactivation semantics corretas nos 3 casos.
- `whatsapp_disqualify_reason_defaults` não é truncada nos testes (migration 037 já popula
  no servidor com 11 rows estáveis); testes limpam só `whatsapp_disqualify_reasons` por workspace de teste.

---

## Fix 1 — Qualidade pós-entrega (2026-06-25)

### O que mudou

**`src/whatsapp/disqualify-reasons.ts` — `upsertDisqualifyReason`**
- Substituído `rows[0]?.prev_active` (optional chaining silencioso) por:
  ```ts
  const row = rows[0];
  if (!row) throw new Error('upsertDisqualifyReason: no row returned');
  return { reactivated: row.prev_active === false };
  ```
- `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` sempre retorna exatamente uma linha;
  o optional chaining mascarava um estado impossível como "linha nova". Agora a invariante é
  expressa explicitamente: se o DB violar a promessa, o erro é óbvio em vez de silencioso.
  Comportamento nos 3 casos reais (NULL/true/false) é idêntico.

**`tests/whatsapp/disqualify-reasons.test.ts` — teste de `deactivateDisqualifyReason`**
- Adicionado novo teste `'deactivateDisqualifyReason: marca active=FALSE no DB'` antes do
  teste de idempotência existente.
- O novo teste: insere linha ativa, chama `deactivateDisqualifyReason`, consulta o DB
  diretamente e asserta `active === false`; depois chama uma segunda vez e confirma que
  `active` continua `false` e não lança.
- Teste anterior (`'idempotente (já inativo ou ausente não falha)'`) mantido intacto.

### Por que o teste fortalecido prova comportamento real

O novo teste executa contra Postgres real (via `DATABASE_URL` no servidor):
- `pool.query` real faz um UPDATE concreto — não há mock de retorno.
- A consulta de verificação `SELECT active FROM ...` após o UPDATE lê o estado persistido
  no banco, não um valor em memória, provando que o UPDATE efetivamente escreveu `FALSE`
  na coluna.
- A segunda chamada com verificação posterior prova idempotência observável no DB, não
  apenas ausência de exceção.

### Typecheck
`pnpm typecheck` (tsc --noEmit) → EXIT 0, zero erros.

### Arquivo de teste
`tests/whatsapp/disqualify-reasons.test.ts`
