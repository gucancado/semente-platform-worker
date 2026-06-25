# Runbook de deploy — WhatsApp Leads + LGPD

Sequência para colocar em produção o trabalho dos PRs **worker #18**, **bloquim #17**, **bloquim-mcp #3**. Todos os apps do Coolify fazem deploy de `master`/`main` e **não auto-deployam no push** (disparo manual via API).

## 0. Pré-condições (gates)

| Gate | Status | Ação |
|---|---|---|
| (a) Painel manda `X-Acting-User` | ✅ verificado 2026-06-25 | nenhuma — `beeads-central-de-dados` já manda em todo `/whatsapp/*` |
| (b) `INTERNAL_API_SECRET` igual nos 2 apps | ✅ verificado (mesmo hash no Coolify worker + bloquim-api) | nenhuma |
| (c) Ordem de deploy worker→MCP / Bloquim primeiro | ⏳ seguir este runbook | — |
| (d) Jurídico valida retenção + suíte DB no servidor | ⏳ **pendente** | ver §1 |

## 1. Antes do merge

1. **Suíte DB no servidor** (não roda local — faz TRUNCATE; **NÃO rodar contra prod**, usar Postgres de teste/staging):
   - worker: `pnpm test` (precisa `DATABASE_URL` de um banco de teste). Valida bulk transacional, stats, migrations 033/034/035, meta_log.
   - bloquim api-server: `pnpm test` (smoke do `internalAuthz.smoke.test.ts` + outros; precisa DB de teste + `INTERNAL_API_SECRET` no env).
2. **Jurídico/DPO** assina a base legal de retenção (`docs/lgpd/registro-operacoes.md`). Reter dados, sem eliminação nesta fase (decisão registrada).

## 2. Merge (qualquer ordem; PRs são aditivos e MERGEABLE em master)

- bloquim **#17**, worker **#18**, bloquim-mcp **#3**.

## 3. Deploy — ORDEM OBRIGATÓRIA: Bloquim → worker → MCP

Coolify API base `http://5.78.199.192:8000/api/v1`, header `Authorization: Bearer <COOLIFY_TOKEN>` (token no CLAUDE.md global; rotaciona ~mensal).

### 3.1 Bloquim api-server (dependência da authz do worker)
```
POST /api/v1/deploy?uuid=vtam7v68bqpnqgn5abg367su
```
Monitorar `GET /api/v1/deployments/<uuid>` até `finished`. Smoke (do servidor, secret real):
```
curl -s -X POST https://bloquim.beeads.com.br/api/internal/authz/workspace-role \
  -H "X-Internal-Secret: $INTERNAL_API_SECRET" -H "Content-Type: application/json" \
  -d '{"userId":"<uuid de um admin>","workspaceId":"<uuid do ws>"}'
# espera 200 {"role":"admin"}; sem header -> 401; secret ausente -> 503
```

### 3.2 Worker (aplica migrations 033/034/035 + liga a authz)
```
POST /api/v1/deploy?uuid=qlp2n4fi3jlklisftet1y7cz
```
- **Migrations:** confirmar que o deploy roda `pnpm migrate` (runner `src/migrate.ts`, idempotente, aplica só as novas; cada uma em transação). Se o start não migra, rodar `pnpm migrate` no container com o `DATABASE_URL` de prod.
- Smoke (membership real):
```
# member -> 200; ator ausente -> 400; não-membro -> 403
curl -s "https://agentes-worker.beeads.com.br/whatsapp/numbers?workspace_id=<ws>" \
  -H "X-Panel-Token: $PANEL_TOKEN" -H "X-Acting-User: <userId membro>"
```

### 3.3 bloquim-mcp (só DEPOIS do worker — anuncia filtros que o worker já suporta)
```
POST /api/v1/deploy?uuid=ohimzhcb5pafkwusy1ff3lsz
```
- No Claude: **recarregar o conector `bloquim`** para puxar as tools novas (`whatsapp_set_lead_status_bulk`, `whatsapp_stats`) e os campos/filtros.

## 4. Verificação pós-deploy

- Painel `painel.beeads.com.br` → aba WhatsApp de um workspace: lista threads (200), marca lead (admin). Confirmar que **não-admin** recebe 403 na escrita e **não-membro** 403 na leitura.
- Conferir linhas em `whatsapp_access_log` após uma leitura/escrita (audit).
- MCP: `whatsapp_stats` (member) e `whatsapp_set_lead_status_bulk` (admin) respondem.

## 5. Rollback

- As mudanças são **aditivas** e **fail-closed**. Se a authz causar 401/500 inesperado: confirmar `INTERNAL_API_SECRET` idêntico nos 2 apps; em último caso, redeploy do worker no commit anterior (Coolify) reverte o gate. **Migrations não são revertidas** (colunas/tabelas novas são inofensivas se não usadas) — coerente com "reter, não apagar".

## Notas

- `feat/whatsapp-mcp-unify` (worker) e `feat/whatsapp-tools` (mcp) **já estão em master** (mergeados via #17/#2). Bases dos PRs LGPD = master, limpas.
- Bug pré-existente fora de escopo: cursor µs-vs-ms do `listThreads` (paginação) — task própria.
