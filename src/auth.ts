import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Verify the Access assertion even when an unprotected route reaches the Worker. */
export async function accessPrincipal(request: Request, teamDomain: string, audience: string): Promise<string> {
  if (!teamDomain || !audience || audience.startsWith('SET_')) throw new Error('Access is not configured');
  const team = new URL(teamDomain);
  if (team.protocol !== 'https:' || !team.hostname.endsWith('.cloudflareaccess.com') || team.pathname !== '/' || team.search || team.hash) throw new Error('Invalid Access team domain');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Error('Access authentication required');
  const keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', team));
  const { payload } = await jwtVerify(token, keys, { issuer: team.origin, audience, algorithms: ['RS256'] });
  const service = payload.common_name;
  const subject = payload.sub;
  if (typeof service === 'string' && service) return `service:${service}`;
  if (typeof subject === 'string' && subject) return `user:${subject}`;
  throw new Error('Access assertion has no stable identity');
}
