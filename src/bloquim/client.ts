import { config } from '../config.js';

export type CreateTaskInput = {
  workspaceId: string;
  title: string;
  description: string;
  scheduleMode?: 'urgente' | 'agendado' | null;
  assignee?: { email: string } | null;
  tags?: string[];
};

/**
 * Cria uma tarefa no Bloquim em nome de um agente específico (usa o
 * bloquim_token configurado para esse agente).
 *
 * STUB — implementar conforme contrato real da API Bloquim.
 */
export async function createTask(args: {
  agent: string;
  bloquim_token: string;
  payload: CreateTaskInput;
}): Promise<{ id: string } | null> {
  const res = await fetch(`${config.BLOQUIM_API_URL}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.bloquim_token}`,
    },
    body: JSON.stringify(args.payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bloquim create_task ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { id: string };
  return { id: data.id };
}
