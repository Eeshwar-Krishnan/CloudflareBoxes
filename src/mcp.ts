import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { INSTANCE_SIZES } from './sizes';

type Dispatch = (method: string, path: string, body?: unknown) => Promise<unknown>;
export async function handleMcp(request: Request, dispatch: Dispatch): Promise<Response> {
  const server = new McpServer({ name: 'cloudflareboxes', version: '0.1.0' });
  const result = async (method: string, path: string, body?: unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await dispatch(method, path, body)) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'Request failed' }] }; }
  };
  const id = z.string().regex(/^[a-z0-9-]+$/);
  server.registerTool('box_create', { description: 'Create an isolated Linux sandbox (default standard-2, 1 vCPU)', inputSchema: { size: z.enum(INSTANCE_SIZES).optional() } }, (args) => result('POST', '/v1/boxes', args));
  server.registerTool('box_list', { description: 'List your sandboxes', inputSchema: {} }, () => result('GET', '/v1/boxes'));
  server.registerTool('box_info', { description: 'Get sandbox state', inputSchema: { id } }, ({id}) => result('GET', `/v1/boxes/${id}`));
  for (const action of ['stop', 'resume', 'fork'] as const) server.registerTool(`box_${action}`, { description: `${action} a sandbox`, inputSchema: { id } }, ({id}) => result('POST', `/v1/boxes/${id}/${action}`, {}));
  server.registerTool('box_delete', { description: 'Delete a sandbox', inputSchema: { id } }, ({id}) => result('DELETE', `/v1/boxes/${id}`));
  server.registerTool('box_exec', { description: 'Execute an argv array in a sandbox', inputSchema: { id, argv: z.array(z.string()).min(1).max(128) } }, ({id, argv}) => result('POST', `/v1/boxes/${id}/commands`, { argv }));
  server.registerTool('artifact_create', { description: 'Create a temporary Git repository', inputSchema: { ttl_seconds: z.number().int().min(60).max(86400).optional() } }, (args) => result('POST', '/v1/artifacts', args));
  server.registerTool('artifact_token', { description: 'Mint a short-lived repository token', inputSchema: { id, scope: z.enum(['read','write']).default('read'), ttl_seconds: z.number().int().min(60).max(3600).default(900) } }, ({id, ...body}) => result('POST', `/v1/artifacts/${id}/token`, body));
  server.registerTool('artifact_delete', { description: 'Delete a temporary repository after collecting results', inputSchema: { id } }, ({id}) => result('DELETE', `/v1/artifacts/${id}`));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
