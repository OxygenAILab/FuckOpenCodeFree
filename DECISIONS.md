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
