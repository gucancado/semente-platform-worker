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
