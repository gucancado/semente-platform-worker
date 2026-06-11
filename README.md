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
