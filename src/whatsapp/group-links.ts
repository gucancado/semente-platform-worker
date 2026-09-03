import type { Pool } from 'pg';

/**
 * Um grupo de WhatsApp VINCULADO a um workspace de cliente.
 *
 * REGRA DE PRODUTO: quem alimenta o dashboard de GRUPOS e o MONITOR DE GRUPOS
 * — `agent='saturno'` (+55 31 9595-0748), o numero da ORGANIZACAO, que nao
 * esta em `whatsapp_numbers` e nao tem `workspace_id` proprio. Numeros de
 * `whatsapp_numbers` servem o dashboard de ATENDIMENTO. NAO chame o escopo
 * 'agent' de "legado": ele e o caminho oficial desta superficie.
 *
 * O tipo `GroupScope` admite os dois porque um numero de atendimento TAMBEM
 * captura grupos — incidentalmente, porque o aparelho da pessoa participa
 * deles (medido em 2026-09: o numero 1 aparecia em 140 grupos, o 18 em 147).
 * Admitir no tipo nao e autorizar: vincular um grupo a uma linha number-scoped
 * amarra a tela do cliente a um numero de atendimento e ela morre junto com
 * ele. Foi o que houve em 2026-08-18 — o numero 1 caiu e congelou 7 telas
 * (Bluma CF e Vemcurtir entre elas) por 16 dias, sem erro nenhum na interface.
 * Auditar com `pnpm whatsapp:check-group-links`.
 *
 * Nao ha caminho de escrita de `linked_workspace_id` no codigo: os vinculos sao
 * feitos a mao, por SQL. Enquanto for assim, a regra nao tem como ser imposta
 * na escrita — o check acima e a rede.
 *
 * `scope` expoe qual dos dois e, porque as duas leituras (mensagens,
 * roster/avatares) usam fontes diferentes — ver `group-read-routes.ts`.
 *
 * ⚠️ GATE 2 REMOVIDO (decisão de produto, 2026-08-11): existia um segundo gate
 * de autorização ("é membro do workspace do NÚMERO ⇒ é da equipe"), que exigia
 * um "workspace do número" pra funcionar. Com o número da organização sem
 * workspace nenhum, esse segundo gate deixou de fazer sentido — foi removido
 * em `group-read-routes.ts` (não fica mais nada aqui pra ele consumir). A
 * autorização hoje é SÓ admin do workspace vinculado (gate 1). O dono do
 * produto aceitou conscientemente o risco de um admin do workspace do
 * CLIENTE ver a conversa interna da equipe sobre ele — não reintroduzir o
 * gate 2 sem uma decisão de produto nova.
 */
export type GroupScope =
  | { kind: 'number'; numberId: number; numberWorkspaceId: string; numberPhone: string | null }
  | { kind: 'agent'; agent: string };

export type LinkedGroup = {
  /** whatsapp_groups.id */
  id: number;
  /** '+120363...' — mesmo formato de messages.identifier (sem '@g.us'). */
  jid: string;
  subject: string | null;
  linkedWorkspaceId: string;
  scope: GroupScope;
};

// LEFT JOIN (não INNER): linhas legadas agent-scoped (`whatsapp_number_id`
// NULL) precisam sobreviver ao SELECT pra resolver como escopo 'agent' em
// `map()`. Com INNER essas linhas somem em silêncio da lista/resolução — era
// assim antes desta mudança (documentado como guard contra ambiguidade), mas
// deixou de ser a intenção: a linha "da organização" é hoje um caso de
// primeira classe, não descarte.
//
// A condição `n.workspace_id <> g.linked_workspace_id` (que existia aqui) FOI
// REMOVIDA junto com o gate 2: ela só impedia o gate 2 de virar tautologia
// quando o número do vínculo era do MESMO workspace do cliente. Sem gate 2,
// não protege mais nada — só bloquearia vínculos legítimos.
const SELECT = `
  SELECT g.id, g.jid, g.subject,
         g.whatsapp_number_id,
         n.workspace_id AS number_workspace_id,
         n.phone AS number_phone,
         g.agent,
         g.linked_workspace_id
    FROM whatsapp_groups g
    LEFT JOIN whatsapp_numbers n ON n.id = g.whatsapp_number_id`;

/**
 * `null` = a linha não tem como ser escopada com segurança pra leitura (nem
 * `whatsapp_number_id`, nem `agent` preenchidos) — nenhum caller deve
 * devolvê-la. Não deveria acontecer em produção (toda linha de
 * `whatsapp_groups` tem um dos dois), mas é o tipo de linha "impossível" que
 * uma migration futura pode criar por engano; omitir é mais seguro que
 * adivinhar um escopo pra ela.
 */
function map(r: any): LinkedGroup | null {
  const base = {
    id: Number(r.id),
    jid: r.jid,
    subject: r.subject ?? null,
    linkedWorkspaceId: r.linked_workspace_id,
  };
  if (r.whatsapp_number_id != null) {
    return {
      ...base,
      // `numberPhone` alimenta o `observerPhone` do contexto group_v1: a
      // superfície de grupos é um leitor TERCEIRO, e mensagem outbound
      // (enviada pelo próprio número observador) precisa de um AUTOR pra ser
      // atribuída — sem isso ela renderiza como "enviada por você", que ali
      // não existe.
      scope: { kind: 'number', numberId: Number(r.whatsapp_number_id), numberWorkspaceId: r.number_workspace_id, numberPhone: r.number_phone ?? null },
    };
  }
  if (r.agent) {
    return { ...base, scope: { kind: 'agent', agent: r.agent } };
  }
  return null;
}

/** Grupos vinculados a um workspace de cliente. Lista vazia = nenhum vínculo. */
export async function listLinkedGroups(pool: Pool, workspaceId: string): Promise<LinkedGroup[]> {
  const { rows } = await pool.query(
    `${SELECT} WHERE g.linked_workspace_id = $1 ORDER BY g.subject NULLS LAST, g.id`,
    [workspaceId],
  );
  return rows.map(map).filter((g: LinkedGroup | null): g is LinkedGroup => g !== null);
}

/**
 * Resolve (workspace do cliente, jid) → grupo vinculado. `null` = não existe
 * vínculo desse jid PARA esse workspace (o caller responde 404) — ou a linha
 * vinculada existe mas não tem escopo de leitura seguro (ver `map`). Nunca
 * casa um grupo vinculado a outro workspace, mesmo que o jid exista.
 *
 * O `LIMIT 2` + throw: o índice único parcial da mig 057 garante um vínculo
 * por jid, mas um índice pode ser dropado por engano numa migration futura.
 * Duas linhas aqui significa ambiguidade sobre QUAL escopo dá a leitura —
 * falhar alto é a única resposta segura; devolver `rows[0]` seria escolher um
 * tenant no sorteio.
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
