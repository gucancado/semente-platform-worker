// scripts/smoke-resolve-identity.mjs
// Smoke do MCP client contra prod: confirma que a tool resolve_whatsapp_identity
// está registrada e responde. Uso:
//   WORKER_URL=https://agentes-worker.beeads.com.br WORKER_TOKEN=... \
//     node scripts/smoke-resolve-identity.mjs <phone>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.WORKER_URL;
const token = process.env.WORKER_TOKEN;
const phone = process.argv[2];
if (!base || !token || !phone) {
  console.error('faltam env WORKER_URL/WORKER_TOKEN ou arg <phone>');
  process.exit(2);
}
const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
  requestInit: { headers: { 'X-Agent-Token': token } },
});
const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log('tools:', names);
if (!names.includes('resolve_whatsapp_identity')) {
  console.error('FAIL: tool resolve_whatsapp_identity não registrada');
  process.exit(1);
}
const res = await client.callTool({ name: 'resolve_whatsapp_identity', arguments: { phone } });
console.log('result:', JSON.stringify(res.content));
await client.close();
