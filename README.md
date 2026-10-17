# OpenCodeProxyHub

OpenCodeProxyHub 是一个独立的 AI API 网关，把 OpenCode 免费模型通过 **OpenAI 兼容** 与 **Anthropic 兼容** 的接口暴露出来，让任意支持这两种协议的客户端（opencode、各类 OpenAI/Claude SDK、第三方工具）都能直接接入。

后端为 TypeScript + Fastify，前端为 React + Vite 控制台。除了协议转换，网关还内置了 API Key 管理、出口代理池、限流、可观测性与 Docker 部署，目标是一个“可长期运行、可视化运维”的网关，而不只是一个轻量转发脚本。

OpenCodeProxyHub 基于 MIT 许可证开源，派生并大量借鉴自 [`opencode-free-proxy`](https://github.com/bigdata2211it-web/opencode-free-proxy)（同为 MIT）。本项目独立维护，与 OpenCode、`opencode-free-proxy` 及任何上游服务方均无隶属关系。

## ⚠️ 免责声明 / Disclaimer

**中文**

- 本项目仅供个人学习与技术研究使用，用于理解 OpenAI / Anthropic 兼容协议、API 网关与流式转换等实现细节。
- 使用本项目对接任何第三方服务时，使用者须自行阅读并遵守该服务的服务条款、使用政策以及所在地区的相关法律法规。
- 因使用、修改或分发本项目而产生的任何后果与责任，均由使用者自行承担，本项目作者及贡献者不承担任何责任。
- 本项目与 OpenCode、`opencode-free-proxy` 及任何第三方服务提供方均无任何隶属、授权或合作关系。
- 如本项目的任何内容被认为不适当，请提交 issue，我们会尽快处理。

**English**

- This project is provided for personal study and technical research only — to understand OpenAI/Anthropic-compatible protocols, API gateways, and streaming-conversion details.
- When using this project with any third-party service, you are solely responsible for reading and complying with that service's terms of use and the laws and regulations applicable to you.
- Any consequences and liabilities arising from use, modification, or distribution of this project are borne solely by the user. The authors and contributors accept no liability.
- This project has no affiliation, authorization, or partnership with OpenCode, `opencode-free-proxy`, or any third-party service provider.

## 可用免费模型

OpenCodeProxyHub 默认内置以下免费模型，均可通过 OpenAI 兼容接口 `/v1/chat/completions` 与 Anthropic 兼容接口 `/v1/messages` 调用：

| 模型 ID | 说明 |
|--------|------|
| `big-pickle` | OpenCode 免费模型（stealth） |
| `space-bunny` | Space Bunny 免费模型 |
| `nemotron-3.5-lightning` | Nvidia Nemotron 3.5 Lightning 免费模型 |
| `nemotron-3.5-super-vl` | Nvidia Nemotron 3.5 Super VL 免费模型 |
| `mimo-v2.6-flash` | Mimo v2.6 Flash 免费模型（后端 1M 上下文） |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash 免费模型（后端 1M 上下文） |
| `glm-5.3-flash` | GLM 5.3 Flash 免费模型 |
| `longcat-2.5-preview` | LongCat 2.5 Preview 免费模型 |
| `muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor 免费模型 |
| `jev-1.13` | TypeSafe System One 决策模型（走 `/v1/systemone`，不是对话模型） |

> **命名规则**：对外模型名不带上游的 `-free` 后缀，网关在发请求时把它补回去（`space-bunny` → 上游 `space-bunny-free`），流式与非流式响应也都会把模型名改回对外名。上游 id 本身无后缀的模型（目前只有 `big-pickle`）登记在 `src/models/naming.ts` 的 `UPSTREAM_MODEL_EXCEPTIONS`。

> **区域说明**：`beam`、`muse-spark-1.2-contributor`、`muse-spark-1.3-contributor` 会被上游按地区限制（实测中国大陆出口返回 403 `This model is not available in your country`，经香港出口代理复测同样 403）；若所在区域不可用，直接禁用该模型即可。`muse-spark` 系列为 Contributor 定价（以 prompt/completion 换训练授权），使用前请阅读相关条款。

> **上游指纹门（2026-10-11 起，2026-10-17 按官方客户端产物校准）**：免费层已从 `/zen/v1` 迁到 `/inference/v1`，旧路径对匿名请求一律返回 `403 FreeTierError`。网关按官方 CLI 的实际请求构造：走 `/inference/v1`；强制 `stream: true`（非流式客户端由网关把 SSE 折叠成单个 JSON 响应）；请求体带 `bash` 与 `read` 两个工具（按小写名精确匹配，各自带真实参数 schema，缺失即 403，网关会自动补齐占位工具）；请求头为官方客户端对 `opencode/*` provider 发的那一组 —— `x-opencode-session-id` 与 `x-opencode-session` 同值、`x-opencode-project: global`、`x-opencode-request`（每请求一个 `msg_` id）、`x-opencode-client: cli`，以及 `User-Agent: opencode/1.19.3 ai-sdk/provider-utils/4.0.45 runtime/bun/1.3.14`；**不发** `HTTP-Referer`，也默认不发 `x-session-affinity` / `x-session-id`（那两个是官方给非 OpenCode provider 用的，需要旧行为时用 `ZEN_LEGACY_SESSION_HEADERS=1`）。session id 前 12 位 hex 必须是取反后的时间戳（`ses_` 降序），纯随机或摘要派生即拒。以上取值来自对官方 v1.19.3 产物的静态提取，证据见 `OpenCode-REA-2026-10-17/06-free-tier-fingerprint.zh.md`。上游错误现在按真实状态码透传（403 不再被改写成 429）。

> **出口信誉与轮换（2026-10-17）**：门禁判定的是**出口 IP**，不是请求形态——同一份请求在大陆直连是 403、经普通代理出口则是 200。网关因此在指纹通道上做出口轮换：403 `FreeTierError` 把该节点冷却 15 分钟后换出口并用新 session 重试；传输层失败（TLS 重置/断连）只冷却 60 秒后换出口重试；429 短暂冷却后换出口重试；全部尝试失败才触发共享熔断。尝试次数与冷却分别由 `FREE_TIER_RETRY_ATTEMPTS`、`FREE_TIER_BAN_COOLDOWN_MS`、`FREE_TIER_TRANSPORT_COOLDOWN_MS`、`FREE_TIER_GATE_COOLDOWN_MS` 控制；没有配置任何出口节点时行为回退到"直连 → 403 → 熔断"。经过验证的部署方式：每个实例在代理池里挂一个可用的本地/远端代理节点即可恢复免费层。

新部署会自动生成以上默认模型；已有部署升级后，缺失的默认免费模型会自动追加到已有 `models.json`，不会覆盖用户已修改的模型配置。带旧 `-free` 后缀的条目会在升级时自动禁用并标注 `(retired: Renamed to …)`；上游已下线的模型（如 `mimo-v2.5-free`、`ling-3.0-flash-fin-free`、`laguna-s-2.1-free`、`deepseek-v4-flash-free`、`hy3-free`、`x-preview-f-free`、`north-mini-code-free`、`longcat-2.0-free`）同样会自动禁用并标记原因，用户无需手动清理。此前被自动禁用的模型若重新上线，升级后会仅恢复带下线标注的条目自动重新启用；用户手动关闭的不受影响。

## 部署方式

项目支持三种部署方式，按方便程度排序：**拉取镜像快速部署**（最省事，推荐）、**本地构建 Docker 镜像**（改了源码想用容器跑）、**本地源码运行**（开发调试）。

三种方式都会在宿主机 `./data` 持久化配置（API Key、模型、代理、设置），容器删除重建数据仍在。

### 方式一：拉取镜像快速部署（推荐）

无需 clone 源码，只要一个 `docker-compose.yml` 即可启动**应用 + Redis**：

```bash
# 1. 下载编排文件与环境模板
curl -O https://raw.githubusercontent.com/JiuliNuoyi/OpenCodeProxyHub/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/JiuliNuoyi/OpenCodeProxyHub/main/.env.docker.example

# 2. 准备环境文件，并设置一个强密码
cp .env.docker.example .env.docker
#   编辑 .env.docker，把 ADMIN_PASSWORD 改成强密码

# 3. 启动（自动从 Docker Hub 拉取 jlny/opencode-proxy-hub 镜像）
docker compose up -d
```

启动后控制台在 `http://127.0.0.1:6446/app`，用 `.env.docker` 中的 `ADMIN_PASSWORD` 解锁。

升级到最新镜像：

```bash
docker compose pull
docker compose up -d
```

### 方式二：本地构建 Docker 镜像（改了源码）

clone 源码后，用开发覆盖文件从当前代码构建镜像再启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`docker-compose.dev.yml` 只覆盖镜像来源（改为本地 `build`），端口、卷、Redis、健康检查等都继承自主文件。

### 方式三：本地源码运行（开发调试）

```bash
# 1. 安装依赖（后端 + 前端）
npm install
npm --prefix web install

# 2. 构建后端与前端
npm run build:all

# 3. 启动
npm run dev          # 开发模式，热重载
# 或
npm start            # 运行已构建的 dist/main.js
```

默认监听 `http://localhost:6446`，控制台在 `http://localhost:6446/app`。本地运行时限流默认走内存（`REDIS_URL` 留空）；如需分布式限流可另行配置 Redis。

常用脚本：

```bash
npm run dev          # 后端开发模式（tsx watch）
npm run dev:web      # 前端开发服务器（Vite）
npm run build:all    # 构建后端 + 前端
npm run typecheck    # 类型检查（不产出）
npm start            # 运行已构建的 dist/main.js
```

> 首次启动会在 `api-keys.json` 自动生成 `admin` 与 `user-default` 两个 Key，明文仅在启动日志中显示一次，文件里只保存 SHA-256 哈希。管理接口与控制台默认密码为 `admin`（即 `ADMIN_PASSWORD`），**对外暴露前务必修改**。

更多健康检查、冒烟测试、备份、反向代理与升级说明见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。公网部署建议在前面再放一层 Nginx/Caddy 等 HTTPS 反向代理（需保留 `Authorization`/`x-api-key` 头、支持长连接 SSE、关闭对流式路径的缓冲）。

## 功能总览

- **协议面**
  - OpenAI 兼容：`POST /v1/chat/completions`、`POST /v1/responses`、`GET /v1/models`
  - Anthropic 兼容：`POST /v1/messages`
  - TypeSafe System One：`POST /v1/systemone`（`jev-*` 决策模型）
  - 同时支持流式（SSE）与非流式
  - `API_SURFACE=openai` 时可只挂载 OpenAI 那三条路由，用于本机/内网部署
- **Responses API 转换**：上游 Zen 对 `/inference/v1/responses` 只回
  `ModelProtocolUnsupported`，所以 `POST /v1/responses` 由网关把 Responses 请求翻成
  chat completions，再把流式增量重新编码成 Responses 事件（`response.output_item.added`
  / `response.output_text.delta` / `response.function_call_arguments.delta` /
  `response.completed` 等），Codex 这类只会说 Responses 协议的客户端可以直接接
- **System One（Jev）**：TypeSafe 的决策模型不是对话模型，只接受 `state` + 类型化
  `questions`，返回校准概率。上游对部分区域返回 451，需要非受限出口
- **默认免费模型**：内置 10 个可用免费模型，详见上方“可用免费模型”
- **流式归一化转换（可按模型开启）**
  - `anthropic-sse-to-openai`：把上游的 Anthropic 风格 SSE 转成 OpenAI 风格 SSE
  - `think-to-reasoning`：把内联在 `delta.content` 里的 `<think>...</think>` 推理内容抽取到 `reasoning_content` 字段，正文只保留答案（支持标签跨 chunk 的状态机处理）
  - 不在列表内的模型走纯字节透传，零行为变化
- **API Key 管理**
  - 仅持久化 SHA-256 哈希，明文只在创建时返回一次
  - 兼容旧版 `{name: key}` 文件，自动迁移为带版本号的结构
  - 可选 `STORE_PLAINTEXT_API_KEYS` 模式：额外保存可恢复明文，便于在控制台复制
  - 每个 Key 支持独立**策略**：每分钟请求数、并发请求/并发流上限、允许的模型白名单、是否允许走出口代理
  - 记录请求计数、最近使用时间、最近客户端（按 `x-client-id` / `user-agent` 聚合）
- **出口代理池**
  - 支持 HTTP / HTTPS / SOCKS5 节点
  - **优先填充**选择策略：按权重从高到低，持续使用第一个可用节点，直到其禁用 / 冷却 / 达到并发或每日上限
  - 连续 5 次上游 429 自动禁用节点；非 429 失败进入冷却（默认 5 分钟）
  - 每日请求上限与按日自动重置，可选“达上限自动禁用 / 次日自动恢复”
  - 节点连通性测试、成功/失败计数、最近 20 次请求结果（用于前端可视化）
  - **代理使用模式**：可在控制台选择直连、优先代理或强制代理；优先代理模式下无可用节点会自动直连
  - **链式前置代理**：所有节点出站可先经一个本机 HTTP/HTTPS 前置代理再连上游，适合节点无法直连、需先走本机代理出网的网络；可在控制台热重载开关与地址，**无需重启**
- **限流**
  - 全局每分钟请求数 + 单 Key 每分钟请求数 + 单 Key 并发请求/并发流上限
  - 默认内存实现；配置 `REDIS_URL` 后自动切换为基于 Redis Lua 脚本的分布式限流（支持多实例）
- **可观测性**
  - HTTP / 上游请求计数、错误率、P50/P95/P99 延迟、按状态码与路由分布、按代理分布、最近错误
  - 可配置的文件日志：管理审计日志、AI 请求摘要日志（含出口代理字段）、错误日志，JSONL 按天切分、按保留天数自动清理，可选记录 Prompt
- **内置 Web 控制台**（`/app`）
  - 总览、API Keys、模型、设置、代理池、监控六大页面
  - 代理池含成功率、近 N 次请求结果色条、用量/并发/连续 429 仪表
- **运维友好**
  - 优雅停机：关闭前排空在途请求（可配置超时）
  - 健康检查 `GET /health`
  - Docker + Docker Compose（含 Redis）一键部署

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 20+ |
| 后端 | TypeScript 5、Fastify 5、`@fastify/cors`、`@fastify/static` |
| 代理 | `https-proxy-agent`、`socks-proxy-agent` + 自研链式前置代理 Agent |
| 限流/状态 | 内存实现，或可选 Redis（`redis`）|
| 配置 | `dotenv` + JSON 文件持久化（api-keys / models / settings / proxies）|
| 前端 | React 19、Vite 6、Tailwind CSS 3、shadcn/ui（Radix）、Motion、Recharts、lucide-react |
| 部署 | Docker、Docker Compose（`node:20-bookworm-slim`，linux/amd64 + linux/arm64）|
| 许可证 | MIT |

## 项目架构与逻辑

### 整体架构

```
客户端 (opencode / OpenAI SDK / Claude SDK / curl)
        │  OpenAI 或 Anthropic 协议
        ▼
┌──────────────────────────────────────────────┐
│ OpenCodeProxyHub (Fastify)                     │
│                                                │
│  鉴权 (API Key 哈希)  →  限流 (内存/Redis)      │
│  路由 /v1/chat/completions  /v1/messages       │
│  流式转换 (passthrough / sse 转换 / think 抽取) │
│  代理池 (优先填充 + 可选链式前置代理)            │
│  可观测性 (指标 + JSONL 日志)                   │
│  Web 控制台 /app                               │
└──────────────────────────────────────────────┘
        │  出口（可选经代理池 / 前置代理）
        ▼
   OpenCode Zen 上游 API
```

### 代码结构

```
src/
  app.ts                 # 组装所有 store、限流器、路由，构建 Fastify 实例
  main.ts                # 进程入口、优雅停机
  config/env.ts          # 环境变量 → AppConfig
  auth/                  # API Key 哈希鉴权、管理员鉴权
  rateLimit/limiter.ts   # 内存 / Redis 两种限流实现（同一接口）
  routes/                # openai / anthropic / admin / models / health / web 路由
  providers/zenClient.ts # 构造上游请求、透传上游响应
  converters/            # anthropicSseToOpenAi、openAiThinkTagToReasoning 等流式转换
  proxy/                 # 代理池（优先填充）、链式前置代理 Agent
  models/catalog.ts      # 模型开关与元数据
  settings/              # 系统设置（热更新）
  observability/         # 指标 metrics、JSONL 事件日志
  runtime/               # 在途请求追踪（优雅停机排空）
  sessions/、storage/、utils/

web/src/
  App.tsx                # 控制台外壳
  hooks/useConsoleData.ts# 统一拉取/变更后端数据
  views/                 # dashboard / keys / models / settings / proxy / monitor
  components/            # 复用组件（仪表条、结果色条、弹窗等）
```

### 请求处理流程（以 `POST /v1/chat/completions` 为例）

1. **在途登记**：`RequestTracker` 登记本次请求（用于优雅停机时排空）；若正在排水则返回 503。
2. **鉴权**：从 `Authorization: Bearer` 或 `x-api-key` 取 token，按 SHA-256 哈希比对；失败返回 401。
3. **客户端记录**：按 `x-client-id` / `user-agent` 聚合记录该 Key 的最近客户端。
4. **限流**：依次校验全局 RPM、单 Key RPM、并发请求数、并发流数（Key 策略可覆盖默认值）；超限返回 429 并带 `Retry-After`。
5. **模型校验**：模型必须存在且启用，且在该 Key 的模型白名单内（白名单为空=全部允许）；否则 400/403。
6. **会话解析**：按 (Key, 协议, 模型, 头部) 解析/复用一个上游会话 ID。
7. **构造上游请求**：`prepareZenRequest` 组装上游请求体与 `x-opencode-*` 头；按当前代理使用模式与 Key 策略决定是否从**代理池**按优先填充取一个节点（lease），并据当前设置决定是否再套一层**链式前置代理**。
8. **响应处理（按模型路由）**：
   - 命中 `openAiStreamTransformModels` → `anthropic-sse-to-openai` 转换后转发；
   - 命中 `reasoningTagModels` → `think-to-reasoning` 抽取 `<think>` 后转发；
   - 其余 → 纯字节透传。
9. **回写与计数**：流式逐块写回客户端；根据上游结果给代理节点 `markSuccess` / `markFailure`（连续 429 触发熔断、其他失败进入冷却）。
10. **释放与记账**：释放限流名额与在途登记，写入指标（HTTP/上游延迟分位、状态码、按代理分布）与请求日志（含出口代理字段、可选 Prompt）。

### 代理选择逻辑（优先填充，非轮询）

从所有“启用、未冷却、未达每日上限、未达并发上限”的节点中，**按权重从高到低排序，始终取第一个**。也就是说高权重节点会被持续打满，直到它不可用，才轮到下一个——而不是请求在节点间轮转。节点连续 5 次上游 429 自动禁用（需手动重启用），其他失败进入冷却（默认 5 分钟）。

## 调用示例

OpenAI 兼容（流式）：

```bash
curl -N http://127.0.0.1:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}]
  }'
```

Anthropic 兼容：

```bash
curl http://127.0.0.1:6446/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-flash",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

OpenAI Responses（Codex 等只说 Responses 协议的客户端用这条）：

```bash
curl http://127.0.0.1:6446/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "input": "用一句话介绍你自己",
    "stream": true
  }'
```

TypeSafe System One（`jev-*` 决策模型，返回校准概率而不是文本）：

```bash
curl http://127.0.0.1:6446/v1/systemone \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jev-1.13",
    "state": "I have been trying to connect my Stripe account for 3 days and the integration keeps failing.",
    "questions": {
      "urgency": {"type": "noul", "instructions": "Does this message express urgency?"},
      "team": {
        "type": "choice",
        "instructions": "Which team should handle this",
        "criteria": {
          "billing": "Payments, invoices, refunds",
          "technical": "Integration errors, API failures, bugs"
        }
      }
    }
  }'
```

## Web 控制台

控制台在 `/app`，登录后可：

- **总览**：网关状态、Key 数量、代理节点、AI 请求数等关键指标
- **API Keys**：创建（明文显示一次并可复制）、启用/禁用、删除、备注与标签、每 Key 策略（RPM、并发、模型白名单、是否允许代理）、查看请求量与最近客户端
- **模型**：启用/禁用模型，按模型开启 `anthropic-sse-to-openai` 与 `think-to-reasoning` 两种流式转换
- **设置**：上游超时、请求体限制、默认流式、文件日志与审计开关、Prompt 记录、日志正文上限与保留天数
- **代理池**：新增/编辑/删除/测试节点，查看优先节点、成功率、近 N 次请求结果色条、用量/并发/连续 429 仪表，切换代理使用模式，开关与配置链式前置代理（热重载）
- **监控**：HTTP/上游请求量、错误率、延迟分位、状态码与路由分布、限流器后端、运行时长、最近错误

控制台密码或开发 API Key 保存在浏览器本地存储中。

## 配置（环境变量）

复制 `.env.example` 为 `.env` 并按需调整：

```text
PROXY_PORT=6446                         # 监听端口
PROXY_HOST=0.0.0.0                      # 监听地址
KEYS_FILE=./api-keys.json               # API Key 持久化文件
MODELS_FILE=./models.json               # 模型配置文件
SETTINGS_FILE=./settings.json           # 系统设置文件
PROXIES_FILE=./proxies.json             # 代理池文件
LOGS_DIR=./logs                         # 日志目录
ADMIN_PASSWORD=admin                    # 管理接口/控制台密码（务必修改）
ZEN_HOST=opencode.ai                    # 上游主机
ZEN_PATH=/inference/v1/chat/completions  # 上游对话补全路径
ZEN_SYSTEMONE_PATH=/inference/v1/systemone  # 上游 System One（jev-*）路径
ZEN_OPENCODE_UA=opencode/1.19.3 ai-sdk/provider-utils/4.0.45 runtime/bun/1.3.14  # 指纹通道 UA
ZEN_LEGACY_SESSION_HEADERS=0            # 1=额外发送 x-session-affinity / x-session-id（旧形态）
API_SURFACE=all                          # all=全协议；openai=只挂 OpenAI 三条路由
UPSTREAM_TIMEOUT_MS=120000              # 上游超时
GLOBAL_REQUESTS_PER_MINUTE=120          # 全局每分钟请求上限
API_KEY_REQUESTS_PER_MINUTE=60          # 单 Key 每分钟请求上限
API_KEY_MAX_CONCURRENT_REQUESTS=10      # 单 Key 并发请求上限
API_KEY_MAX_CONCURRENT_STREAMS=5        # 单 Key 并发流上限
FREE_TIER_RETRY_ATTEMPTS=3              # 指纹通道每次请求的最大出口尝试次数
FREE_TIER_BAN_COOLDOWN_MS=900000        # 出口被判 403 后的冷却（毫秒）
FREE_TIER_TRANSPORT_COOLDOWN_MS=60000   # 出口传输层失败后的冷却（毫秒）
FREE_TIER_GATE_COOLDOWN_MS=60000        # 全部尝试失败后的共享熔断窗口（毫秒）
REDIS_URL=                              # 留空=内存限流；填写=Redis 分布式限流
REDIS_KEY_PREFIX=opencode-proxy-hub:limit
SHUTDOWN_DRAIN_TIMEOUT_MS=30000         # 优雅停机排空超时
STORE_PLAINTEXT_API_KEYS=false          # 是否额外保存可恢复明文
PROXY_MODE=optional                     # 代理使用模式：direct / optional / required
OUTBOUND_PRE_PROXY_ENABLED=false        # 是否启用链式前置代理
OUTBOUND_PRE_PROXY_URL=                 # 前置代理地址（http/https）
REQUIRE_PROXY=false                     # 兼容旧配置；未设置 PROXY_MODE 时 true 等价于 required
```

设置项中的 `upstreamTimeoutMs`、代理使用模式、前置代理开关与地址等也可在运行时通过控制台或 `PATCH /admin/settings` **热更新**，无需重启。

## 出口代理与前置代理

- 代理使用模式支持三种：`direct` 强制直连，`optional` 有可用代理则使用、否则直连，`required` 必须使用代理、无可用节点则失败。
- 代理池节点正常情况下**直连**自己配置的代理 URL。
- 选择策略为**优先填充**：按权重从高到低排序，持续使用第一个“启用、未冷却、未达每日上限、未达并发上限”的节点。
- 节点连续 5 次收到上游 429 会被自动禁用，需手动重新启用；其他失败会进入冷却（默认 5 分钟）。
- 若节点无法直连、需要先经本机代理出网，可启用**链式前置代理**：

```text
OUTBOUND_PRE_PROXY_ENABLED=true
OUTBOUND_PRE_PROXY_URL=http://host.docker.internal:7897
```

  前置代理为 HTTP/HTTPS，可链接到 `http`、`https`、`socks5` 三类代理池节点；开关与地址支持控制台热重载，对下一个请求即时生效。
- `PROXY_MODE=required` 时，没有可用代理节点的请求会直接失败，而不是回退到直连上游。

## 限流

- 维度：全局每分钟请求数、单 Key 每分钟请求数、单 Key 并发请求数、单 Key 并发流数；每个 Key 可用策略覆盖默认值。
- 后端：默认内存实现；配置 `REDIS_URL` 后自动切换为基于 Redis Lua 脚本的原子限流，可在多实例间共享计数。

## 管理 API

所有 `/admin/*` 接口需在 `Authorization: Bearer <ADMIN_PASSWORD>` 下访问。

```text
GET    /admin/session            # 当前鉴权状态
GET    /admin/api-keys           # 列出 API Key
POST   /admin/api-keys           # 创建 API Key（明文仅返回一次）
GET    /admin/api-keys/:id/secret# 读取可恢复明文（需开启明文存储）
PATCH  /admin/api-keys/:id       # 更新名称/启停/备注/标签/策略
DELETE /admin/api-keys/:id       # 删除 API Key
GET    /admin/models             # 列出模型
PUT    /admin/models/:id         # 新增或更新模型
DELETE /admin/models/:id         # 删除模型
GET    /admin/settings           # 读取系统设置
PATCH  /admin/settings           # 更新系统设置（热生效）
GET    /admin/proxies            # 列出代理节点
POST   /admin/proxies            # 新增代理节点
PATCH  /admin/proxies/:id        # 更新代理节点
DELETE /admin/proxies/:id        # 删除代理节点
POST   /admin/proxies/:id/test   # 测试代理连通性
GET    /admin/runtime            # 运行时与限流器快照
GET    /admin/metrics            # 指标快照
```

创建 Key：

```bash
curl -X POST http://127.0.0.1:6446/admin/api-keys \
  -H "Authorization: Bearer YOUR_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"name":"default-user"}'
```

按模型开启 `<think>` 推理抽取：

```bash
curl -X PATCH http://127.0.0.1:6446/admin/settings \
  -H "Authorization: Bearer YOUR_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"reasoningTagModels":["big-pickle"]}'
```

## 本地数据文件

以下文件在首次运行时生成，已被 `.gitignore` 忽略，**不要提交**：

```text
api-keys.json    # API Key（哈希，可选明文）
models.json      # 模型开关与元数据
settings.json    # 系统设置
proxies.json     # 代理池节点与运行计数
```

API Key 文件结构（节选）：

```json
{
  "version": 1,
  "keys": [
    {
      "id": "...",
      "name": "admin",
      "keyHash": "...",
      "keyPrefix": "oc-1234...abcd",
      "enabled": true,
      "policy": {},
      "createdAt": "...",
      "lastUsedAt": null
    }
  ]
}
```

旧版 `{ "admin": "oc-plain-text-key" }` 格式会在加载时自动迁移到上述结构。

## 安全提示

- 对外暴露前务必修改 `ADMIN_PASSWORD`。
- API Key 默认只存哈希；开启 `STORE_PLAINTEXT_API_KEYS=true` 后新建 Key 会额外保存可恢复明文，请严格保护 `api-keys.json`（此前创建的 Key 无法恢复明文）。
- 不要把 `api-keys.json`、`.env`、`.env.docker` 等敏感文件提交到仓库。

## 文档

- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — 部署、健康检查、备份、升级
- [`DEPLOYMENTS.md`](./DEPLOYMENTS.md) — 本仓当前实际运行的实例、端点与运维命令
- [`DECISIONS.md`](./DECISIONS.md) — 决策台账（已否决的方向，避免重复提议）
- [`VERIFICATION.md`](./VERIFICATION.md) — 上游指纹门的实测证据、逐模型可用性与部署记录
- [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md) — 分阶段实现计划与开发记录

## 许可证

OpenCodeProxyHub 基于 MIT 许可证发布，见 [`LICENSE`](./LICENSE)。

归属与第三方声明维护在：

- [`NOTICE`](./NOTICE)
- [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)

MIT 许可证仅适用于本项目源代码本身，**不授予**使用任何第三方服务、API、商标、模型提供方、代理提供方或基础设施的权利——这些须遵循各自的条款。

## 致谢与归属

本项目派生并大量借鉴自 [`opencode-free-proxy`](https://github.com/bigdata2211it-web/opencode-free-proxy)（其 `package.json` 与 `README.md` 声明 MIT 许可证）。

OpenCodeProxyHub 复现并扩展了原项目的核心兼容行为（OpenAI/Anthropic 兼容接口、OpenCode Zen 上游转发、`x-opencode-*` 请求头、模型兼容与消息转换思路），并在此基础上重写与扩展为：TypeScript/Fastify 架构、React Web 控制台、API Key 管理、代理池与链式代理、限流、可观测性与 Docker 部署。

OpenCodeProxyHub 独立维护，与 OpenCode、`opencode-free-proxy` 及任何上游服务方均无隶属关系。

## 更新记录

- **v0.2.0（本仓 fork 起点，OxygenAILab/FreeOpenCodeZen）**
  - 修复上游 2026-10-11 的迁移：上游路径改为 `/inference/v1`，按实测指纹构造请求
    （强制 `stream: true`、补齐 `bash`/`read` 工具、四个同值 session 头、不发
    `x-opencode-request` 与 `HTTP-Referer`、session id 用规范铸造）。原样代码在此之后
    对所有免费模型返回 403/429。
  - 错误按上游真实状态码透传，不再把 403 统一改写成 429。
  - 对外模型名去掉 `-free` 后缀，发请求时补回；流式与非流式的响应回显都改回对外名。
  - 新增 `POST /v1/responses`：把 Responses 协议翻成 chat completions 再转回 Responses 事件。
  - 新增 `POST /v1/systemone`：透传 TypeSafe System One（`jev-1.13`）决策模型。
  - 新增 `API_SURFACE`，可只挂 OpenAI 三条路由，供本机/内网部署。
  - 把 Node 的 `server.requestTimeout` 提到 `upstreamTimeoutMs + 60s`（默认 300s 会静默切断长流）。
  - 上游返回空流（只有 `: keep-alive`）时非流式路径报 502，不再当作成功。
  - `scripts/hub-service.cmd` + `hub-service.vbs` 提供 Windows 登录自启与崩溃自愈。
  - 上游退役 `ll-alpha-free`（实测 410 `has been deprecated`），已移出默认清单并标记下线。
  - 实测证据与逐模型结果见 [`VERIFICATION.md`](./VERIFICATION.md)。

- **v0.1.9**：同步官方 Zen 免费模型：新增 `ling-3.0-flash-fin-free`（实测可用）与 `muse-spark-1.3-contributor-free`（Muse Spark 1.3，注意本地区可能 403）两个默认免费模型；退役 `laguna-s-2.1-free`（上游 401 下线）与 `muse-spark-1.2-contributor-free`（被 1.3 取代）。默认免费模型保持 6 个。升级后自动禁用退役模型、追加缺失默认模型，不覆盖用户已有配置；老设备升级无需手动改 `models.json`
- **v0.1.8**：同步官方 Zen 免费模型：退役 `deepseek-v4-flash-free`（免费期结束，上游 400 不可用）、`hy3-free`（再次下线，上游 401）、`x-preview-f-free`（Ox Alpha，上游 401 不可用）；`muse-spark-1.2-contributor-free` 保留启用（注意本地区可能 403）。默认免费模型更新为 6 个。升级后自动禁用退役模型、追加缺失默认模型，不覆盖用户已有配置
- **v0.1.7**：同步官方 Zen 免费模型：新增 `x-preview-f-free`（Ox Alpha）与 `muse-spark-1.2-contributor-free`（Muse Spark 1.2 Contributor）两个默认免费模型；`deepseek-v4-flash-free`、`laguna-s-2.1-free` 经实测仍可用，保留不动。升级后新模型自动追加，不覆盖用户已有配置
- **v0.1.6**：同步官方 Zen 免费模型：恢复 `hy3-free`，新增 `nemotron-3.5-lightning-free`；退役 `north-mini-code-free`、`ling-3.0-flash-free`、`longcat-2.0-free`。升级后自动追加/禁用，不覆盖用户已有配置；此前被自动禁用的 `hy3-free` 升级后自动重新启用（手动关闭的不受影响）
- **v0.1.5**：新增 `longcat-2.0-free` 默认免费模型；已有部署升级后自动追加，无需改 `models.json`（已实测上游可用，端到端验证通过）
- **v0.1.4**：移除已下线的 `hy3-free`，新增 `laguna-s-2.1-free` 与 `ling-3.0-flash-free`；升级时自动禁用退役模型，新模型自动追加
- **v0.1.3**：新增 `hy3-free` 默认免费模型；已有部署升级后自动追加，无需改 `models.json`
- **v0.1.1**：新增 Nemotron 3 Ultra 默认模型、运行时代理模式
- **v0.1.0**：初始发布

完整变更记录见 Git 提交历史。

