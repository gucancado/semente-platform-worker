import type { Pool } from 'pg';

/**
 * Um grupo de WhatsApp VINCULADO a um workspace de cliente. O vínculo é
 * independente do workspace do número que monitora o grupo (o saturno serve
 * N clientes), e é ele que autoriza a leitura.
 *
 * Os dois workspaces desta struct têm papéis DIFERENTES e não podem ser
 * trocados um pelo outro:
 *   - `linkedWorkspaceId` = workspace do CLIENTE → escopa a AUTORIZAÇÃO (gate admin).
 *   - `numberWorkspaceId` = workspace do NÚMERO  → escopa os DADOS (é o que está
 *     gravado em messages.workspace_id).
 */
export type LinkedGroup = {
  /** whatsapp_groups.id */
  id: number;
  /** '+120363...' — mesmo formato de messages.identifier (sem '@g.us'). */
  jid: string;
  subject: string | null;
  numberId: number;
  numberWorkspaceId: string;
  linkedWorkspaceId: string;
};

// `numberWorkspaceId` sai de whatsapp_numbers (autoridade), não de
// whatsapp_groups.workspace_id — as duas normalmente coincidem, mas é a do
// número que casa com messages.workspace_id.
const SELECT = `
  SELECT g.id, g.jid, g.subject,
         g.whatsapp_number_id,
         n.workspace_id AS number_workspace_id,
         g.linked_workspace_id
    FROM whatsapp_groups g
    JOIN whatsapp_numbers n ON n.id = g.whatsapp_number_id`;

function map(r: any): LinkedGroup {
  return {
    id: Number(r.id),
    jid: r.jid,
    subject: r.subject ?? null,
    numberId: Number(r.whatsapp_number_id),
    numberWorkspaceId: r.number_workspace_id,
    linkedWorkspaceId: r.linked_workspace_id,
  };
}

/** Grupos vinculados a um workspace de cliente. Lista vazia = nenhum vínculo. */
export async function listLinkedGroups(pool: Pool, workspaceId: string): Promise<LinkedGroup[]> {
  const { rows } = await pool.query(
    `${SELECT} WHERE g.linked_workspace_id = $1 ORDER BY g.subject NULLS LAST, g.id`,
    [workspaceId],
  );
  return rows.map(map);
}

/**
 * Resolve (workspace do cliente, jid) → grupo vinculado. `null` = não existe
 * vínculo desse jid PARA esse workspace (o caller responde 404). Nunca casa um
 * grupo vinculado a outro workspace, mesmo que o jid exista.
 *
 * Dois guards que NÃO são redundantes:
 *  - o `JOIN whatsapp_numbers` (INNER, no SELECT acima) descarta linhas legadas
 *    agent-scoped, que têm `whatsapp_number_id` NULL e não têm número de onde
 *    tirar o escopo das mensagens;
 *  - o `LIMIT 2` + throw: o índice único parcial da mig 057 garante um vínculo
 *    por jid, mas um índice pode ser dropado por engano numa migration futura.
 *    Duas linhas aqui significa ambiguidade sobre QUAL número dá o escopo de
 *    leitura — falhar alto é a única resposta segura; devolver `rows[0]` seria
 *    escolher um tenant no sorteio.
 */
export async function resolveLinkedGroup(
  pool: Pool, workspaceId: string, jid: string,
): Promise<LinkedGroup | null> {
  const { rows } = await pool.query(
    `${SELECT} WHERE g.linked_workspace_id = $1 AND g.jid = $2 LIMIT 2`,
    [workspaceId, jid],
  );
  if (rows.length > 1) {
    throw new Error(`vínculo ambíguo: jid ${jid} tem ${rows.length} linhas vinculadas`);
  }
  return rows[0] ? map(rows[0]) : null;
}
