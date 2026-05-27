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
