# Deployments

Where this fork actually runs. Keys are never committed; each row says where to
read them on the host.

## Public — `ocz.oxygenai.top` (Hong Kong)

| | |
|---|---|
| Host | `154.219.110.138` (Ubuntu 24.04, 2 vCPU / 2 GB) |
| Source | `/opt/freeopencodezen` |
| Service | `systemctl status freeopencodezen` (systemd, `Restart=always`) |
| Listens | `127.0.0.1:6446` |
| Ingress | OpenResty (1Panel) site `ocz.oxygenai.top`, config `/opt/1panel/www/conf.d/ocz.oxygenai.top.conf`, proxied through Cloudflare |
| Surface | `API_SURFACE=all` — OpenAI, Anthropic and System One |
| Log | `/var/log/freeopencodezen.log` |

Endpoints:

```
https://ocz.oxygenai.top/v1/chat/completions   OpenAI chat completions
https://ocz.oxygenai.top/v1/responses          OpenAI Responses (Codex-style clients)
https://ocz.oxygenai.top/v1/models             model list
https://ocz.oxygenai.top/v1/messages           Anthropic messages
https://ocz.oxygenai.top/v1/systemone          TypeSafe System One (jev-1.13)
https://ocz.oxygenai.top/health                status, surface and mounted routes
https://ocz.oxygenai.top/app                   web console (ADMIN_PASSWORD in /opt/freeopencodezen/.env)
```

Read the API keys:

```bash
grep -o '"name":"[a-z-]*","key":"oc-[a-f0-9]*"' /var/log/freeopencodezen.log
```

Jev only answers from a non-restricted egress. From mainland China the upstream
System One service replies `451 Endpoint is unavailable`; the same call from this
host returns the probabilities.

## Local — WSL `Ubuntu-26.04`

| | |
|---|---|
| Source | `/opt/freeopencodezen` |
| Service | `sudo systemctl status freeopencodezen` (systemd inside WSL) |
| Listens | `127.0.0.1:6447` — local traffic only, never bound to a routable address |
| Surface | `API_SURFACE=openai` — `/v1/chat/completions`, `/v1/responses`, `/v1/models` |
| Log | `/var/log/freeopencodezen.log` |

```bash
curl http://127.0.0.1:6447/health
sudo grep -o '"name":"[a-z-]*","key":"oc-[a-f0-9]*"' /var/log/freeopencodezen.log
```

`/v1/messages` and `/v1/systemone` are intentionally not mounted here and answer
404. Jev is reached through the Hong Kong deployment instead, because the local
egress is region-restricted.

## Windows desktop (this workstation)

| | |
|---|---|
| Source | `C:\Users\Sails\Documents\Workspace\01-Active\OpenCodeProxyHub-src` |
| Autostart | Scheduled Task `OpenCodeProxyHub` (at logon) → `scripts\hub-service.vbs` → `hub-service.cmd` → `node dist/main.js` |
| Listens | `127.0.0.1:6446` |
| Surface | `API_SURFACE` unset (all) |
| Log | `logs\service.log` |

## Updating a Linux deployment

```bash
cd /opt/freeopencodezen
tar -xzf /tmp/freeoczen.tgz -C /opt/freeopencodezen
npm install --no-audit --no-fund && npm run build
sudo systemctl restart freeopencodezen
curl -s http://127.0.0.1:6446/health   # or 6447 on WSL
```

## Notes on the domain

`ocz.oxygenai.top` is a single-level subdomain, so Cloudflare's Universal SSL
wildcard (`*.oxygenai.top`) covers it. A two-level name such as
`free.ocz.oxygenai.top` resolves but fails the TLS handshake at the Cloudflare
edge — that needs an Advanced Certificate or Cloudflare for SaaS, so the gateway
is published on the one-level name instead.
