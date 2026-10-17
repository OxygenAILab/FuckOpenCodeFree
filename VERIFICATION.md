# 免费端点可用性验证（2026-10-16）

本文件记录本机部署 OpenCodeProxyHub 后的实测结论、必要补丁与逐模型结果。
所有结论来自真实调用，不是推测。

## 1. 结论

- 上游 OpenCode Zen **免费端点当前可用**。走 `/inference/v1` 并满足下述请求指纹时返回 200。
- 仓库原样（v0.1.9，最后提交 2026-09-05）**不可用**：它仍在打 `/zen/v1`，该路径对匿名请求一律 403。
- 上游目录当前列 12 个 `*-free` 项，加上 stealth 的 `big-pickle` 共 13 个；本机实测
  **9 个可用**，3 个被上游按地区拒绝，1 个协议不支持。另有已移出目录的
  `nemotron-3-ultra-free`，它接受请求后只重复 `: keep-alive` 注释、约 300s 后空手关闭，
  实际不可用，已在 `models.json` 中禁用。
- 经过补丁后，网关四条路径（OpenAI 流式/非流式、Anthropic 流式/非流式）全部返回 200。
- 对外模型名不再带上游的 `-free` 后缀，网关发请求时补回去，上游流量不变。

当前启用的 10 个模型里，**6 个稳定可用**（`big-pickle`、`space-bunny`、
`nemotron-3.5-super-vl`、`mimo-v2.6-flash`、`deepseek-v4.1-flash`、`longcat-2.5-preview`，
通常 1–9s 返回），2 个**上游间歇**（`nemotron-3.5-lightning` 约 150s 成功／约 220s 被上游
重置；`glm-5.3-flash` 时而 200 时而 429 `Endpoint is unavailable`），1 个**地区受限**
（`muse-spark-1.3-contributor`，本机永远 403，可直接禁用），1 个**只走 systemone**
（`jev-1.13`，对话协议会回 `ModelProtocolUnsupported`）。

> `ll-alpha` 曾在这 10 个里，2026-10-17 被上游退役（410），已移出。

## 2. 上游变更（2026-10-11）

Zen 路由被改成薄代理（上游提交 `83f2b6f67a`），门禁下沉到不可审计的私有 inference 服务。
`/zen/v1` 对匿名请求一律 403 `FreeTierError`；`/inference/v1` 提供同一目录并接受同一指纹。

### 通过门禁的请求形态（逐项实测隔离）

| 条件 | 结果 |
|---|---|
| 路径 `/inference/v1/chat/completions` | 必需 |
| `stream: true` | 必需；同一 body 改成 `false` 立即 403 |
| body 带 `tools`，且包含 `bash` 与 `read`（OpenAI `{type:"function",function:{...}}` 包装、小写精确名、带参数 schema） | 必需；缺失即 403 |
| 四个 session 头 `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` 同值 | 必需 |
| `x-opencode-project: global` | 必需（40 位 hex project id 会 403） |
| **不**发 `x-opencode-request` | 其存在本身触发 403 |
| **不**发 `HTTP-Referer` | 其存在本身触发 403 |
| session id 前 12 位 hex = 取反后的时间戳（`ses_` 降序），后接 14 位 base62 | 必需；随机或 sha256 派生即 403 |

隔离证据（仅改一个变量，其余相同）：

```
403  tools=yes stream=false   FreeTierError
200  tools=yes stream=true
403  tools=no  stream=true    FreeTierError
```

## 3. 逐模型结果

直连 `https://opencode.ai/inference/v1/chat/completions`，逐模型单次调用：

| 模型 | 结果 | 备注 |
|---|---|---|
| `big-pickle` | ✅ 200 | |
| `space-bunny`（上游 `space-bunny-free`） | ✅ 200 | |
| `nemotron-3.5-lightning`（…`-free`） | ⚠️ 时好时坏 | 快时 74s 出结果；慢时上游只发 `: keep-alive` 到约 300s 后空手关闭 |
| `nemotron-3.5-super-vl`（…`-free`） | ✅ 200 | |
| `mimo-v2.6-flash`（…`-free`） | ✅ 200 | |
| `deepseek-v4.1-flash`（…`-free`） | ✅ 200 | |
| `glm-5.3-flash`（…`-free`） | ⚠️ 时好时坏 | 两次 200（其中一次 150s），两次 429 `Endpoint is unavailable`，属上游自身不稳 |
| `longcat-2.5-preview`（…`-free`） | ✅ 200 | |
| `nemotron-3-ultra`（…`-free`） | ❌ 不可用 | HTTP 200 但正文只有 `: keep-alive`，约 300s 后无数据关闭；已禁用并标注原因 |
| `ll-alpha`（上游 `ll-alpha-free`） | ❌ 410 | `Model ll-alpha-free has been deprecated.`（2026-10-17 复测）；已退役并从默认清单移除 |
| `beam`（上游 `beam-free`） | ❌ 403 | `This model is not available in your country` |
| `muse-spark-1.2-contributor`（…`-free`） | ❌ 403 | 同上 |
| `muse-spark-1.3-contributor`（…`-free`） | ❌ 403 | 同上 |
| `jev-1.13`（上游 `jev-1.13-free`） | ❌ 400 | `Model does not support this protocol` |

上游目录端点 `/inference/v1/models` 当前返回 88 条，其中 `*-free` 12 条。
`nemotron-3-ultra-free` 不在目录里，但 chat 端点仍然服务它。

### 代理出口测试

经本机 Clash（`http://127.0.0.1:7890`）复测：`beam-free`、`muse-spark-1.3-contributor-free`
仍然 403，地区门不是单纯按出口 IP 判定；`glm-5.3-flash-free` 直连与代理都 200。

## 4. 本仓库需要的补丁

原样代码有两类问题：请求形态过时，以及错误映射失真。

| 文件 | 改动 |
|---|---|
| `src/config/env.ts` | `ZEN_PATH` 默认改为 `/inference/v1/chat/completions` |
| `src/utils/ids.ts` | 新增 `mintZenId()`，按网关规则铸造 `ses_`/`msg_` id |
| `src/providers/zenClient.ts` | 强制 `stream: true`；自动补齐 `bash`/`read` 占位工具；四个 session 头同值、去掉 `x-opencode-request`；UA 版本提到 `1.18.31`；新增 `assembleZenSse()` 把 SSE 折叠成单个 JSON；错误按上游真实状态码透传 |
| `src/routes/openai.ts` | 非流式客户端改走「上游流式 → 本地组装 JSON」 |
| `src/converters/anthropic.ts` | 错误映射保留真实状态码 |
| `src/converters/openAiThinkTagToReasoning.ts` | 同上 |
| `src/models/catalog.ts` | 默认免费模型同步为当前 9 个可用项；退役 `mimo-v2.5-free`、`ling-3.0-flash-fin-free` |
| `scripts/check-models.mjs` | 检查脚本改用新请求形态 |
| `README.md` | 同步模型表、地区说明与指纹门说明 |

### 已知取舍

- 为过门禁必须注入 `bash`/`read` 占位工具，模型可能返回对这两个工具的调用。
  占位工具的描述已明确标注「this gateway cannot execute it」。
- 非流式客户端由网关折叠 SSE，首字延迟等于整段生成时间。
- 免费层的慢模型需要把 `upstreamTimeoutMs` 提到 600000（默认 120000 会在 2 分钟处切断）。
- Node 的 `server.requestTimeout` 默认 300s，而它在**响应结束**时才清除（不是读完请求体时），
  所以默认值会把任何超过 5 分钟的出流静默切断。`src/app.ts` 现在把它设为
  `upstreamTimeoutMs + 60s`，让上游始终先超时。
- 上游返回空流（只有 `: keep-alive` 注释）时，非流式路径现在报 502
  `Upstream returned an empty stream`，不再把空完成当成功返回给调用方。

## 5. 本机部署信息

| 项 | 值 |
|---|---|
| 源码 | `C:\Users\Sails\Documents\Workspace\01-Active\OpenCodeProxyHub-src` |
| 监听 | `http://127.0.0.1:6446` |
| 控制台 | `http://127.0.0.1:6446/app` |
| 控制台密码 | 见本机 `.env` 的 `ADMIN_PASSWORD`（不入库） |
| 上游超时 | 600000 ms |
| 启动方式 | 计划任务 `OpenCodeProxyHub`（登录触发）→ `scripts\hub-service.vbs` → `hub-service.cmd` → `node dist/main.js` |
| 日志 | `logs\service.log`（网关输出与重启记录） |

API Key 明文保存在本机 `api-keys.json`（`STORE_PLAINTEXT_API_KEYS=true`），请勿外泄。

## 6. 端到端验证记录

经网关调用（非直连）：

```
health: ok, models: 11
OpenAI non-stream     200  content="OK"
OpenAI stream         200  chunks=11  content="OK"
OpenAI stream + tools 200  tool_call_deltas=11
Anthropic non-stream  200  content:[{type:"text",text:"OK"}]
Anthropic stream      200  events=6  message_stop ✓
地区受限模型          403  permission_error / RegionError（真实原因，不再被改写成 429）
未知模型              400
```

全量检查脚本 `node scripts/check-models.mjs`：**10/14 available**（含 1 个已退役但仍可服务的模型）。

## 7. 对外模型名去掉 `-free` 后缀

对外（`/v1/models`、请求体 `model`、响应回显）一律不带 `-free`；网关发上游请求时补回去，
所以上游流量与旧名字完全一致。

| 对外名 | 上游 id |
|---|---|
| `big-pickle` | `big-pickle`（**例外**：上游 id 本身无后缀） |
| `space-bunny` | `space-bunny-free` |
| `ll-alpha` | `ll-alpha-free`（已退役，保留此行仅为记录映射规则） |
| `nemotron-3.5-lightning` | `nemotron-3.5-lightning-free` |
| `nemotron-3.5-super-vl` | `nemotron-3.5-super-vl-free` |
| `mimo-v2.6-flash` | `mimo-v2.6-flash-free` |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-free` |
| `glm-5.3-flash` | `glm-5.3-flash-free` |
| `longcat-2.5-preview` | `longcat-2.5-preview-free` |
| `nemotron-3-ultra` | `nemotron-3-ultra-free` |
| `muse-spark-1.3-contributor` | `muse-spark-1.3-contributor-free` |

实现落在 `src/models/naming.ts`：`resolveUpstreamModel()` 负责补后缀，
`UPSTREAM_MODEL_EXCEPTIONS` 登记无法用规则推导的 id。已经带 `-free` 的名字原样透传，
所以把旧条目手工重新启用仍然可用。

### 映射证据

```
上游直连 model="space-bunny"       -> 400  Upstream request failed: Model is unavailable.
上游直连 model="space-bunny-free"  -> 403  FreeTierError（id 存在，指纹不对）
经网关 model="space-bunny"         -> 200  content="OK"
```

第三条能成功，说明网关确实把 `space-bunny` 补成了 `space-bunny-free`——
否则上游会像第一条那样直接报 id 不存在。

### 回显

- 非流式：`assembleZenSse()` 组装时把 `model` 写成对外名。
- 流式：`createModelRewriter()` 逐行把 `"model":"<上游名>"` 换成对外名。它用
  `StringDecoder` 解码并缓存半行，所以被 TCP 分片切断的多字节 UTF-8 字符不会被破坏。
- 实测：`ll-alpha` 流式 39 个 chunk，流内只出现 `ll-alpha`（该测量早于它被上游退役）；
  `mimo-v2.6-flash` 返回 `"中文测试"` 逐字完好。

> 已知例外：`reasoningTagModels` / `openAiStreamTransformModels` 里的转换器是逐字节
> 透传，不参与改名。默认这两个列表为空，不影响常规使用。

## 8. 开机自启

本机拿不到管理员权限（`LogonType S4U` 注册计划任务被拒：拒绝访问），所以用
**登录触发的计划任务 + 隐藏窗口启动器**实现，等价于“随电脑运行”：

```
计划任务 OpenCodeProxyHub (AtLogOn, Interactive, RunLevel Limited)
   └─ wscript.exe scripts\hub-service.vbs        没有控制台窗口
        └─ cmd /c scripts\hub-service.cmd        常驻循环
             └─ node dist\main.js                崩溃/退出后 15s 自动重启
```

`logs\service.log` 记录网关输出与每次重启。

### 自愈验证

```
kill node PID 11256  ->  15s 后 cmd 循环拉起新进程 PID 26992，端口 6446 恢复监听
```

要改成真正的 Windows 服务，需要在管理员 PowerShell 里用 S4U 主体重新注册（步骤见
`DEPLOYMENT.md` 的 Windows Auto-Start 一节）。

## 9. 三处部署（2026-10-17）

| 位置 | 监听 | 协议面 | 入口 |
|---|---|---|---|
| HK `154.219.110.138` | `127.0.0.1:6446` | all | `https://ocz.oxygenai.top`（OpenResty + CloudFlare） |
| WSL `Ubuntu-26.04` | `0.0.0.0:6447`（NAT 内，仍属本机） | openai | WSL 内 `127.0.0.1:6447`；Windows 侧见 `DEPLOYMENTS.md` 的中继说明 |
| Windows 本机 | `127.0.0.1:6446` | all | 仅本机（计划任务自启） |

### Jev 的地区差异（实测）

同一份请求，两个出口：

```
本机（中国大陆出口）   POST /inference/v1/systemone -> 451 Upstream request failed: Endpoint is unavailable.
HK  服务器（香港出口）  POST /inference/v1/systemone -> 200 {"model":"jev-1.13-free","answers":{"urgency":{"noul":0.98}},...}
```

经网关后（`POST /v1/systemone`）同样成立：本机 451，HK 200 且回显名已是 `jev-1.13`。
所以 Jev 只部署在 HK 那台；WSL 实例用 `API_SURFACE=openai` 干脆不挂这条路由。

HK 上的多问题实测（`urgency` / `team` / `frustration` 同请求并行）：

```json
{"model":"jev-1.13",
 "answers":{
   "urgency":{"type":"noul","noul":0.98},
   "team":{"type":"choice","choice":"technical","confidence":0.88,
           "probabilities":{"billing":0.08,"technical":0.92,"sales":0}},
   "frustration":{"type":"score","score":1.03,"confidence":0.95, ...}},
 "usage":{"input_tokens":434,"output_tokens":71}}
```

### 公网验证（经 CloudFlare + OpenResty）

```
GET  https://ocz.oxygenai.top/health             200  {"status":"ok","version":"0.2.0","surface":"all","models":10,...}
GET  https://ocz.oxygenai.top/v1/models          200  10 个模型（含 jev-1.13，不含 ll-alpha）
POST https://ocz.oxygenai.top/v1/chat/completions 200 model=space-bunny content=OK
POST https://ocz.oxygenai.top/v1/responses       200 status=completed text=OK
POST https://ocz.oxygenai.top/v1/systemone       200 urgency 0.99
POST https://ocz.oxygenai.top/v1/chat/completions (stream) 7 个 SSE chunk，模型名回显正确
POST https://ocz.oxygenai.top/v1/chat/completions model=ll-alpha  400 Unknown or disabled model
```

`free.ocz.oxygenai.top` 解析得到 CloudFlare IP，但在边缘 TLS 握手失败：CloudFlare 通用证书的
通配符只覆盖 `*.oxygenai.top` 一层，二级子域需要 Advanced Certificate。因此对外名用
`ocz.oxygenai.top`。

源站侧两个名字都已换成 **Let's Encrypt 证书**（ECDSA，SAN 含 `ocz.oxygenai.top` 与
`free.ocz.oxygenai.top`），实测链路完整：

```
echo | openssl s_client -connect 127.0.0.1:443 -servername ocz.oxygenai.top -showcerts
  0 s:CN = ocz.oxygenai.top
  1 s:C = US, O = Let's Encrypt, CN = YE1
  2 s:C = US, O = ISRG, CN = Root YE
  3 s:C = US, O = Internet Security Research Group, CN = ISRG Root X2

公网: https://ocz.oxygenai.top/health -> 200  curl tls_verify_result=0
```

`acme.sh` 已写入 root crontab 自动续期，install 钩子会 `openresty -s reload`。
这意味着 CloudFlare 即便切到 **Full (strict)** 也不会断。

若要让 `free.ocz.oxygenai.top` 也对外可用，只需在 CloudFlare 把该记录设为
**DNS only（灰云）**——源站证书已经覆盖这个名字，无需再申请证书。若要保持橙云，
则需要 Total TLS / Advanced Certificate / Cloudflare for SaaS，这三者都需要面板权限。

### Responses 端点验证

上游对 `/inference/v1/responses` 一律回 `ModelProtocolUnsupported`，所以该协议在网关内转换：

```
事件序列（big-pickle, stream）:
  response.created -> response.in_progress
  -> response.output_item.added(reasoning) -> response.reasoning_summary_text.delta ×N
  -> response.reasoning_summary_text.done -> response.output_item.done
  -> response.output_item.added(message) -> response.content_part.added
  -> response.output_text.delta -> response.output_text.done -> response.content_part.done
  -> response.output_item.done -> response.completed -> [DONE]

工具调用（deepseek-v4.1-flash + shell）:
  output 里出现 {"type":"function_call","call_id":"...","name":"shell","arguments":"{...}"}
```

## 2026-10-17 — 免费层 403 归因：出口信誉（实测）

当天下午上游门禁收紧（官方 issue `anomalyco/opencode#56324` 同时复现），
逐个用例直连探测，模型 `deepseek-v4.1-flash-free`，各一次、间隔 3 秒：

| 用例 | 形态 | 路径 | 结果 |
|---|---|---|---|
| local-v1016 | 2 工具 + 四 session 头 + `project: global` | `/inference/v1/chat/completions` | 403 |
| ref-majesticrise | 6 工具 + `x-opencode-request` + `prj_000…` | `/inference/openai/v1/chat/completions` | 403 |
| ref-on-v1 | 参考仓库形态 | `/inference/v1/chat/completions` | 403 |
| local-on-openai-v1 | 本仓库形态 | `/inference/openai/v1/chat/completions` | 403 |

同一分钟内经本机 Clash 出口复测：`local-v1016` 与 `ref-majesticrise` **均 200**，
真实 SSE、`reasoning_content` 正常。`/inference/v1/models` 在任何出口都 200，
说明服务本身没挂——差别只在出口 IP。

```
本机经 Clash 127.0.0.1:7890 → 179.254.94.249（200）
WSL 经其 Clash :7890        → 45.11.1.104   （200）
香港服务器直连               → 403 FreeTierError
```

### 网关端到端（修复后）

Windows 实例（`127.0.0.1:6446`）：

| 测试 | 结果 |
|---|---|
| `POST /v1/chat/completions` 流式 | 200，含 `[DONE]` |
| `POST /v1/responses` 流式 | 200，含 `response.completed` |
| 禁用主出口后再请求 | 200，自动经备用出口 |
| 出口节点计数 | 主 38 成功 / 4 失败；备 14 成功 / 0 失败 |

WSL 实例（`127.0.0.1:6447`）：`POST /v1/chat/completions` 200（内容 `ok`）。

香港实例：代码已更新、`/health` 正常；但其直连 IP 仍被门禁拒绝，且该机器没有
可用代理节点，免费层暂不可用（System One / 付费 Key 通道不受此影响）。

离线单测覆盖两项新原语（`_scratch/zen-probe-20261017/rotate-unit-test.mjs`）：
403 轮换（失败节点冷却 15 分钟、换节点、重铸 session、预算守卫生效）与传输层
重试（失败节点只冷却 60 秒、换节点、重铸 session），均通过。

### 官方指纹校准（2026-10-17，REA 静态提取）

对官方 v1.19.3 Linux x64 产物的 `.bun` 段做静态提取，证据在
`02-Research/OpenCode-REA-2026-10-17/06-free-tier-fingerprint.zh.md`：请求头构造
（偏移 `0x2ffb90`）、`Ji = opencode/${version}`（`0x2ff174`）、
`OPENCODE_CLIENT ?? "cli"`（`0xba4d42`）、id 铸造（`0xb33a4c`）、产物内置
Bun `1.3.14`。据此把网关指纹通道校准为官方形态，离线单测断言：

| 断言 | 结果 |
|---|---|
| UA 等于 `opencode/1.19.3 ai-sdk/provider-utils/4.0.45 runtime/bun/1.3.14` | PASS |
| `x-opencode-client: cli` | PASS |
| `x-opencode-project: global` | PASS |
| `x-opencode-session-id` 与 `x-opencode-session` 同值 | PASS |
| `x-opencode-request` 形如 `msg_` + 12 hex + 14 base62 | PASS |
| 默认不发送 `x-session-affinity` / `x-session-id`（官方只给非 OpenCode provider 发） | PASS |
| `ZEN_LEGACY_SESSION_HEADERS=1` 时两个别名头同值恢复 | PASS |
| 403 轮换后 session 头成对更新，`x-opencode-request` 保持不变 | PASS |

校准后三处部署复测：Windows 实例流式 `200`（含 `[DONE]`）、WSL 实例 `200`
（内容 `ok`）；香港实例健康正常但仍因出口 IP 被门禁拒绝。
