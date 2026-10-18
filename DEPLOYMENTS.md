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
| Origin TLS | Let's Encrypt (ECDSA, `acme.sh` webroot), SAN `ocz.oxygenai.top` + `free.ocz.oxygenai.top`, auto-renewed by the root crontab |
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
| Listens | `0.0.0.0:6447` inside the NAT'd WSL VM — still host-local, see below |
| Surface | `API_SURFACE=openai` — `/v1/chat/completions`, `/v1/responses`, `/v1/models` |
| Log | `/var/log/freeopencodezen.log` |

```bash
curl http://127.0.0.1:6447/health          # from inside WSL
sudo grep -o '"name":"[a-z-]*","key":"oc-[a-f0-9]*"' /var/log/freeopencodezen.log
```

`/v1/messages` and `/v1/systemone` are intentionally not mounted here and answer
404. Jev is reached through the Hong Kong deployment instead, because the local
egress is region-restricted.

### Reaching it from Windows (read this before debugging "connection refused")

The unit binds `0.0.0.0` **inside** WSL. WSL2 is NAT'd, so that is still host-local
traffic only — but it gives two usable paths from Windows:

| From | Address | Notes |
|---|---|---|
| Inside WSL | `http://127.0.0.1:6447` | the primary path; always works |
| Windows | `http://<wsl-ip>:6447` | works; `wsl.exe -d Ubuntu-26.04 -- hostname -I` gives the IP |
| Windows | `http://localhost:6447` | goes through `wslrelay.exe` — see the caveat |

**Caveat.** Windows' `localhost` forwarding is a `wslrelay.exe` process created
when the WSL VM starts. It binds `127.0.0.1:6447` on the Windows side and proxies
into the distro. If the gateway inside WSL is restarted (`systemctl restart
freeopencodezen`), that relay goes stale: the Windows-side port stays bound but
connections hang instead of reconnecting. It does **not** self-heal — the relay
is only recreated on the next WSL VM start.

So after restarting the WSL gateway:

- keep using it from inside WSL, or
- use the WSL IP from Windows, or
- restart the distro (`wsl --terminate Ubuntu-26.04`) — note this also drops the
  xrdp desktop session, which the local `.wslconfig` deliberately protects with
  `vmIdleTimeout=86400000`, so do it only when that session is idle.

Because the logon task boots the distro at sign-in, a normal reboot restores the
`localhost` path.

> If `networkingMode=mirrored` is ever enabled in `.wslconfig`, `0.0.0.0` would
> expose this port to the LAN. In that case switch `PROXY_HOST` back to
> `127.0.0.1`.

## Windows desktop (this workstation)

| | |
|---|---|
| Source | `C:\Users\Sails\Documents\Workspace\01-Active\OpenCodeProxyHub-src` |
| Autostart | Scheduled Task `OpenCodeProxyHub` (at logon) → `scripts\hub-service.vbs` → `hub-service.cmd` → `node dist/main.js` |
| Listens | `127.0.0.1:6446` |
| Surface | `API_SURFACE` unset (all) |
| Log | `logs\service.log` |

## 免费层出口拓扑（2026-10-18）

免费层的 403 由**出口 IP 信誉**决定；当前只使用 WSL 上独立运行的
`mihomo-oc.service`，它从订阅中筛出两个已验证节点并暴露为固定 HTTP 监听器：

| WSL 监听 | 固定节点 | 用途 |
|---|---|---|
| `127.0.0.1:17895` | `🇭🇰香港-02` | 主出口 |
| `127.0.0.1:17896` | `🇯🇵日本-02` | 备用出口 |
| `127.0.0.1:17890` | fallback 组 | 调试/兼容，不作为网关主路径 |

网关代理池不再挂 Clash：共享 Clash 出口曾返回 403 并触发共享熔断。当前三处：

| 实例 | 代理池 |
|---|---|
| Windows 桌面 | `http://172.22.43.103:17895`、`http://172.22.43.103:17896`（WSL IP） |
| WSL `Ubuntu-26.04` | `http://127.0.0.1:17895`、`http://127.0.0.1:17896` |
| 香港 `ocz.oxygenai.top` | 反向 SSH 隧道 `127.0.0.1:17892` → WSL `17895`、`127.0.0.1:17893` → WSL `17896` |

WSL 的两个 systemd 单元：

```bash
systemctl status mihomo-oc          # 出口客户端与固定监听器
systemctl status hk-tunnel-mihomo   # 到香港的 17892/17893 反向隧道
```

注意事项：

- 网关按**最久未使用优先**轮换节点；某个节点被上游 403/429/传输错误冷却后，
  请求自动转到另一个节点，不再把全部流量压在一个 IP 上。
- 香港本机无法直连订阅节点（`kr-01...` 的 65501/65504/65505 实测超时），
  所以香港免费层依赖这台工作站与 WSL 在线；香港直连仍会被门禁 403。
- Windows 代理池里的 WSL IP 会随发行版重启变化（当前 `172.22.43.103`）；
  变化时用 `PATCH /admin/proxies/:id` 更新两个节点。
- 出口节点一律用管理接口维护，不要手改 `proxies.json`：
  `POST /admin/proxies`，`Authorization: Bearer <ADMIN_PASSWORD>`。

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

The **origin** does serve both names with a valid Let's Encrypt chain, so the
grey-cloud (DNS-only) route is available if someone wants `free.ocz` too:

1. In Cloudflare, set the `free.ocz.oxygenai.top` record to **DNS only**.
2. Done — the origin certificate already covers that name.

Otherwise the edge needs Total TLS, an Advanced Certificate, or Cloudflare for
SaaS, none of which are reachable without dashboard access.

### Renewal

`acme.sh` installed a root crontab entry (`acme.sh --cron`) and the install hooks
reload OpenResty via `docker exec 1Panel-openresty-RXS6 openresty -s reload`, so
renewal is hands-off. Verify with:

```bash
openssl x509 -in /opt/1panel/www/sites/ocz.oxygenai.top/ssl/fullchain.pem \
  -noout -subject -issuer -dates -ext subjectAltName
echo | openssl s_client -connect 127.0.0.1:443 -servername ocz.oxygenai.top -showcerts 2>/dev/null \
  | grep -E "^ *[0-9]+ s:"
```
