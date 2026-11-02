---
name: cloudflareboxes
description: Use CloudflareBoxes to create and manage isolated Linux sandboxes, run commands, transfer small files, and coordinate agents through temporary Cloudflare Artifacts Git repositories. Use when the user requests CloudflareBoxes or this Cloudflare-backed sandbox service.
---

# CloudflareBoxes

Run `cfbox help` for the installed CLI. The local launcher loads `~/.config/cloudflareboxes/access.env` when connection variables are not already set. Do not print that file or tokens. The service uses Cloudflare Access and the personal deployment configured there; each Access identity has separate resources.

Typical workflow:

```sh
box_id="$(cfbox new --json | jq -r 'select(.event == "ready") | .id')"
cfbox exec "$box_id" -- sh -c 'pwd && node --version'
cfbox upload "$box_id" ./input.txt /workspace/input.txt
cfbox download "$box_id" /workspace/output.txt ./output.txt
cfbox delete "$box_id" --json
```

Choose a size with `cfbox new --size SIZE --json`; the default is `standard-2` (1 vCPU). Select based on the workload and cost: `lite` (1/16 vCPU, 256 MiB RAM, 2 GB disk), `basic` (1/4 vCPU, 1 GiB, 4 GB), `standard-1` (1/2 vCPU, 4 GiB, 8 GB), `standard-2` (1 vCPU, 6 GiB, 12 GB), `standard-3` (2 vCPU, 8 GiB, 16 GB), or `standard-4` (4 vCPU, 12 GiB, 20 GB). Prefer the default for ordinary work, select a larger size for memory or CPU intensive jobs, and a smaller size only for light workloads. Cloudflare bills provisioned memory and disk while running and active CPU usage. Forks inherit the source box's size; resume retains it.

Use `cfbox list`, `info`, `stop`, `resume`, and `fork` as needed. Clean up disposable sandboxes after collecting results. Commands execute directly; invoke `sh -c` for shell syntax. Piped stdin works with `cfbox exec ID -- sh -s`. Output is buffered, and upload/download is limited to 64 KiB per file. Internet access is enabled inside the sandbox: its code can access any credentials or files placed there. Stopping and forking use disk snapshots; processes do not survive. Unexpected termination may lose unsaved changes. No preview hosting, desktop, lifecycle extension, dedicated IP, raw TCP/UDP, or verified Docker-in-Docker support is implemented.

For fan-out, `cfbox artifact create --ttl 3600` returns an ID and Git remote; `cfbox artifact token ID --scope read|write --ttl 900` returns a short-lived token. Give agents the minimum needed access. Git can use `http.extraHeader` for the token; do not store tokens in remote URLs or commit them. Have agents push separate branches, collect their work, then run `cfbox artifact delete ID`. Artifacts expire and cleanup is scheduled, but explicit deletion is preferred. The original Git remote remains unchanged when a separate temporary remote is used. Artifact Git limits apply.

For SSH/SCP, Cloudflare account writers can use `wrangler containers ssh` as OpenSSH ProxyCommand after configuring an Ed25519 authorized key. This is separate from Access credentials and needs a running instance. Do not imply a public SSH address exists.

Reference and setup: https://github.com/Eeshwar-Krishnan/CloudflareBoxes. The upstream Box skills describe a different service and are not a CLI contract for CloudflareBoxes.
