# semente-platform-worker

Worker multi-tenant da plataforma Semente. Único serviço Node/TS que expõe:

- `POST /webhook` — recebe eventos do Evolution API (WhatsApp), filtra, cria tarefas no Bloquim.
- REST `GET/POST/PATCH/DELETE /contacts` — CRUD humano (curl, ops, scripts).
- MCP `GET /mcp` — MCP server via HTTP streamable transport. Tools: `add_contact_route`, `lookup_contact`, `list_contacts_by_workspace`, `update_contact_route`, `delete_contact_route`.
- `GET /health` — probe.

Banco dedicado (Postgres). Schema em `migrations/001_init.sql`.

Documentação completa: `c:/Users/gusta/Projetos/agente-semente/SPEC.md` §10.4-10.5 e §4.3.1.

## Auth

Todos os endpoints (exceto `/health`) requerem header `X-Agent-Token`. Tokens por agente são carregados de env vars no startup. Mapping `agent → token` em `config.ts`.

## Dev

```bash
pnpm install
cp .env.example .env  # preencher
pnpm migrate          # aplica migrations
pnpm dev              # tsx watch
```

## Deploy

Coolify, projeto `semente`, serviço `semente-platform-worker`. Postgres companion: `semente-worker-postgres`. Push em `master` dispara rebuild.

## Rodando testes que tocam DB

Tests em `tests/admin/*.test.ts` e `tests/goals/*.test.ts` precisam de Postgres
rodando. Use o mesmo `DATABASE_URL` do dev local:

    DATABASE_URL=postgres://semente:senha@localhost:5432/semente_dev pnpm test

Cada test trunca as tabelas de scheduling antes de rodar. Não roda contra
banco de produção (vai apagar dados).

## Estado

Esqueleto. Implementar gradualmente:

1. [ ] DB setup + migrations
2. [ ] REST `/contacts` CRUD
3. [ ] Webhook handler (filtro + criação de tarefa Bloquim)
4. [ ] MCP server + tools
5. [ ] Token management (multi-tenant)
6. [ ] Bloquim client (REST ou MCP-as-client)
7. [ ] Observability (logs estruturados, métricas para Uptime Kuma)

## Admin endpoints

Endpoints sob `/admin/*` consumidos pela GUI `agentes.beeads.com.br` para
configurar projetos, goals e agendas do agente.

- Auth: header `X-Owner-Token` (env `OWNER_ADMIN_TOKEN`, gerado com
  `openssl rand -hex 32`).
- Spec completa: `docs/superpowers/specs/2026-05-25-google-calendar-scheduling-design.md`
  no repo `gucancado/semente-platform`.

### Rotas

| Método | Path | Função |
|---|---|---|
| POST   | /admin/agents/:agent/projects                                  | criar projeto |
| GET    | /admin/agents/:agent/projects                                  | listar |
| GET    | /admin/agents/:agent/projects/:slug                            | detalhe + goals + agendas |
| PATCH  | /admin/agents/:agent/projects/:slug                            | editar display_name |
| POST   | /admin/agents/:agent/projects/:slug/goals                      | habilitar/atualizar goal |
| DELETE | /admin/agents/:agent/projects/:slug/goals/:goal_type           | desabilitar goal |
| POST   | /admin/agents/:agent/projects/:slug/agendas                    | criar agenda |
| GET    | /admin/agents/:agent/projects/:slug/agendas                    | listar agendas |
| PATCH  | /admin/agents/:agent/projects/:slug/agendas/:agendaId          | editar |
| DELETE | /admin/agents/:agent/projects/:slug/agendas/:agendaId          | soft-delete (active=false) |

## Repositório de transcrições (episódios)

### O que é

O subsistema de episódios persiste conversas estruturadas — reuniões importadas do Fireflies e mensagens WhatsApp — em duas tabelas relacionais: `episodes` (cabeçalho com metadados de proveniência) e `episode_turns` (transcrição por falante). Cada gravação emite um evento `episodio_pronto_v1` via outbox transacional (tabela `event_outbox`), garantindo entrega at-least-once para assinantes internos (ex.: agente Lua).

O **importador Fireflies** (`src/cli/import-fireflies.ts`) busca reuniões da API GraphQL do Fireflies, faz upload do JSON bruto no R2, aplica atribuição automática por domínio de e-mail dos participantes (tabela `workspace_domains`) e grava o episódio com todos os turnos em uma única transação.

O **handler Recall** (receptor de webhooks de gravação de reunião ao vivo) está planejado como incremento futuro e não faz parte desta versão.

### Variáveis de ambiente (novas)

| Variável | Obrigatório | Descrição |
|---|---|---|
| `FIREFLIES_API_KEY` | Para importador | Chave de API da conta Fireflies (Settings → API) |
| `R2_ENDPOINT` | Para importador | Ex.: `https://<account>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | Para importador | Access key do bucket R2 |
| `R2_SECRET_ACCESS_KEY` | Para importador | Secret key do bucket R2 |
| `R2_BUCKET_EPISODES` | Para importador | Nome do bucket onde ficam os JSONs brutos e áudios |
| `INTERNAL_WORKSPACE_ID` | Para importador | UUID do workspace padrão (usado quando nenhum domínio bate) |
| `INTERNAL_DOMAINS` | Opcional | Domínios internos ignorados na atribuição, separados por vírgula (ex.: `beeads.com.br`) |
| `FREEMAIL_DOMAINS_EXTRA` | Opcional | Domínios de e-mail gratuito extras para ignorar na atribuição (além da lista padrão) |
| `EVENT_SUBSCRIBERS_JSON` | Para outbox | JSON array de assinantes do outbox: `[{"url":"https://...","secret":"...","event_types":["episodio_pronto_v1"]}]` |
| `OUTBOX_POLL_INTERVAL_MS` | Opcional | Intervalo de polling do outbox em ms (padrão: 5000) |
| `OUTBOX_BATCH_SIZE` | Opcional | Tamanho do lote por ciclo do outbox (padrão: 50) |

### Rodando o importador Fireflies

Sempre execute com `--dry-run` antes da primeira importação real para verificar o que seria gravado sem alterar o banco:

```bash
FIREFLIES_API_KEY=... pnpm import:fireflies --dry-run
```

Importação real (processa reuniões das últimas 24h por padrão):

```bash
FIREFLIES_API_KEY=... pnpm import:fireflies
```

Para re-importar reuniões já existentes (bumpa a revision e re-emite o evento de outbox):

```bash
FIREFLIES_API_KEY=... pnpm import:fireflies --force
```

Filtros úteis:

```bash
# Importar reuniões de uma janela específica
pnpm import:fireflies --since 2026-06-01 --until 2026-06-07

# Importar apenas uma reunião pelo external_id do Fireflies
pnpm import:fireflies --id abc123xyz
```

### Adicionando mapeamento de domínio → workspace

Para que a atribuição automática funcione, registre os domínios dos clientes na tabela `workspace_domains`:

```sql
INSERT INTO workspace_domains (workspace_id, domain)
VALUES
  ('uuid-do-workspace-cliente', 'cliente.com.br'),
  ('uuid-do-workspace-cliente', 'filial.cliente.com.br')
ON CONFLICT (workspace_id, domain) DO NOTHING;
```

Cada domínio deve mapear para um único workspace. Domínios listados em `INTERNAL_DOMAINS` e freemail (gmail, hotmail, etc.) são ignorados na atribuição — participantes com esses domínios não contam para determinar o workspace.

### Endpoints de leitura

| Método | Path | Descrição |
|---|---|---|
| GET | `/episodes` | Lista episódios com filtros opcionais: `workspace_id`, `fonte`, `since`, `until`, `orphans=true`, `limit`, `cursor` (paginação cursor-based) |
| GET | `/episodes/:id` | Cabeçalho de um episódio pelo id numérico |
| GET | `/episodes/:id/turns` | Turnos de um episódio (transcrição completa) |

Auth: header `X-Agent-Token` (mesmo token dos demais endpoints de agente).

### Ferramentas MCP

Disponíveis via `GET /mcp` para agentes autenticados:

- **`episodes_list`** — lista cabeçalhos de episódios por workspace/período; suporta todos os filtros do REST; retorna `{ schema: 'episodio_v1', items, next_cursor }`.
- **`episodes_get`** — busca episódio completo (turnos incluídos) pelo `id` numérico; retorna `{ schema: 'episodio_v1', ...ep }` ou `"null"` se não encontrado.

### Operações de outbox

O outbox entrega o evento `episodio_pronto_v1` para cada assinante configurado em `EVENT_SUBSCRIBERS_JSON`. O header `X-Event-Id` em cada request ao assinante permite deduplicação idempotente. O HMAC-SHA256 do corpo vai no header `X-Webhook-Signature` (formato `sha256=<hex>`).

Monitorar entregas mortas (falharam todas as tentativas de retry):

```
GET /admin/outbox/dead
X-Owner-Token: <OWNER_ADMIN_TOKEN>
```

Reprocessar uma entrega manualmente pelo id:

```
POST /admin/outbox/deliveries/:id/replay
X-Owner-Token: <OWNER_ADMIN_TOKEN>
```

## Runbook — habilitar pgvector (pré-requisito da Lua, migration 019)

A imagem Postgres do Coolify (`semente-worker-postgres`) NAO traz a extensao `vector` por
padrao. Trocar para a imagem oficial pgvector e operacao de PRODUCAO — fazer em janela fora
de horario comercial. **Este runbook precede tudo da Lua** (migrations 019+ e o scheduler).

1. Backup verificado: `pg_dump` completo + snapshot Hetzner da VM. CONFERIR que o dump restaura.
2. `SELECT version();` — anotar a major version do Postgres em producao.
3. Coolify: trocar a imagem do servico para `pgvector/pgvector:pg<major>` (MESMA major = data dir
   compativel, troca drop-in).
4. Restart. Sanity numa sessao manual:
   - `CREATE EXTENSION IF NOT EXISTS vector;`
   - `SELECT extversion FROM pg_extension WHERE extname='vector';` — exigir **>= 0.8**
     (`hnsw.iterative_scan` da busca hibrida depende disso).
   - Smoke das tabelas existentes (`SELECT count(*) FROM episodes;`).
   - Confirmar que o worker reconecta (`GET /health`).
5. So entao: deploy do worker com as migrations 019–023 (rodam no startup via `src/migrate.ts`).

Rollback: se a extensao falhar, voltar a imagem anterior (data dir intacto, nenhuma migration
nova aplicada). Dimensionamento: ~8–12k chunks, vetor 1024 float32 = 4KB => ~50MB vetores +
HNSW => centenas de MB (folga sob o teto <1GB).

## Runbook — Lua (memória noturna)

A Lua transforma episodios em tres camadas de memoria (episodica vetorizada · fatos
bi-temporais · condutas) num **batch noturno** dentro do worker. Roda via `setInterval` de 60s
(`src/lua/scheduler.ts`), na janela local **America/Sao_Paulo** `[LUA_WINDOW_START, LUA_WINDOW_END)`
(default 02h–05h). O scheduler **sempre inicia** mas se auto-verifica a cada tick: enquanto
`LUA_ENABLED=false` ou fora da janela, e no-op.

> **Pre-requisito:** o runbook pgvector acima DEVE estar concluido antes de ligar a Lua.

### Ligar / desligar (master switch — SEGURANCA)

`LUA_ENABLED` (env do Coolify) e o portao mestre. Parse **estrito**: aceita literalmente
`true` ou `false` (qualquer outro valor reprova o startup). **`LUA_ENABLED=false` desliga** —
nao confie em `z.coerce.boolean` (coagiria `"false"` para `true`).

- **So ligar (`LUA_ENABLED=true`) apos o gate de eval verde + OK humano.** A memoria entra no
  contexto de TODOS os agentes; extracao ruim e pior que memoria nenhuma. Ligar = comeca a
  gastar API (OpenAI embeddings + Anthropic extracao) e a gravar memoria.
- Para desligar com urgencia: setar `LUA_ENABLED=false` no Coolify e redeploy. O tick em voo
  termina o run corrente; o proximo tick e no-op.

Envs da janela/concorrencia: `LUA_WINDOW_START` (default 2), `LUA_WINDOW_END` (default 5),
`LUA_CONCURRENCY` (default 2), `LUA_MAX_ATTEMPTS` (default 4). Modelos:
`LUA_EXTRACTION_MODEL` / `LUA_JUDGE_MODEL` / `LUA_RECAP_MODEL` (default `claude-sonnet-4-6`).

### Observabilidade e tripwires

`GET /admin/lua/runs?limit=N` (X-Owner-Token) lista os runs com `stats`:
`episodes_processed/failed`, `facts_new/superseded/flagged`, `statuses`, `recaps`,
`condutas_proposed`, `backlog`, `duration_ms`. Tripwires a vigiar:

- **backlog > 0 em duas noites seguidas** — a fila nao drena na janela; investigar lentidao de
  API ou aumentar a janela/concorrencia.
- **duration_ms** subindo — run nao cabe na janela (hard stop deixando episodios `pending`).
- **custo/noite** — cruzar tokens reais (stats) com a estimativa (~<$0,30/noite de regime).
- **RAM** — observada via Coolify (teto assumido <1GB para os vetores).

### DLQ, replay e reprocessamento

```
GET  /admin/lua/processing?status=dead|failed     # fila / DLQ
POST /admin/lua/processing/:id/replay             # dead -> pending (zera tentativas, preserva last_error)
POST /admin/lua/episodes/:id/reprocess            # forca reprocessamento (semantica de revision)
```
Todos com `X-Owner-Token`.

### Triagem de `needs_review` (fatos suspeitos)

```
GET   /admin/lua/facts?workspace_id=<ws>&needs_review=true    # lista flags
PATCH /admin/lua/facts/:id                                    # { action: 'confirm' | 'invalidate' | 'supersede_by' }
```
`needs_review` marca: confianca baixa, contradicao ambigua, instrucao imperativa suspeita
(defesa de memory-poisoning) ou re-atribuicao de workspace. **Confirmar** legitima o fato;
**invalidate**/**supersede_by** o retiram da memoria vigente com auditoria em `review_note`.
Erro de extracao triado vira caso novo do golden set (o set e vivo).

### Rodar o eval (gate de producao)

```
pnpm eval:lua
```
Roda a extracao real sobre o golden set (`eval/lua/golden.jsonl`) e imprime precisao/recall/
alucinacao por tipo. Gate default: precisao >= 0,85 global / 0,75 por tipo, recall >= 0,75,
alucinacao = 0, injection = 0. **`LUA_ENABLED` so vai a `true` com o gate verde.**

### Bootstrap do acervo

```
pnpm lua:bootstrap --dry-run        # estima custo SEM chamar LLM nem gravar (livre)
pnpm lua:bootstrap                   # processa o acervo em occurred_at ASC (gasta API — so com OK)
```

### Rotacao das chaves de API

`OPENAI_API_KEY` (embeddings) e `ANTHROPIC_API_KEY` (extracao/judge/narrativa) vivem **so** no
env do Coolify (nunca no repo). Para rotacionar: gerar a chave nova no dashboard do provedor,
atualizar a env no Coolify, redeploy. Ausencia da chave NAO derruba o startup — a busca degrada
para `lexical_only` e o batch falha explicitamente no proximo tick (recuperavel via replay).

### Regenerar um recap

Recap e idempotente por semana (UNIQUE workspace+period_start). Para regenerar, apagar antes:
```
DELETE /admin/lua/recaps/:id        # X-Owner-Token
```
