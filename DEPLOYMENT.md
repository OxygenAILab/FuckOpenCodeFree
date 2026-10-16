# Deployment

This guide covers the Docker Compose deployment path for OpenCodeProxyHub.

## Files

- `Dockerfile` builds the TypeScript backend and Web UI, then runs `node dist/main.js` in a production image.
- `docker-compose.yml` starts the app and Redis.
- `.env.docker.example` is the production environment template.
- `./data` is mounted into the app container as `/app/data` for JSON persistence.

## First Start

Create the Docker environment file:

```bash
cp .env.docker.example .env.docker
```

Edit `.env.docker` and set a strong `ADMIN_PASSWORD` before exposing the service. The default password is `admin`.

Start the stack:

```bash
docker compose up -d --build
```

Open the Web UI:

```text
http://127.0.0.1:6446/app
```

Use the `ADMIN_PASSWORD` from `.env.docker` to unlock the admin console.

## Persistent Data

The Compose file stores JSON runtime configuration under `./data`:

```text
data/api-keys.json
data/models.json
data/settings.json
data/proxies.json
```

Redis stores limiter counters in the named volume `redis-data`.

Back up `./data` before upgrades or host migration:

```bash
tar -czf opencode-proxy-hub-data.tgz data
```

## Health Checks

App health:

```bash
curl http://127.0.0.1:6446/health
```

Compose health status:

```bash
docker compose ps
```

Logs:

```bash
docker compose logs -f app
```

## Smoke Tests Against Docker

Run protocol and local load smoke tests from the host after the stack is up:

```bash
npm run smoke:protocol
npm run smoke:load
```

Run the admin stability check with the same admin token:

```bash
ADMIN_PASSWORD=your-password npm run check:stability
```

On Windows PowerShell:

```powershell
$env:ADMIN_PASSWORD = "your-password"
npm run check:stability
```

## Reverse Proxy

Place Nginx, Caddy, or another HTTPS reverse proxy in front of `http://127.0.0.1:6446` for public deployment.

Minimum proxy requirements:

- preserve `Authorization` and `x-api-key` headers
- support long-lived streaming responses
- disable response buffering for SSE paths if possible
- forward client disconnects promptly

## Outbound Proxy Mode and Pre-Proxy

Proxy mode controls whether requests use the proxy pool:

```text
PROXY_MODE=optional
```

Supported values:

- `direct`: never use the proxy pool
- `optional`: use the first available proxy-pool node, otherwise fall back to direct upstream access
- `required`: require a proxy-pool node; fail the request when no node is available

`REQUIRE_PROXY=true` is kept as a legacy fallback when `PROXY_MODE` is not set, and is equivalent to `PROXY_MODE=required`.

If the Docker container cannot directly reach a proxy provider, enable the outbound pre-proxy chain:

```text
OUTBOUND_PRE_PROXY_ENABLED=true
OUTBOUND_PRE_PROXY_URL=http://host.docker.internal:7897
```

Use `host.docker.internal` when the pre-proxy runs on the Docker host. Use `127.0.0.1` only when running the Node app directly on the host.

The current MVP supports this chain:

```text
OpenCodeProxyHub -> HTTP/HTTPS pre-proxy -> proxy-pool node -> opencode.ai
```

Proxy-pool node types supported in chained mode: `http`, `https`, and `socks5`.

If `OUTBOUND_PRE_PROXY_ENABLED=false`, proxy-pool nodes use the original direct single-proxy behavior.

Proxy selection uses priority fill. The first available enabled node is used until it is unavailable, full, daily-limited, or disabled. A node is automatically disabled after 5 consecutive upstream 429 responses and requires manual re-enable. Use `PROXY_MODE=required` when requests must never fall back to direct upstream access.

## Windows Auto-Start (Scheduled Task)

## Linux Deployment (systemd, source checkout)

The source tree runs directly under Node 20+ without Docker:

```bash
sudo mkdir -p /opt/freeopencodezen && sudo chown -R "$USER" /opt/freeopencodezen
tar -xzf freeoczen.tgz -C /opt/freeopencodezen
cd /opt/freeopencodezen
cp .env.example .env      # then edit
npm install --no-audit --no-fund
npm run build
```

`/etc/systemd/system/freeopencodezen.service`:

```ini
[Unit]
Description=FreeOpenCodeZen gateway (OpenCode Zen free models)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/freeopencodezen
ExecStart=/usr/local/bin/node dist/main.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:/var/log/freeopencodezen.log
StandardError=append:/var/log/freeopencodezen.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now freeopencodezen
sudo grep -o '"name":"[a-z-]*","key":"oc-[a-f0-9]*"' /var/log/freeopencodezen.log
```

### Limiting the API surface

`API_SURFACE=openai` mounts only `/v1/chat/completions`, `/v1/responses` and
`/v1/models` — use it for a laptop or LAN instance that should not answer
Anthropic `/v1/messages` or `/v1/systemone`. `/health` reports the surface and
the routes actually mounted.

### Behind a reverse proxy

Streaming breaks if the proxy buffers, and slow free models exceed the usual
60s read timeout. For OpenResty/nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:6446;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    chunked_transfer_encoding on;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
}
```

Also raise `UPSTREAM_TIMEOUT_MS` for the free tier's slow models; the gateway
sets Node's `server.requestTimeout` to `upstreamTimeoutMs + 60s` so upstream is
always the one to time out first.

For a local source deployment on Windows there is no service wrapper in the
repo, so the gateway is registered as a logon-triggered Scheduled Task. Two
helper scripts do the work:

- `scripts\hub-service.cmd` — runs `node dist\main.js`, appends to
  `logs\service.log`, and restarts it 15s after any exit.
- `scripts\hub-service.vbs` — launches that loop with window style 0, so no
  console window appears.

Register (no administrator rights needed) and start it:

```powershell
$root = (Resolve-Path .).Path
$action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$root\scripts\hub-service.vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "OpenCodeProxyHub" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
Start-ScheduledTask -TaskName "OpenCodeProxyHub"
```

Because `RunLevel Limited` + `LogonType Interactive` is used, the task starts
when the user signs in. A true Windows service (`LogonType S4U`, or `sc.exe`)
needs elevation and would have to be registered from an administrator shell.

Inspect or stop it:

```powershell
Get-ScheduledTask -TaskName "OpenCodeProxyHub" | Select-Object TaskName, State
Get-Content .\logs\service.log -Tail 30
Get-Process node | Where-Object { $_.Path -like '*nodejs*' }   # find the running gateway
Stop-ScheduledTask -TaskName "OpenCodeProxyHub"                 # note: the keep-alive loop is detached
```

`Stop-ScheduledTask` does not kill the detached `cmd`/`node` pair once the task
action has returned; stop the `cmd.exe` running `hub-service.cmd` (or reboot) to
end the loop.

## Upgrade

```bash
docker compose pull
docker compose up -d --build
docker compose logs -f app
```

For local source deployments, `docker compose up -d --build` rebuilds the app image from the current checkout.

## Security Notes

- Always change `ADMIN_PASSWORD` in `.env.docker` for any shared or public environment.
- Keep `.env.docker` out of Git.
- Back up `./data`.
- Docker Compose enables `STORE_PLAINTEXT_API_KEYS=true` for operator convenience, so newly created API keys can be copied later from the Web UI.
- When `STORE_PLAINTEXT_API_KEYS=true`, complete API keys are stored in `data/api-keys.json`; protect this file like a secret.
- Existing keys created before plaintext recovery was enabled cannot be recovered; recreate them if needed.
- Rotate API keys from the Web UI if a key is exposed.
