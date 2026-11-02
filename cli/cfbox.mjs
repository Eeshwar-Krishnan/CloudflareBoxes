#!/usr/bin/env node
/** Small dependency-free client for the CloudflareBoxes REST API. */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const usage = `cfbox — manage CloudflareBoxes

Environment:
  CFBOX_URL                     Service origin (required; for example https://boxes.example.com)
  CF_ACCESS_CLIENT_ID           Cloudflare Access service-token client ID
  CF_ACCESS_CLIENT_SECRET       Cloudflare Access service-token client secret

Commands:
  new [--size lite|basic|standard-1|standard-2|standard-3|standard-4] [--json]
  list [--json]
  info ID [--json]             stop ID [--json]       resume ID [--json]
  fork ID [--json]             delete ID [--json]

  exec ID [--cwd DIR] [-- COMMAND [ARG...]]
       Reads stdin when COMMAND is omitted; command output and exit code are preserved.
  upload ID LOCAL_PATH [REMOTE_PATH]
  download ID REMOTE_PATH LOCAL_PATH
  artifact create [--ttl SECONDS]
  artifact token ID [--scope read|write] [--ttl SECONDS]
  artifact delete ID

New boxes default to standard-2 (1 vCPU, 6 GiB RAM, 12 GB disk). Forks inherit size.
new and fork emit NDJSON, including {"event":"ready","id":"..."} on success.
For SSH/SCP configure an Ed25519 authorized key and use Wrangler's SSH proxy:
  ssh -o ProxyCommand="wrangler containers ssh %h" cloudchamber@INSTANCE_ID
  scp -o ProxyCommand="wrangler containers ssh %h" FILE cloudchamber@INSTANCE_ID:PATH
Find INSTANCE_ID with wrangler containers instances. SSH requires Cloudflare account
write access and a running instance; it is separate from Access authentication.

`;

function fail(message, code = 2) {
  console.error(`cfbox: ${message}`);
  process.exitCode = code;
}

function takeOption(args, name, { value = true } = {}) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  args.splice(i, 1);
  if (!value) return true;
  if (!args[i]) throw new Error(`${name} requires a value`);
  return args.splice(i, 1)[0];
}

function jsonFlag(args) {
  const i = args.indexOf('--json');
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function origin() {
  const raw = process.env.CFBOX_URL;
  if (!raw) throw new Error('CFBOX_URL is required (for example https://boxes.example.com)');
  return raw.replace(/\/+$/, '');
}

function authHeaders(extra = {}) {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET');
  return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, ...extra };
}

async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const response = await fetch(`${origin()}${path}`, {
    method,
    headers: authHeaders({ ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers }),
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${method} ${path}: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return response;
}

async function data(path, options) {
  const response = await request(path, options);
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json();
  const text = await response.text();
  return text ? { output: text } : null;
}

const enc = encodeURIComponent;
function printResult(result, asJson) {
  if (result == null) return;
  if (asJson) console.log(JSON.stringify(result));
  else if (typeof result === 'object') console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

async function lifecycle(command, args) {
  const asJson = jsonFlag(args);
  let method = 'POST';
  let path;
  let body;
  if (command === 'new') {
    const size = takeOption(args, '--size');
    const validSizes = ['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'];
    if (size && !validSizes.includes(size)) throw new Error(`invalid size: ${size}; choose ${validSizes.join(', ')}`);
    body = size ? { size } : {};
    path = '/v1/boxes';
  } else if (command === 'list') {
    method = 'GET';
    path = '/v1/boxes';
  } else {
    const id = args.shift();
    if (!id) throw new Error(`${command} requires an instance ID`);
    const base = `/v1/boxes/${enc(id)}`;
    switch (command) {
      case 'info': method = 'GET'; path = base; break;
      case 'stop': path = `${base}/stop`; break;
      case 'resume': path = `${base}/resume`; break;
      case 'fork': path = `${base}/fork`; break;
      case 'delete': method = 'DELETE'; path = base; break;
      case 'extend': {
        const hours = takeOption(args, '--hours');
        const ttl = takeOption(args, '--ttl');
        const noAutoStop = takeOption(args, '--no-auto-stop', { value: false });
        if (hours !== undefined) body = { hours: Number(hours) };
        else if (ttl !== undefined) body = { ttl_seconds: Number(ttl) };
        else if (noAutoStop) body = { no_auto_stop: true };
        else throw new Error('extend requires --hours, --ttl, or --no-auto-stop');
        path = `${base}/extend`;
        break;
      }
    }
  }
  if (args.length) throw new Error(`unexpected arguments: ${args.join(' ')}`);
  const result = await data(path, { method, body });
  if (command === 'new' || command === 'fork') {
    const id = result?.id ?? result?.box?.id ?? result?.result?.id;
    if (!id) {
      console.log(JSON.stringify({ event: 'result', ...(result && typeof result === 'object' ? result : { value: result }) }));
      throw new Error(`${command} response did not include an instance id`);
    }
    console.log(JSON.stringify({ ...result, event: 'ready', id }));
    return;
  }
  printResult(result, asJson);
}

async function execCommand(args) {
  const id = args.shift();
  if (!id) throw new Error('exec requires an instance ID');
  const cwd = takeOption(args, '--cwd');
  if (args[0] === '--') args.shift();
  const command = args;
  const stdin = process.stdin.isTTY ? undefined : await new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
    if (process.stdin.isTTY) resolve('');
  });
  const result = await data(`/v1/boxes/${enc(id)}/commands`, {
    method: 'POST', body: { argv: command.length ? command : ['/bin/sh'], ...(stdin !== undefined ? {stdin} : {}), ...(cwd ? { cwd } : {}) },
  });
  if (result?.stdout) process.stdout.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  if (Number.isInteger(result?.exit_code)) process.exitCode = result.exit_code;
  else if (result?.exitCode != null) process.exitCode = Number(result.exitCode) || 0;
  else if (result?.output && !result?.stdout) process.stdout.write(result.output);
}

async function transfer(command, args) {
  const id = args.shift();
  if (!id) throw new Error(`${command} requires an instance ID`);
  if (command === 'upload') {
    const local = args.shift();
    if (!local) throw new Error('upload requires a local file path');
    const remote = args.shift() || basename(local);
    if (args.length) throw new Error('upload accepts one remote path');
    const bytes = await readFile(local);
    const result = await data(`/v1/boxes/${enc(id)}/files?path=${enc(remote)}`, {
      method: 'PUT', body: bytes, raw: true, headers: { 'content-type': 'application/octet-stream' },
    });
    printResult(result, false);
  } else {
    const remote = args.shift();
    const local = args.shift();
    if (!remote || !local || args.length) throw new Error('download requires REMOTE_PATH LOCAL_PATH');
    const response = await request(`/v1/boxes/${enc(id)}/files?path=${enc(remote)}`);
    await writeFile(local, Buffer.from(await response.arrayBuffer()));
    console.log(`Downloaded ${remote} to ${local}`);
  }
}

async function artifact(args) {
  const action = args.shift();
  if (action === 'create') {
    const ttl = takeOption(args, '--ttl');
    if (args.length) throw new Error(`unexpected arguments: ${args.join(' ')}`);
    printResult(await data('/v1/artifacts', { method: 'POST', body: ttl ? { ttl_seconds: Number(ttl) } : {} }), true);
    return;
  }
  const id = args.shift();
  if (!id) throw new Error(`artifact ${action} requires an artifact ID`);
  let result;
  if (action === 'token') {
    const ttl = takeOption(args, '--ttl');
    const scope = takeOption(args, '--scope') || 'read';
    result = await data(`/v1/artifacts/${enc(id)}/token`, { method: 'POST', body: { scope, ...(ttl ? { ttl_seconds: Number(ttl) } : {}) } });
  } else if (action === 'delete') result = await data(`/v1/artifacts/${enc(id)}`, { method: 'DELETE' });
  else throw new Error(`unknown artifact action: ${action}`);
  if (args.length) throw new Error(`unexpected arguments: ${args.join(' ')}`);
  printResult(result, true);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command === 'artifact') return await artifact(args);
  if (command === 'exec') return await execCommand(args);
  if (command === 'upload' || command === 'download') return await transfer(command, args);
  if (['new', 'list', 'info', 'stop', 'resume', 'fork', 'delete', 'extend'].includes(command)) return await lifecycle(command, args);
  throw new Error(`unknown command: ${command}\n\n${usage}`);
}

main().catch(error => fail(error?.message || String(error), 1));
