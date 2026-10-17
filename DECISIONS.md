# Decisions

短小的决策台账，防止后续 agent 重复提议已经否决过的方向。

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
