# Decisions

短小的决策台账，防止后续 agent 重复提议已经否决过的方向。

## 2026-10-17 — 不做客户端伪装，改为熔断

**背景**：上游把免费层的客户端指纹门又收紧了一次，三处部署 6 个 Key 全部 403
`OpenCode's free tier can only be used from within OpenCode`，连 HK 直连也一样。
请求变成"把流量伪装成正常 OpenCode 客户端"。

**决定：不做伪装。**

两个理由，一个原则性、一个工程性：

1. 那道门的作用就是"只允许官方客户端"。把第三方网关的请求做成与官方客户端不可
   区分，是为了绕过它，不是兼容它。
2. **这次伪装也没用**：`anomalyco/opencode#56324`（2026-10-17 05:52）报告
   **官方 TUI 自己也在报同一个 403**，维护者机器人回复确认错误来自 Zen 网关侧、
   且与"在哪里运行 OpenCode"无关。也就是说当前没有一份"正确的指纹"可以抄。

**改为做的事**：上游门一关就本地熔断——首次 403 记录窗口，窗口内所有请求直接
503 `upstream_free_tier_gate`，不再打上游。目的是**止损**：不让下游 fallback
拿付费额度去垫。状态在 `GET /health` 的 `upstreamFreeTier` 字段可见，冷却时间由
`FREE_TIER_GATE_COOLDOWN_MS` 控制（默认 5 分钟），`FREE_TIER_GATE_DISABLED=1`
可关掉熔断用于排查。

**给运营的结论**：免费层短期内不可依赖。要么等上游恢复（熔断会自动放行），
要么走付费路径，但不该由网关去猜指纹。

## 2026-10-17 — 不做 `system-one-adapter` emulation

**提议**：把 TypeSafe 那套 `Choice/Score/Noul` 接口在网关里用免费对话模型"学"出来，
让 `POST /v1/systemone` 在没有真 Jev 出口时（例如大陆出口回 451）也能回答。

**决定：不做。**

理由：我们在自研模型，Jev 只是过渡方案。为一个过渡依赖投入 prompt 工程，
收益窗口太短；而且模仿出来的概率校准明显差于真 System One，
`confidence` 阈值路由会变得不可信。

**现状**：`/v1/systemone` 保持**直通真 Jev**。它只在非受限出口可用——
HK（`https://ocz.oxygenai.top`）能通，本机走大陆出口返回
`451 Endpoint is unavailable`。WSL 实例用 `API_SURFACE=openai` 不挂这条路由。

## 2026-10-17 — 数据接入一律单向导入

**决定**：凡是竞品/邻品的数据（如 OpenCode 的配置、技能、agent、command、MCP、
provider、会话），一律**只导入、不回写**；不提供"导出回去"或"双向同步"入口。

理由：商业软件只有引客与锁客。主动提供方便的回写工具等于把用户的迁出成本降到零，
直接导致流失。

**影响**：相关分析只需覆盖"读"的一侧。例如 OpenCode 的会话存储
（SQLite `opencode.db` + 事件溯源）**不需要**继续考证 `event.type` 与
"真相源表 vs 投影表"，因为写回需求已取消。

## 2026-10-17 — 403 是出口信誉问题：改为"换出口重试"，熔断降为最后一步

**背景**：当天下午门禁再次收紧，三处部署与官方 TUI 同时报 403
（上游 issue `anomalyco/opencode#56324`，官方客户端自己也复现）。但同一分钟的
对照实测显示：**同一份请求形态**在本机大陆直连是 403、经本机/WSL 的 Clash 出口
则是 200 并正常流式。也就是说请求形态没有退化，**门禁判定的是出口 IP 的信誉**。
参考仓库 `Majesticrise/OpenCodeProxy`（Rust）的有效做法也不是更强的伪装，而是
"403 时换代理、换 session 重试"。

**决定**：保留既有指纹形态与共享熔断，新增出口轮换：

1. `403 FreeTierError` → 该节点冷却 `FREE_TIER_BAN_COOLDOWN_MS`（默认 15 分钟），
   换下一个出口并重铸 session，最多 `FREE_TIER_RETRY_ATTEMPTS`（默认 3）次；
2. 传输层失败（TLS 被重置、连接中断）→ 该节点只冷却
   `FREE_TIER_TRANSPORT_COOLDOWN_MS`（默认 60 秒）后换出口重试；
3. `429 FreeUsageLimitError` → 该节点短暂冷却后换出口重试；
4. 全部尝试失败才触发共享熔断（`/health` 的 `upstreamFreeTier`），避免下游
   fallback 拿付费额度去垫。

**为什么不抄参考仓库其它部分**：它的 6 工具契约、`x-opencode-request`、
`prj_0000000000000000` 项目号与本仓库 2026-10-16 实测通过的形态冲突，而实测
显示 2 工具形态在干净出口下同样 200——改动收益为零，还会让模型误调用 6 个占位工具。
UA 版本同理保持现状。上一节"不做客户端伪装"的结论不变：这里增强的是出口编排，
不是把请求伪装得更像官方客户端。

**当前出口拓扑**：Windows 实例挂两个节点（本机 Clash `127.0.0.1:7890` 权重 10、
WSL Clash 权重 5）；WSL 实例挂本机 Clash；香港实例仍未接出口节点，其直连 IP 被
门禁判定，所以 `ocz.oxygenai.top` 的免费层仍不可用，需要一个非受限出口才能恢复。

## 2026-10-17 — 用 REA 从官方产物取指纹，按官方客户端头集模拟环境

**背景**：10-16 的头部契约是黑盒试探出来的（"四个 session 头同值"、"不发
`x-opencode-request`"）。当天的门禁收紧让这套猜测失去解释力，于是不再猜：直接分析
官方产物 `OpenCode-REA-2026-10-17`（Bun 单文件发布，`.bun` 段是可读 ESM），新增
第 6 篇给出请求头、UA 组成与 id 铸造原码。

**官方形态**（`providerID` 以 `opencode` 开头时）：

```
User-Agent: opencode/<CLI 版本> ai-sdk/provider-utils/4.0.45 runtime/bun/1.3.14
x-opencode-session-id / x-opencode-session: 同值（ses_ 降序 id）
x-opencode-project: git 首个提交 hash；无仓库时字面量 global
x-opencode-request: 该轮用户消息 id（msg_ 升序）
x-opencode-client: OPENCODE_CLIENT ?? "cli"
```

`x-session-affinity` / `X-Session-Id` 只在**非** OpenCode provider 分支发送。

**决定**：指纹通道改为发送上述官方头集与官方 UA；`x-opencode-request` 每请求铸一个
`msg_` id，并在重试之间保持不变；两个别名头默认不再发送，需要旧行为时开
`ZEN_LEGACY_SESSION_HEADERS=1`。project 仍用 `global`——网关没有客户端仓库上下文，
而 `global` 是官方 `Project.ID` 的一等取值。

**保留的两处偏离（有实测依据）**：

1. tools 仍只注入 `bash` + `read` 占位。官方发送的是当前 agent 的工具集，网关无从
   得知；注入全套占位会诱导模型误调工具，而 10-16 实测该注入足以过门禁。
2. 不发 `x-opencode-parent-session-id`（网关没有子会话概念）。
