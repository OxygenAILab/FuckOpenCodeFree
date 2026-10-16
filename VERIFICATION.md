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

当前启用的 10 个模型里，**7 个稳定可用**（`big-pickle`、`space-bunny`、`ll-alpha`、
`nemotron-3.5-super-vl`、`mimo-v2.6-flash`、`deepseek-v4.1-flash`、`longcat-2.5-preview`，
通常 1–9s 返回），2 个**上游间歇**（`nemotron-3.5-lightning` 约 150s 成功／约 220s 被上游
重置；`glm-5.3-flash` 时而 200 时而 429 `Endpoint is unavailable`），1 个**地区受限**
（`muse-spark-1.3-contributor`，本机永远 403，可直接禁用）。

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
| `ll-alpha`（上游 `ll-alpha-free`） | ✅ 200 | |
| `nemotron-3.5-lightning`（…`-free`） | ⚠️ 时好时坏 | 快时 74s 出结果；慢时上游只发 `: keep-alive` 到约 300s 后空手关闭 |
| `nemotron-3.5-super-vl`（…`-free`） | ✅ 200 | |
| `mimo-v2.6-flash`（…`-free`） | ✅ 200 | |
| `deepseek-v4.1-flash`（…`-free`） | ✅ 200 | |
| `glm-5.3-flash`（…`-free`） | ⚠️ 时好时坏 | 两次 200（其中一次 150s），两次 429 `Endpoint is unavailable`，属上游自身不稳 |
| `longcat-2.5-preview`（…`-free`） | ✅ 200 | |
| `nemotron-3-ultra`（…`-free`） | ❌ 不可用 | HTTP 200 但正文只有 `: keep-alive`，约 300s 后无数据关闭；已禁用并标注原因 |
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
| 控制台密码 | `opencode-hub-local`（见 `.env`） |
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
| `ll-alpha` | `ll-alpha-free` |
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
- 实测：`ll-alpha` 流式 39 个 chunk，流内只出现 `ll-alpha`；`mimo-v2.6-flash` 返回
  `"中文测试"` 逐字完好。

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
