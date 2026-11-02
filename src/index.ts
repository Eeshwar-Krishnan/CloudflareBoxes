import { accessPrincipal } from './auth';
import { handleMcp } from './mcp';
import { Sandbox } from './sandbox';
import { Registry } from './registry';
import { DEFAULT_INSTANCE_SIZE, isInstanceSize } from './sizes';
import { createArtifact, createArtifactToken, deleteArtifact, cleanupExpiredArtifacts, type ArtifactsBinding } from './artifacts';
export { Sandbox, Registry };

interface Env { ACCESS_AUD: string; TEAM_DOMAIN: string; SANDBOX: DurableObjectNamespace<Sandbox>; REGISTRY: DurableObjectNamespace<Registry>; ARTIFACTS: ArtifactsBinding }
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const idPattern = /^[a-z0-9-]{1,80}$/;
const maxFile = 64 * 1024;
async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body as Record<string, unknown>;
}
async function dispatch(env: Env, principal: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const tenant = await hash(principal);
  const registry = env.REGISTRY.getByName(tenant);
  if (path === '/v1/artifacts' && method === 'POST') {
    const input = bodyObject(body ?? {});
    if (Object.keys(input).some(k => k !== 'ttl_seconds')) throw new HttpError(400, 'Only ttl_seconds is supported');
    return createArtifact(env.ARTIFACTS, {tenantId: tenant, ttlSeconds: input.ttl_seconds as number | undefined});
  }
  const artifact = /^\/v1\/artifacts\/([a-z0-9-]+)(?:\/(token))?$/.exec(path);
  if (artifact && method === 'DELETE' && !artifact[2]) return deleteArtifact(env.ARTIFACTS, artifact[1], tenant);
  if (artifact && method === 'POST' && artifact[2]) {
    const input = bodyObject(body ?? {});
    if (Object.keys(input).some(k => k !== 'ttl_seconds' && k !== 'scope')) throw new HttpError(400, 'Invalid token options');
    return createArtifactToken(env.ARTIFACTS, artifact[1], tenant, (input.scope ?? 'read') as 'read'|'write', (input.ttl_seconds ?? 900) as number);
  }
  if (path === '/v1/boxes' && method === 'GET') return { boxes: await registry.list(tenant) };
  if (path === '/v1/boxes' && method === 'POST') {
    const input = bodyObject(body ?? {});
    if (Object.keys(input).some(key => key !== 'size')) throw new HttpError(400, 'Only size is supported');
    const size = input.size === undefined ? DEFAULT_INSTANCE_SIZE : input.size;
    if (!isInstanceSize(size)) throw new HttpError(400, 'Invalid size; use lite, basic, standard-1, standard-2, standard-3, or standard-4');
    const id = crypto.randomUUID();
    const box = env.SANDBOX.getByName(`${tenant}:${id}`);
    await registry.add(tenant, id);
    try { await box.create({tenantId: tenant, size}); } catch (e) { await registry.remove(tenant, id); throw e; }
    return { id, state: 'running', size };
  }
  const match = /^\/v1\/boxes\/([a-z0-9-]+)(?:\/(stop|resume|fork|commands|extend))?$/.exec(path);
  if (match) {
    const [,id, action] = match;
    if (!idPattern.test(id) || !(await registry.list(tenant)).some(entry => entry.id === id)) throw new HttpError(404, 'Box not found');
    const box = env.SANDBOX.getByName(`${tenant}:${id}`);
    if (!action && method === 'GET') return { ...(await box.status()), id };
    if (!action && method === 'DELETE') { await box.delete(); await registry.remove(tenant, id); return {id, state:'deleted'}; }
    if (method === 'POST' && action === 'stop') return { ...(await box.stop()), id };
    if (method === 'POST' && action === 'resume') return { ...(await box.resume()), id };
    if (method === 'POST' && action === 'fork') {
      const snapshot = await box.forkSnapshot();
      const forkId = crypto.randomUUID();
      const fork = env.SANDBOX.getByName(`${tenant}:${forkId}`);
      await registry.add(tenant, forkId);
      try { await fork.useSnapshot(snapshot, {tenantId: tenant}); } catch (e) { await registry.remove(tenant, forkId); throw e; }
      return {id: forkId, state:'running', size: snapshot.instanceSize};
    }
    if (method === 'POST' && action === 'commands') {
      const input = bodyObject(body);
      if (!Array.isArray(input.argv) || !input.argv.length || input.argv.length > 128 || input.argv.some(x => typeof x !== 'string' || x.length > 100000)) throw new HttpError(400, 'Invalid argv');
      if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new HttpError(400, 'Invalid cwd');
      if (input.stdin !== undefined && (typeof input.stdin !== 'string' || input.stdin.length > 65536)) throw new HttpError(400, 'Invalid stdin');
      return box.exec({argv: input.argv as string[], cwd: input.cwd as string | undefined, stdin: input.stdin as string | undefined});
    }
    if (action === 'extend') throw new HttpError(501, 'Lifetime extension is not implemented');
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> { ctx.waitUntil(cleanupExpiredArtifacts(env.ARTIFACTS)); },
  async fetch(request: Request, env: Env): Promise<Response> {
    let principal: string;
    try { principal = await accessPrincipal(request, env.TEAM_DOMAIN, env.ACCESS_AUD); }
    catch { return Response.json({error: 'Cloudflare Access authentication required'}, {status: 403}); }
    const url = new URL(request.url);
    if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return Response.json({error:'Cross-origin requests are forbidden'}, {status:403});
    const call = (method: string, path: string, body?: unknown) => dispatch(env, principal, method, path, body);
    try {
      if (url.pathname === '/mcp') return await handleMcp(request, call);
      const file = /^\/v1\/boxes\/([a-z0-9-]+)\/files$/.exec(url.pathname);
      if (file) {
        const path = url.searchParams.get('path');
        if (!path || path.includes('\0') || path.length > 4096) throw new HttpError(400,'Valid path required');
        if (request.method === 'PUT') {
          if (!request.body) throw new HttpError(400, 'File body required');
          const reader = request.body.getReader();
          const chunks: Uint8Array[] = []; let size = 0;
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > maxFile) { await reader.cancel(); throw new HttpError(413, 'File exceeds 64 KiB limit'); }
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
          const result = await call('POST', `/v1/boxes/${file[1]}/commands`, {argv:['node','-e','require("fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))',path,btoa(binary)]}) as {exitCode:number; stderr:string};
          if (result.exitCode !== 0) throw new HttpError(400, result.stderr || 'File write failed');
          return Response.json({ok:true, bytes: bytes.length});
        }
        if (request.method === 'GET') {
          const result = await call('POST', `/v1/boxes/${file[1]}/commands`, {argv:['node','-e','const fs=require("fs");const f=process.argv[1];if(fs.statSync(f).size>65536)process.exit(2);process.stdout.write(fs.readFileSync(f).toString("base64"))',path]}) as {exitCode:number; stdout:string; stderr:string};
          if (result.exitCode !== 0) throw new HttpError(400, result.stderr || 'File read failed or exceeds 64 KiB');
          return new Response(Uint8Array.from(atob(result.stdout), c => c.charCodeAt(0)), {headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}});
        }
        throw new HttpError(405,'Method not allowed');
      }
      let body: unknown;
      if (request.method === 'POST' || request.method === 'PATCH') body = await request.json().catch(() => ({}));
      const result = await call(request.method, url.pathname, body);
      return Response.json(result, {headers:{'Cache-Control':'no-store'}});
    } catch (e) { return Response.json({error: e instanceof HttpError ? e.message : 'Operation failed'}, {status:e instanceof HttpError ? e.status : 500, headers:{'Cache-Control':'no-store'}}); }
  }
};
