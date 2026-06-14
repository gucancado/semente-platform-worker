// CLI de bootstrap da Lua (spec §5.5, Task 13).
//
//   pnpm lua:bootstrap [--dry-run] [--limit=N] [--workspace=ID]
//
// Enfileira os episódios elegíveis (varredura §5.2) e os processa em
// occurred_at ASC ignorando a janela noturna (run kind='bootstrap'), com
// concorrência = LUA_CONCURRENCY. --dry-run estima o custo (§5.4) SEM chamar
// LLM/embeddings nem gravar. O caminho real exige OPENAI_API_KEY + ANTHROPIC_API_KEY
// (clientes reais) e é gateado por eval (§11) + LUA_ENABLED — separados deste CLI.
//
// A lógica vive em src/lua/bootstrap.ts (testável sem rede); aqui só argv, I/O,
// montagem dos clientes reais e códigos de saída.

import { pool } from '../db.js';
import { runBootstrap, type BootstrapReport } from '../lua/bootstrap.js';
import { getEmbeddingClient } from '../lua/embedding-provider.js';
import { getExtractionClient, getJudgeClient } from '../lua/llm-provider.js';

function parseArgs(argv: string[]): { dryRun: boolean; limit?: number; workspaceId?: string } {
  const args = new Set(argv);
  const dryRun = args.has('--dry-run');
  const limitArg = argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const workspaceId = argv.find((a) => a.startsWith('--workspace='))?.split('=')[1];
  const limit = limitArg !== undefined ? Number(limitArg) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit invalido: ${limitArg} (espera inteiro positivo)`);
  }
  return { dryRun, limit, workspaceId };
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function printReport(report: BootstrapReport): void {
  if (report.dryRun) {
    console.log('=== LUA BOOTSTRAP — DRY RUN (nenhuma chamada a LLM/embeddings, nada gravado) ===');
    console.log(`Episodios elegiveis: ${report.episodesSeen}`);
    console.log(`Chunks totais:       ${report.totalChunks}`);
    console.log(`Tokens estimados:    ${report.totalTokens} (heuristica chars/4)`);
    console.log('--- Custo estimado (premissas spec §5.4) ---');
    console.log(`Embeddings:  ${usd(report.estEmbeddingsUsd)}  ($0,13/M tokens)`);
    console.log(
      `Extracao:    ${usd(report.estExtractionUsd)}  ($3/M in + $15/M out; out ~= 10% in)`
    );
    console.log(`TOTAL est.:  ${usd(report.estEmbeddingsUsd + report.estExtractionUsd)}`);
    console.log(
      '(estimativa exclui overheads de prompt/schema/retries; fator de seguranca ~2x — §5.4)'
    );
    return;
  }
  console.log('=== LUA BOOTSTRAP — REAL ===');
  console.log('Lembrete: LUA_ENABLED e o gate de eval (§11) sao controles SEPARADOS deste CLI.');
  console.log(`Enfileirados:        ${report.enqueued}`);
  console.log(`Processados:         ${report.processed}`);
  console.log(`Falhas:              ${report.failed}`);
  console.log(`Fatos novos:         ${report.factsNew}`);
  console.log(`Fatos supersedidos:  ${report.factsSuperseded}`);
  console.log(`Fatos flagados:      ${report.factsFlagged}`);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  let deps;
  if (!opts.dryRun) {
    // Clientes reais: se a chave nao estiver provisionada, sao stubs que lancam
    // (degradacao explicita) — o run falha alto por episodio. Aceitavel: o real
    // exige chaves + gate (G3); o --dry-run e o caminho livre.
    deps = {
      embeddingClient: getEmbeddingClient(),
      llmClient: getExtractionClient(),
      judge: getJudgeClient(),
    };
  }
  const report = await runBootstrap(opts, deps);
  printReport(report);
  console.log('\n' + JSON.stringify(report, null, 2));
  return report.failed > 0 ? 1 : 0;
}

const isMain =
  process.argv[1]?.endsWith('lua-bootstrap.ts') || process.argv[1]?.endsWith('lua-bootstrap.js');
if (isMain) {
  main()
    .then((code) => pool.end().then(() => process.exit(code)))
    .catch((err) => {
      console.error(err);
      pool.end().then(() => process.exit(1));
    });
}
