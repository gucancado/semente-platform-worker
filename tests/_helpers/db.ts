import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL não definida no ambiente de teste');

export const testPool = new pg.Pool({ connectionString: url, max: 5 });

/** Apaga todos os rows das tabelas de scheduling. Use em beforeEach dos tests. */
export async function cleanScheduling(): Promise<void> {
  await testPool.query(`
    TRUNCATE TABLE slot_holds, meetings, scheduling_agendas, google_oauth_connections, project_goals, projects
    RESTART IDENTITY CASCADE
  `);
}
