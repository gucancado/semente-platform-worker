/**
 * Audita a REGRA do dashboard de Grupos: só o MONITOR DE GRUPOS
 * (`agent='saturno'`, o número da organização) alimenta a tela de grupos de um
 * workspace. Números de `whatsapp_numbers` servem o dashboard de ATENDIMENTO —
 * eles até aparecem em dezenas de grupos (o aparelho da pessoa participa
 * deles), mas essa captura é incidental e não deve ser a fonte de uma tela de
 * cliente.
 *
 *   pnpm whatsapp:check-group-links
 *
 * POR QUE ISTO EXISTE: não há caminho de escrita de `linked_workspace_id` em
 * lugar nenhum do código — os vínculos são feitos à mão, por SQL. Sem validação
 * no momento da escrita, escolher a linha errada é silencioso e só aparece
 * quando o número de atendimento cai e a tela do cliente congela. Foi o que
 * houve em 2026-08-18: o número 1 caiu e levou junto 7 telas de grupo, entre
 * elas Bluma CF e Vemcurtir, que ficaram 16 dias exibindo a última mensagem de
 * 18/08 sem nenhum sinal de erro.
 *
 * Um jid tem NO MÁXIMO um vínculo (índice `uq_whatsapp_groups_linked_jid`), e o
 * mesmo grupo costuma ter VÁRIAS linhas em `whatsapp_groups` — uma por fonte que
 * o captura. Vincular é escolher UMA dessas linhas, e a escolha decide qual
 * escopo a leitura enxerga (`resolveLinkedGroup` → `group-read-routes.ts`).
 *
 * Saída: exit 0 = tudo no monitor; exit 1 = há vínculo em número de atendimento.
 */
import { pool } from '../db.js';

const MONITOR_AGENT = 'saturno';

type Row = {
  id: number;
  jid: string;
  subject: string | null;
  whatsapp_number_id: number | null;
  numero_phone: string | null;
  numero_status: string | null;
  row_monitor: number | null;
  msgs_monitor: number;
};

async function main() {
  const { rows } = await pool.query<Row>(
    `SELECT g.id, g.jid, g.subject, g.whatsapp_number_id,
            n.phone  AS numero_phone,
            n.status AS numero_status,
            (SELECT s.id FROM whatsapp_groups s
              WHERE s.jid = g.jid AND s.agent = $1 AND s.whatsapp_number_id IS NULL) AS row_monitor,
            (SELECT count(*) FROM messages m
              WHERE m.identifier = g.jid AND m.agent = $1 AND m.whatsapp_number_id IS NULL) AS msgs_monitor
       FROM whatsapp_groups g
       LEFT JOIN whatsapp_numbers n ON n.id = g.whatsapp_number_id
      WHERE g.linked_workspace_id IS NOT NULL
        AND g.whatsapp_number_id IS NOT NULL
      ORDER BY g.subject NULLS LAST`,
    [MONITOR_AGENT],
  );

  const total = await pool.query(
    `SELECT count(*)::int AS n FROM whatsapp_groups WHERE linked_workspace_id IS NOT NULL`,
  );

  if (rows.length === 0) {
    console.log(`ok — os ${total.rows[0].n} vínculos de grupo estão no monitor (${MONITOR_AGENT}).`);
    console.log('');
    console.log('Com zero divergências, dá pra travar a regra no banco:');
    console.log('  ALTER TABLE whatsapp_groups');
    console.log('    ADD CONSTRAINT wg_link_only_monitor');
    console.log('    CHECK (linked_workspace_id IS NULL OR whatsapp_number_id IS NULL);');
    await pool.end();
    return;
  }

  console.error(`DIVERGÊNCIA: ${rows.length} de ${total.rows[0].n} vínculos apontam pra número de atendimento.\n`);
  for (const r of rows) {
    // `msgs_monitor` é o que a tela passaria a mostrar se o vínculo fosse movido.
    // Zero + linha existente = o monitor está no grupo mas nunca capturou nada;
    // sem linha = ele provavelmente nem está no grupo (checar no WhatsApp).
    const destino = r.row_monitor
      ? `mover p/ row ${r.row_monitor} (${r.msgs_monitor} msgs do monitor)`
      : 'SEM linha do monitor — conferir se ele está no grupo';
    console.error(
      `  ${String(r.id).padStart(6)} | ${(r.subject ?? '(sem nome)').slice(0, 34).padEnd(34)} | ` +
        `num ${r.whatsapp_number_id} (${r.numero_phone ?? '?'}, ${r.numero_status ?? '?'}) | ${destino}`,
    );
  }
  console.error('\nEnquanto o vínculo estiver num número de atendimento, a tela do grupo morre junto com aquele número.');
  await pool.end();
  process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
