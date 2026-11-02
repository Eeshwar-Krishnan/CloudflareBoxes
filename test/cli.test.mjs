import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

test('CLI forwards Access credentials and emits the documented ready event', async () => {
  let seen;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    seen = {url: req.url, id: req.headers['cf-access-client-id'], secret: req.headers['cf-access-client-secret'], body: JSON.parse(Buffer.concat(chunks))};
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({id:'abc-123'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['cli/cfbox.mjs','new','--json'], {env:{...process.env, CFBOX_URL:`http://127.0.0.1:${server.address().port}`, CF_ACCESS_CLIENT_ID:'id', CF_ACCESS_CLIENT_SECRET:'secret'}});
    let output = ''; for await (const chunk of child.stdout) output += chunk;
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0); assert.deepEqual(JSON.parse(output), {id:'abc-123',event:'ready'});
    assert.deepEqual(seen, {url:'/v1/boxes', id:'id', secret:'secret', body:{}});
  } finally { server.close(); }
});
