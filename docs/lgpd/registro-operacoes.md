# Registro de operações de tratamento — WhatsApp Leads (LGPD)

> Artefato de conformidade (LGPD art. 37 — registro das operações de tratamento). Escopo: subsistema de leads de WhatsApp da Plataforma Semente (`semente-platform-worker` + `bloquim-mcp` + painel + endpoint interno do Bloquim). Fonte canônica de design: [`docs/specs/whatsapp-leads-lgpd.spec.md`](../specs/whatsapp-leads-lgpd.spec.md) (§5).
>
> Status: **v1** — formaliza a decisão de **reter dados sem eliminação nesta fase** (spec §5.3/§5.4 adiados). **Pendência humana:** validar a base legal de retenção com o jurídico/DPO antes de tratar este registro como definitivo (gate (d) do plano).

## 1. Identificação

- **Controlador:** BeeAds (operação Plataforma Semente). Por workspace, o titular do dado de atendimento é o cliente final (lead) que conversa via WhatsApp com a conta atendida (ex.: Luhma Saúde Integrada).
- **Operador técnico:** worker `semente-platform-worker` (ingestão Evolution/Cloud, persistência, REST/MCP de leitura e curadoria de leads).
- **Encarregado (DPO):** *a designar / confirmar.*

## 2. Finalidade do tratamento

Gestão de relacionamento e qualificação de leads originados em conversas de WhatsApp: triagem (interessado × não-interessado), qualificação do funil, e atendimento. O tratamento existe para **operar o atendimento comercial/serviço** do workspace dono do número.

## 3. Categorias de dados pessoais tratados (inventário)

Mapeamento técnico real (verificado no código — spec §0 e §5.3):

| Categoria | Onde vive (tabela/coluna) |
|---|---|
| Conteúdo de mensagens (texto livre — pode conter dado sensível: saúde) | `messages.text`, `messages.author` |
| Identificadores de contato (telefone/JID, nome de exibição) | `messages.identifier`, `webhook_logs.push_name`, `webhook_logs.message_text` |
| Nome/assunto de grupo | `whatsapp_groups.subject` |
| Derivados/embeddings com texto | `episodes`, `episode_chunks` |
| Estado de curadoria de lead | `whatsapp_thread_meta` (+ `whatsapp_thread_meta_log` — histórico de transições) |
| Trilha de acesso (auditoria) | `whatsapp_access_log` |
| Resíduos transitórios | `pending_triggers`, `event_outbox` |

⚠️ **Dado sensível (art. 11):** contas de saúde (ex.: Luhma — atendimento domiciliar) implicam que o conteúdo das mensagens pode conter **dado de saúde**. O tratamento de dado sensível exige base legal específica do art. 11 (não só do art. 7) — **a confirmar com jurídico**.

## 4. Base legal

- **Tratamento (operação do atendimento):** execução de contrato / legítimo interesse / consentimento, conforme o fluxo de entrada do lead. Para `source=site`, o **consentimento** é capturado no formulário do site (tarefa separada no Bloquim — captura de consentimento LGPD; fora deste repo).
- **Retenção (guarda dos dados após o tratamento ativo):** **dever de guarda** — art. 16, I (cumprimento de obrigação legal/regulatória; guarda fiscal e, no caso de saúde, prontuário/registro de atendimento). **A validar com jurídico/DPO** que o prazo e a base se aplicam a este conjunto de dados.

## 5. Política de retenção (decisão desta fase — 2026-06-24)

- **Decisão:** **reter os dados, SEM expurgo automático e SEM tooling de eliminação/anonimização nesta fase** (spec §5.3 e §5.4 adiados; decisões 2 e 3 da spec §8).
- **Minimização na entrada:** o backfill importa só o necessário (`BACKFILL_SINCE_DAYS`/config por número) — minimização mesmo retendo (spec §5.4).
- **Job de anonimização por inatividade:** fora de escopo nesta fase.

## 6. Medidas de segurança e governança implementadas (Fase 1)

- **Controle de acesso defense-in-depth (spec §5.1):** o ator (`X-Acting-User`) é **revalidado server-to-server** contra a membership real do workspace no Bloquim (endpoint interno `POST /api/internal/authz/workspace-role`, auth `X-Internal-Secret`). Leitura exige membro (`role≠null`); escrita exige `admin` estrito (revalidação **sem cache** para escrita — ex-admin não escreve na janela do TTL).
- **Trilha de auditoria (spec §5.2):** toda leitura sensível (`list_threads`, `thread_messages`, `search`, `export`) e escrita (`set_lead`) é registrada em `whatsapp_access_log` (ator, ação, workspace, número, identifier, meta). Transições de lead em `whatsapp_thread_meta_log` (campo/old/new/ator).
- **Escopo de workspace no SQL:** rotas de número derivam o workspace autoritativo do `number_id` (não confiam no `workspace_id` do caller); `listThreadMessages` ganhou backstop `AND workspace_id` — fecha vazamento cross-workspace.
- **Grupos ocultos por padrão** (hard-gate MCP-only).

## 7. Risco aceito conscientemente

- **Art. 18, VI (eliminação a pedido do titular) NÃO é atendível** até a Fase de eliminação/anonimização (spec §5.3) ser implementada. Um pedido de exclusão de titular hoje não tem ferramenta de atendimento — inventário das tabelas a tocar já documentado em spec §5.3 para quando for priorizado.
- **Retenção sem base legal formalmente validada:** este registro assume dever de guarda (art. 16, I), **pendente de validação jurídica** (gate (d)).

## 8. Quando reabrir / próximos passos

1. Validar com jurídico/DPO: base legal de retenção (art. 16), base de dado sensível (art. 11), prazos.
2. Priorizar a Fase de eliminação/anonimização (spec §5.3) para tornar art. 18 atendível: hard-delete + anonymize por contato/thread tocando TODAS as tabelas do inventário (§3), incluindo `episodes`/`episode_chunks` (recompute de embeddings).
3. Designar/confirmar Encarregado (DPO).
