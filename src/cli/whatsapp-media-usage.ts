/**
 * Uso do armazenamento da mídia do WhatsApp (imagem, vídeo, documento e áudio)
 * contra o orçamento WHATSAPP_MEDIA_BUDGET_GB.
 *
 * REGRA DO OWNER (2026-09-16): a expiração de 180 dias fica DESLIGADA. Quando o uso
 * passar de 70% do orçamento, a limpeza e a ativação da expiração só acontecem com
 * aprovação explícita do Gustavo. Este CLI mede e simula; apagar exige --yes.
 *
 * Em produção o container roda o build (sem tsx):
 *   node dist/cli/whatsapp-media-usage.js                          uso + % do orçamento
 *   node dist/cli/whatsapp-media-usage.js --preview-days=180       quanto N dias liberariam (não apaga)
 *   node dist/cli/whatsapp-media-usage.js --expire-days=180 --yes  limpeza manual, uma vez
 * Local: pnpm whatsapp:media-usage -- <flags>
 *
 * A prévia usa a data de UPLOAD do objeto (LastModified); a limpeza usa a data da
 * MENSAGEM. A diferença é o atraso do download — minutos, salvo fila parada.
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { deleteObject, forEachObject, r2Configured, whatsappMediaBucket } from '../integrations/r2.js';
import {
  MIN_RETENTION_DAYS,
  STORAGE_REVIEW_THRESHOLD,
  WHATSAPP_MEDIA_PREFIXES,
  retentionEnabled,
  storageVerdict,
} from '../whatsapp/media-policy.js';
import { sweepExpiredMedia } from '../whatsapp/media-retention.js';

const SWEEP_BATCH = 500;

function flag(name: string): number | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : null;
}
const mb = (b: number) => (b / 1024 ** 2).toFixed(1);
const gb = (b: number) => (b / 1024 ** 3).toFixed(2);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  if (!r2Configured()) throw new Error('R2 não configurado (R2_* ausentes)');
  const bucket = whatsappMediaBucket()!;
  const expireDays = flag('expire-days');
  const days = expireDays ?? flag('preview-days');
  if (days != null && !retentionEnabled(days)) throw new Error(`dias deve ser inteiro >= ${MIN_RETENTION_DAYS}`);
  const cutoffMs = days != null ? Date.now() - days * 86_400_000 : null;

  console.log(`bucket: ${bucket}`);
  let total = 0;
  let olderBytes = 0;
  let olderCount = 0;
  for (const prefix of WHATSAPP_MEDIA_PREFIXES) {
    let n = 0;
    let bytes = 0;
    await forEachObject(prefix, bucket, (o) => {
      n += 1;
      bytes += o.size;
      if (cutoffMs != null && o.lastModified && o.lastModified.getTime() < cutoffMs) {
        olderBytes += o.size;
        olderCount += 1;
      }
    });
    total += bytes;
    console.log(`  ${prefix.padEnd(16)} ${String(n).padStart(8)} objetos ${mb(bytes).padStart(10)} MB`);
  }

  const v = storageVerdict(total, config.WHATSAPP_MEDIA_BUDGET_GB);
  const threshold = pct(STORAGE_REVIEW_THRESHOLD);
  console.log(`uso: ${gb(total)} GB de ${config.WHATSAPP_MEDIA_BUDGET_GB} GB de orçamento = ${pct(v.pct)}`);
  const live = config.WHATSAPP_MEDIA_RETENTION_DAYS;
  console.log(`expiração em produção: ${retentionEnabled(live) ? `LIGADA (${live} dias)` : 'DESLIGADA'}`);
  if (days != null) {
    console.log(`expirar com ${days} dias liberaria ${olderCount} objetos, ${mb(olderBytes)} MB (${pct(total ? olderBytes / total : 0)} do uso)`);
  }
  console.log(
    v.overThreshold
      ? `STATUS: ACIMA DE ${threshold} — pedir aprovação do Gustavo para limpar e ativar a expiração de 180 dias`
      : `STATUS: OK (limite de revisão: ${threshold})`,
  );

  if (expireDays == null) return;
  if (!process.argv.includes('--yes')) {
    console.log('limpeza NÃO executada: falta --yes (exige aprovação do Gustavo)');
    return;
  }
  const io = { deleteObject: (key: string) => deleteObject(key, bucket) };
  let expired = 0;
  let failed = 0;
  for (;;) {
    const r = await sweepExpiredMedia(pool, io, { days: expireDays, budget: SWEEP_BATCH });
    expired += r.expired;
    failed += r.failed;
    // Lote cheio SEM nenhum sucesso = falha persistente; parar evita laço infinito.
    if (r.selected < SWEEP_BATCH || r.expired === 0) break;
  }
  console.log(`limpeza executada: ${expired} arquivos expirados, ${failed} falhas`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
