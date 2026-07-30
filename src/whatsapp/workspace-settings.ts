/**
 * src/whatsapp/workspace-settings.ts
 *
 * Fonte de auto_loss_days/new_opp_after_days/ai_engine_enabled/guidances/pipeline_since
 * pros jobs das Fases B/D do CRM WhatsApp v3 (migration 051, tabela
 * whatsapp_workspace_settings — 1 row por workspace, PK workspace_id).
 *
 * A row é OBRIGATÓRIA pros jobs: pipeline_since NUNCA é sintetizado em memória
 * (nunca `new Date()` como fallback aqui) — sempre lido do banco via
 * getOrCreateSettings, que garante a existência da row com os defaults do DDL.
 */
import type { Pool } from 'pg';

export interface WorkspaceSettings {
  workspaceId: string;
  autoLossDays: number | null;
  newOppAfterDays: number;
  aiEngineEnabled: boolean;
  aiLeadGuidance: string | null;
  aiQualifiedGuidance: string | null;
  pipelineSince: string;
}

const SELECT = `SELECT workspace_id, auto_loss_days, new_opp_after_days, ai_engine_enabled,
  ai_lead_guidance, ai_qualified_guidance, pipeline_since
  FROM whatsapp_workspace_settings`;

export function mapWorkspaceSettings(row: any): WorkspaceSettings {
  return {
    workspaceId: row.workspace_id,
    autoLossDays: row.auto_loss_days === null || row.auto_loss_days === undefined ? null : Number(row.auto_loss_days),
    newOppAfterDays: Number(row.new_opp_after_days),
    aiEngineEnabled: row.ai_engine_enabled === true,
    aiLeadGuidance: row.ai_lead_guidance ?? null,
    aiQualifiedGuidance: row.ai_qualified_guidance ?? null,
    pipelineSince: row.pipeline_since?.toISOString?.() ?? row.pipeline_since,
  };
}

/**
 * INSERT ... ON CONFLICT (workspace_id) DO NOTHING seguido de SELECT — os
 * defaults do DDL (migration 051) preenchem tudo, incl. pipeline_since = NOW()
 * no momento da PRIMEIRA criação da row. Nunca montar um default em JS aqui:
 * isso faria pipeline_since andar a cada leitura em vez de fixar na 1ª vez.
 */
export async function getOrCreateSettings(pool: Pool, workspaceId: string): Promise<WorkspaceSettings> {
  await pool.query(
    `INSERT INTO whatsapp_workspace_settings (workspace_id) VALUES ($1)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId],
  );
  const { rows } = await pool.query(`${SELECT} WHERE workspace_id = $1`, [workspaceId]);
  return mapWorkspaceSettings(rows[0]);
}

export type SettingsPatch = Partial<Pick<WorkspaceSettings,
  'autoLossDays' | 'newOppAfterDays' | 'aiEngineEnabled' | 'aiLeadGuidance' | 'aiQualifiedGuidance'>>;

/**
 * UPDATE só dos campos PRESENTES no patch (chave ausente = undefined = preserva;
 * chave presente com valor null = limpa — só faz sentido pros nullable
 * autoLossDays/aiLeadGuidance/aiQualifiedGuidance; newOppAfterDays/aiEngineEnabled
 * nunca chegam aqui como null porque a validação da rota já barrou isso antes).
 * pipeline_since nunca é setado aqui — não existe no SettingsPatch.
 */
export async function patchSettings(
  pool: Pool,
  workspaceId: string,
  patch: SettingsPatch,
  updatedBy: string,
): Promise<WorkspaceSettings> {
  const values: unknown[] = [workspaceId];
  const set: string[] = [];
  if (patch.autoLossDays !== undefined) {
    values.push(patch.autoLossDays);
    set.push(`auto_loss_days=$${values.length}`);
  }
  if (patch.newOppAfterDays !== undefined) {
    values.push(patch.newOppAfterDays);
    set.push(`new_opp_after_days=$${values.length}`);
  }
  if (patch.aiEngineEnabled !== undefined) {
    values.push(patch.aiEngineEnabled);
    set.push(`ai_engine_enabled=$${values.length}`);
  }
  if (patch.aiLeadGuidance !== undefined) {
    values.push(patch.aiLeadGuidance);
    set.push(`ai_lead_guidance=$${values.length}`);
  }
  if (patch.aiQualifiedGuidance !== undefined) {
    values.push(patch.aiQualifiedGuidance);
    set.push(`ai_qualified_guidance=$${values.length}`);
  }
  values.push(updatedBy);
  set.push(`updated_by=$${values.length}`);
  set.push('updated_at=now()');
  const { rows } = await pool.query(
    `UPDATE whatsapp_workspace_settings SET ${set.join(', ')}
      WHERE workspace_id=$1
      RETURNING workspace_id, auto_loss_days, new_opp_after_days, ai_engine_enabled,
                ai_lead_guidance, ai_qualified_guidance, pipeline_since`,
    values,
  );
  return mapWorkspaceSettings(rows[0]);
}
