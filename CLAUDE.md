# semente-platform-worker — guia para agentes

Visão geral, runbooks e envs gerais estão no [README.md](README.md). Este arquivo
registra decisões que um agente precisa saber antes de mexer em LLM.

## LLM de texto: camada de provedor (`src/llm/`, desde 2026-11-13)

Toda chamada de LLM de **texto** passa por `TextLlm.complete()` (`src/llm/types.ts`),
com um adapter por provedor (`anthropic.ts`, `openai.ts`). O provedor é escolhido
**por tarefa, por env**; trocar = mudar a env no Coolify (prod **e** preview) + restart,
sem deploy. Modelo de família diferente do provedor é recusado no boot.

| Tarefa | Provedor / modelo em prod | Envs |
|---|---|---|
| IA do CRM nível 1 (diário) | anthropic / `claude-haiku-5-5`, thinking off, effort low | `CRM_AI_PROVIDER`, `CRM_AI_MODEL`, `CRM_AI_EFFORT`, `CRM_AI_THINKING` |
| IA do CRM nível 2 (semanal) | anthropic / `claude-sonnet-5-5` | `CRM_AI_PATTERN_PROVIDER`, `CRM_AI_PATTERN_MODEL` (fallback no nível 1) |
| Digest de reunião | anthropic / `claude-haiku-5-5` | `MEETING_SUMMARY_PROVIDER`, `MEETING_SUMMARY_MODEL`, `MEETING_SUMMARY_EFFORT` |
| Lua (desligada) | anthropic / `claude-sonnet-5-5` | `LUA_PROVIDER`, `LUA_{EXTRACTION,JUDGE,RECAP}_MODEL` |
| Resumo semanal de contexto (Visão Geral do painel) | anthropic / `claude-sonnet-5-5`, effort medium (default no código) | `WEEKLY_CONTEXT_MODE` (`off`/`auto`), `WEEKLY_CONTEXT_PROVIDER`, `WEEKLY_CONTEXT_MODEL`, `WEEKLY_CONTEXT_EFFORT` |

Defaults no código = o provedor antigo (openai, gpt-4o-mini / gpt-5.4-mini), exceto a
Lua. **Rollback**: `*_PROVIDER=openai` + `*_MODEL=<modelo openai>` + restart.

**Fica na OpenAI e fora da camada** (a Anthropic não transcreve áudio nem tem
embeddings): `src/transcription/*`, `src/meetings-recover/*`, STT da Vexa, a sonda
`src/openai-health/*` e `src/lua/embeddings.ts`. Por isso a `OPENAI_API_KEY` continua
obrigatória.

Regras da camada:
- **JSON na Anthropic = structured outputs** (`output_config.format`, schemas em
  `src/llm/schemas.ts`). Nunca prefill (400) nem `tool_choice` forçado (400 no
  Sonnet/Opus 5.5). Mudou o "Formato exato" num prompt? Mude o schema junto. O
  validador de cada tarefa segue sendo a defesa final.
- **Thinking**: `thinking: disabled` dá 400 no Opus 5.5 e no Sonnet 5.5 (este usa
  `between_tools`); `thinkingOff()` em `anthropic.ts` decide por modelo. Sem
  `temperature` nos modelos 5.x.
- **Erros** (`src/llm/errors.ts`): classificados pelo erro estruturado dos DOIS SDKs.
  Crédito esgotado é `systemic` (não consome tentativa) nos dois: OpenAI 429
  `insufficient_quota`; Anthropic 402 `billing_error` **ou** 400 "credit balance is
  too low". Desconhecido = `item` (falha fechada).
- **Custo**: tabela única `src/llm/pricing.ts` (preços Anthropic tirados da skill
  claude-api, nunca da memória). `usage.input` é o TOTAL de entrada: a Anthropic não
  inclui cache em `input_tokens` e o adapter soma. Modelo fora da tabela = fallback caro.
- **Sem fallback automático entre provedores**: conta fora do ar vira `systemic` na fila.

Avaliar de novo (somente leitura, mesmo prompt da produção):
`pnpm tsx src/cli/eval-llm-providers.ts --task=crm1|crm2|summary --models=openai:gpt-4o-mini,anthropic:claude-haiku-5-5 [--thinking=off]`
com `EVAL_DATABASE_URL` (túnel SSH até o Postgres) + as duas chaves. Resultado da
avaliação de 2026-11-13 na memória `motor-ia-crm-whatsapp-piloto` / `reunioes-digest-ia`
do projeto BCD.

## Tempo de resposta e espera no kanban (desde 2026-11-16)

- `GET /whatsapp/response-time` (`src/whatsapp/response-time.ts`): tempo por **vez**
  do cliente (mensagens seguidas dele = uma vez; termina na nossa próxima mensagem),
  DM e live-only. O tempo vale só para vezes que **começam** no expediente
  (`business-hours.ts`, seg–sex 9h–18h SP) e é contado em minutos de expediente; a
  vez de fora do expediente entra em `turns`/`unanswered`/`offHours`, não no tempo
  (senão a mediana ia a zero nos números que atendem à noite). Consumido pelo card
  "Atendimento" da Visão geral do WhatsApp no painel.
- `GET /whatsapp/board` devolve por card `lastDirection`/`waitingSince` e por coluna
  `awaiting`; `?awaiting=1` filtra "precisa de ação". Consumido pelo selo de espera do
  kanban.
- **Resposta automática** (`src/whatsapp/auto-reply.ts`): nossa mensagem que chega em
  menos de 5 s após uma do cliente não conta como resposta nas DUAS consultas
  (medido: pico abaixo de 2 s nos números com robô/saudação). Figurinha também não
  conta. Mudou o critério? É uma constante só.
- Custo medido em prod (número de maior volume, 30 dias): response-time ~1,3–2 s,
  board ~0,5 s. 180 dias ~6 s.

## Resumo semanal de contexto (`src/weekly-context/`, mig 078)

Um parágrafo de até ~60 palavras por cliente, lido na tática semanal no topo da Visão
Geral do painel. Lê o grupo do monitor vinculado ao workspace (14 dias; autor em 2+
grupos vinculados = "BeeAds"), os digests das reuniões (21 dias) e as tarefas do Bloquim
(abertas sem rascunho + concluídas em 14 dias, `GET /api/internal/workspaces/:id/tasks`
com `INTERNAL_API_SECRET`, `src/bloquim/workspace-tasks.ts`; falha = resumo sem tarefas e
`sources.tasks = null`), e o prompt manda CRUZAR o dito com as tarefas (pedido sem tarefa,
tarefa atrasada, entrega que responde a um pedido). O prompt PROÍBE o que o painel já
mostra (saldo, pagamentos, datas de reunião, contagem/lista de tarefas, prazos, métricas,
alertas).
Tabela `weekly_context_summaries` (1 linha por workspace × semana, `week_start` = segunda
em SP). Poller de 15 min com `WEEKLY_CONTEXT_MODE=auto`: toda segunda a partir de 6h (SP)
gera a semana corrente; workspace sem material = `empty` sem chamar LLM; `failed` volta
depois de 1h. **Sem geração manual** (decisão de 2026-11-24). Rota
`GET /weekly-context?workspace_id=` com `X-Panel-Token`. Custo em
`llm_metrics` com `agent='weekly-context'` (fora do custo de IA do WhatsApp). Medido em
2026-11-24: ~US$ 0,017 por cliente (Sonnet 5.5).
