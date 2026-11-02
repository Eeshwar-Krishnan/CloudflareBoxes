import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArtifact, createArtifactToken, deleteArtifact, cleanupExpiredArtifacts } from '../src/artifacts.ts';

test('artifact credentials are scoped and cleanup deletes expired repositories', async () => {
  const repositories = new Map();
  const binding = {
    async create(name) { repositories.set(name, true); return {name, remote:'https://example.invalid/repo', token:'initial-secret'}; },
    async get(name) { if (!repositories.has(name)) throw Error('not found'); return { async info() { return {name}; }, async createToken(scope, ttl) { return {plaintext:`${scope}:${ttl}`, expiresAt:'later'}; } }; },
    async delete(name) { return repositories.delete(name); },
    async list() { return {repos: [...repositories.keys()].map(name => ({name}))}; }
  };
  const repo = await createArtifact(binding, {tenantId:'alice', ttlSeconds:3600});
  assert.equal(JSON.stringify(repo).includes('initial-secret'), false);
  await assert.rejects(createArtifactToken(binding, repo.id, 'bob', 'read', 60));
  assert.equal((await createArtifactToken(binding, repo.id, 'alice', 'read', 60)).token, 'read:60');
  await assert.rejects(createArtifactToken(binding, repo.id, 'alice', 'write', 3600));
  assert.deepEqual(await cleanupExpiredArtifacts(binding, repo.expiresAt + 1), {scanned:1, deleted:1});
  assert.equal(repositories.size, 0);
  const second = await createArtifact(binding, {tenantId:'alice', ttlSeconds:3600});
  assert.equal((await deleteArtifact(binding, second.id, 'alice')).deleted, true);
});
