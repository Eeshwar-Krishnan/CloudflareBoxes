# CloudflareBoxes

Run isolated Linux workspaces on Cloudflare, control them from a CLI or MCP client, and hand work between agents through temporary Git repositories.

> Early prototype. Has not been hardened for production use.

## What it does

- **Sandboxes:** create, inspect, stop, resume, fork, and delete Linux containers. Run commands with captured output and exit status.
- **File transfer:** upload and download small files through the Access-protected API.
- **Agent fan-out:** create an expiring Cloudflare Artifacts Git repository, issue short-lived read or write tokens, and share branches among agents. Delete it when the work has been collected.
- **MCP:** access the same sandbox and artifact operations through a Streamable HTTP endpoint at `/mcp`.
- **Access:** validate the Access JWT's signature, issuer, and audience. Sandbox and artifact ownership follows the user or service-token identity.

A Worker routes requests to one Durable Object per sandbox. The Durable Object starts a Cloudflare Container and coordinates filesystem snapshots. Artifacts provides the separate Git-compatible storage used for fan-out.

## Requirements

- A Cloudflare Workers Paid account with Containers, Durable Objects, Artifacts, and Zero Trust Access.
- Node.js 24 or newer, npm, and Docker for building the container image.
- Wrangler, installed with the project dependencies, authenticated to the intended Cloudflare account.
- A Cloudflare Access application covering the entire Worker hostname, with a human allow policy and a **Service Auth** policy for a service token.

## Deploy your own

```sh
git clone --recurse-submodules https://github.com/Eeshwar-Krishnan/CloudflareBoxes.git
cd CloudflareBoxes
npm install
npx wrangler whoami
```

Create a self-hosted Access application for your Worker hostname. In `wrangler.jsonc`, set `ACCESS_AUD` to its application audience and `TEAM_DOMAIN` to `https://<your-team>.cloudflareaccess.com`. Set the Artifacts namespace as desired. The checked-in Access values refer to the original deployment; replace them for your own account. Review the account, namespace, container settings, and cron trigger before deploying:

```sh
npm run typecheck
npm test
npm run deploy
```

The Worker verifies the signed Access assertion itself and rejects requests without a valid assertion, including requests reaching an unprotected hostname. Configure Access on **every** route to the Worker, including `workers.dev`; do not use an Access bypass policy. Wrangler's simulated local Access identity does not generate the signed assertion this Worker expects, so authenticated end-to-end testing needs a real Access-protected hostname.

## Use the CLI

Set your Worker URL and an Access service token in your environment. Keep the secret out of shell history, source control, and logs.

```sh
export CFBOX_URL="https://your-worker.example.com"
export CF_ACCESS_CLIENT_ID="..."
export CF_ACCESS_CLIENT_SECRET="..."

node cli/cfbox.mjs new --json
node cli/cfbox.mjs new --size standard-3 --json
node cli/cfbox.mjs list --json
node cli/cfbox.mjs exec BOX_ID -- sh -c 'node --version && git --version'
node cli/cfbox.mjs upload BOX_ID ./notes.txt /workspace/notes.txt
node cli/cfbox.mjs download BOX_ID /workspace/notes.txt ./notes-copy.txt
node cli/cfbox.mjs stop BOX_ID
node cli/cfbox.mjs resume BOX_ID
node cli/cfbox.mjs fork BOX_ID --json
node cli/cfbox.mjs delete BOX_ID
```

New boxes default to **`standard-2`** (1 vCPU). Choose a different Cloudflare instance type with `--size`; a fork inherits its parent's size and resume preserves it. Boxes created before size selection retain the former `lite` default.

| Size | vCPU | Memory | Disk |
| --- | ---: | ---: | ---: |
| `lite` | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1` | 1/2 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

See [Cloudflare instance types](https://developers.cloudflare.com/containers/platform/limits/) for current limits. Available capacity depends on your account.

`new` and `fork` emit a JSON ready event with an `id`. Commands run as argument arrays; use `sh -c` when shell syntax is needed. Pipe a script to `cfbox exec BOX_ID -- sh -s`. Run `node cli/cfbox.mjs help` for the full CLI. Uploads and downloads currently have a **64 KiB per-file limit**.

## Temporary Git repositories

Create an artifact for a short-lived collaboration and mint a write token:

```sh
node cli/cfbox.mjs artifact create --ttl 3600
node cli/cfbox.mjs artifact token ARTIFACT_ID --scope write --ttl 900
```

The first response contains the repository ID and Git remote; the second contains a token. Pass the token to Git for one operation without embedding it in the remote URL:

```sh
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $ARTIFACTS_TOKEN"
git remote add cfbox-temp "$ARTIFACTS_REMOTE"
git push cfbox-temp HEAD:refs/heads/main
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
```

Give agents appropriately scoped tokens so they can clone, fetch, and push their own branches. Collect and merge their work before closing the repository:

```sh
node cli/cfbox.mjs artifact delete ARTIFACT_ID
git remote remove cfbox-temp
```

Your normal `origin` is untouched. A scheduled cleanup also attempts to delete expired artifacts; the default repository lifetime is 24 hours. Artifacts is Git storage, not a general blob store, and write tokens grant access to the whole repository. See Cloudflare's [Git authentication](https://developers.cloudflare.com/artifacts/api/git-protocol/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/): new repositories are limited to 1 GB and pushes to 64 MiB.

## SSH and SCP

Cloudflare supports SSH to **running** Containers via Wrangler when the account user has container write access and an Ed25519 public key is configured. Wrangler can act as an OpenSSH proxy, including for SCP:

```sh
ssh -o ProxyCommand="wrangler containers ssh %h" cloudchamber@INSTANCE_ID
scp -o ProxyCommand="wrangler containers ssh %h" ./file cloudchamber@INSTANCE_ID:/workspace/file
```

Find the instance ID with `wrangler containers instances`. This uses Cloudflare account authentication, independently of the Access policy above, and does not start or keep a container alive. See [Cloudflare's SSH guide](https://developers.cloudflare.com/containers/guides/ssh/) for key configuration. CloudflareBoxes does not provide dedicated IPs or public raw TCP/UDP.

## Pricing

As of 2026-11-01, Workers Paid starts at $5/month. [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) includes 25 GiB-hours of memory, 375 vCPU-minutes, and 200 GB-hours of disk per month; additional usage is $0.0000025/GiB-second memory, $0.000020/vCPU-second CPU, and $0.00000007/GB-second disk. Memory and disk are billed while provisioned and running; CPU is billed for active usage. Network egress, Workers, Durable Objects, and observability can add charges.

[Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) says billing begins November 12, 2026: 10,000 operations and 1 GB-month included monthly, then $0.15 per 1,000 operations and $0.50 per GB-month. Repositories remain until explicitly deleted. Check current prices and limits before use.

## Limitations

Snapshots are beta, exclude running processes and mounted filesystems, expire, and can lose changes since the last successful checkpoint. A running instance can stop unexpectedly. Commands and their output are buffered; commands do not have a hard timeout. Sandboxes have outbound Internet enabled for Git and package installation, so code can send data and credentials it can read to the network. Desktop streaming, previews, lifecycle extensions, and Docker-in-Docker are not implemented.

The [upstream skills](https://github.com/ariana-dot-dev/cloud-sandbox-vm-skills) describe Box workflows but do not specify its full CLI or MCP contract. CloudflareBoxes is inspired by those recipes; it does not claim wire compatibility.
