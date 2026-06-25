# Handoff — WhatsApp Leads (ciclo de vida + LGPD)

> Cole este prompt num chat novo e limpo. Ele é auto-contido; o chat novo não vê a conversa anterior.

---

Você vai continuar um trabalho de evolução do subsistema de **leads de WhatsApp** da Plataforma Semente. Idioma: PT-BR.

## Contexto do que já foi feito (não refazer)
1. **Triagem de leads concluída** para a conta **Luhma Saúde Integrada** (atendimento domiciliar de saúde, BH). Workspace Bloquim `0d5acf34-51a3-4c91-9cc1-393ebe9e5e6f`, número WhatsApp `number_id=2` (comercial, +553171431880). Foram triadas **741 conversas DM** (a maioria é backfill raso da Evolution — fragmentos de 1 msg). Resultado: **258 leads** + 9 fora-de-escopo + 362 indeterminado + **112 não-clientes**. Os **112 já foram marcados `not_lead`** via MCP (`whatsapp_set_lead_status`). Artefatos: `c:/tmp/triagem-luhma.csv` (741 classificadas: identifier,lead,category) e `c:/tmp/marcar-naolead.txt`.
2. **Spec v2 escrita e revisada** (revisão adversarial; Codex não roda neste Windows — sandbox falha): `c:/Users/gusta/Projetos/semente-platform-worker/docs/specs/whatsapp-leads-lgpd.spec.md`. **Leia inteira primeiro.**
3. **Plano de execução escrito**: `c:/Users/gusta/Projetos/semente-platform-worker/docs/superpowers/plans/2026-06-24-whatsapp-leads-lgpd.md`. **É o seu roteiro.**
4. **Tarefa de consentimento no site criada** no Bloquim (workspace "Operação BeeAds", prioridade alta) — fora do escopo de código deste repo.

## Decisões já fixadas (2026-06-24) — não reabrir
- **Authz (spec §5.1) = opção B**: endpoint interno no Bloquim `(serviceToken, userId, workspaceId)→role`; o worker revalida o ator. JWT_SECRET fica FORA do worker.
- **Reter dados; SEM eliminação/anonimização nesta fase** (spec §5.3 adiado). Risco aceito: art. 18 (exclusão) não atendível ainda; retenção precisa de base legal documentada (dever de guarda, art. 16,I).
- **Escrita = `role === 'admin'` estrito** (`editor`/`owner` não contam).

## Repos e infra (já de pé)
- **Worker** `c:/Users/gusta/Projetos/semente-platform-worker` — Fastify + Drizzle/Postgres. REST `/whatsapp/*` em `src/whatsapp/`, ingestão em `src/webhook/` + `src/whatsapp/backfill.ts`, migrations em `migrations/` (próximas livres: 033+). Coolify app uuid `qlp2n4fi3jlklisftet1y7cz`, FQDN `agentes-worker.beeads.com.br`.
- **MCP** `c:/Users/gusta/Projetos/bloquim-mcp` — tools `whatsapp_*` em `src/tools/`, auth/gate em `src/lib/` (`worker.ts` manda `X-Panel-Token`+`X-Acting-User`; `workspace-access.ts` faz `assertMember`/`assertAdmin`).
- **Bloquim** `c:/Users/gusta/Projetos/beeads-bloquim` (api-server em `repo/artifacts/api-server`) — onde entra o endpoint interno de authz da Fase 1.
- **Painel** `c:/Users/gusta/Projetos/beeads-central-de-dados` — consumidor REST; **verificar se manda `X-Acting-User`** (gate de rollout).
- **Testes:** precisam de Postgres; **não há DB local** (a suíte faz TRUNCATE). Validar local com `pnpm typecheck` + build; suíte roda no servidor.
- **Deploy:** push pra master NÃO auto-deploya de forma confiável → disparar manual via Coolify API `POST http://5.78.199.192:8000/api/v1/deploy?uuid=<app_uuid>` (token Coolify no CLAUDE.md global).
- **Para usar as tools `whatsapp_*` do MCP** no Claude: recarregar o conector `bloquim` no Claude (ToolSearch `select:mcp__claude_ai_bloquim-mcp__...`). Gate: membership(read)/admin(write).

## Seu próximo passo concreto
Execute o plano **subagent-driven** (fresh subagent por task + review entre tasks; skill `superpowers:subagent-driven-development`). Comece pela **Fase 1 (LGPD-base), Task 1: endpoint interno de authz no Bloquim**. Antes de codar:
1. Crie um branch novo (ex.: `feat/whatsapp-leads-lgpd`) — hoje o worker está em `feat/whatsapp-mcp-unify`.
2. Releia a spec v2 e o plano.
3. Confirme os **gates de rollout** do plano (especialmente: painel envia `X-Acting-User`? provisionar `INTERNAL_SERVICE_TOKEN`/`BLOQUIM_SERVICE_TOKEN` no Coolify; deploy worker→MCP).

## Gates humanos pendentes (parar e confirmar com o Gustavo)
- Antes de deployar a authz (Fase 1 Task 3): confirmar que **painel + MCP enviam `X-Acting-User` em toda chamada `/whatsapp/*`** (senão quebra leitura legítima em prod).
- Provisionar os service tokens nos envs antes da Task 3.
- A spec marca eliminação/retenção como decisão jurídica — a base legal de retenção (Task 5) deve ser validada com o jurídico/DPO.

Os arquivos de spec/plano/handoff ainda **não foram commitados** (estão untracked em `docs/`). Commite-os no branch novo no início.
