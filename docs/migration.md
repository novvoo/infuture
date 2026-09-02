# future-os Rust → TypeScript 迁移映射

> 原则：**架构忠实、核心真实**。280k 行 Rust 不做逐行翻译；按模块语义重写为 TypeScript，保留目录结构、命名、状态机与协议契约。已存在的 TS 包（`packages/*`、`desktop`、`mobile`）直接沿用语义。

## 逐 crate 映射

| future-os（Rust crate） | 行数 | infuture（TS package） | 迁移说明 |
|---|---|---|---|
| `agent` | 70,914 | `@infuture/core` + `@infuture/types` + `@infuture/llm` | 核心：运行环/会话/运行时/沙箱/工具/技能/模型/认证 |
| `packages/rpc`（future.proto） | 6,485 | `@infuture/rpc` | protobuf → 有类型 JSON-RPC；保留事件载荷语义 |
| `channels`（feishu_ws.proto） | 14,196 | `@infuture/channels` | Feishu/DingTalk WS+REST+卡片+prompt loop |
| `orchestration/loop` | 33,466 | `@infuture/loop` | 控制平面：目标/todos/gates/monitors/租约 |
| `cli` | 32,434 | `@infuture/cli` | 统一入口 `infuture <cmd>` |
| `tui` | 36,363 | `@infuture/tui` | 终端 UI（用 readline 实现的精简版） |
| `packages/thread-projection` | (ts) | 沿用 | 会话线程投影 |
| `packages/markdown` | (ts) | 沿用 | Future Markdown 解析 |
| `packages/json-preview` | (ts) | 沿用 | JSON 预览 |
| `desktop`（Tauri+React） | (ts) | `apps/desktop` | 去掉 Tauri，纯 web + JSON-RPC；引入 mastery 设计 |
| `mobile` | (ts) | （本期不迁移） | 保留为未来工作 |

## 关键模块映射表

| future-os 模块 | TS 路径 | 关键契约（保持兼容） |
|---|---|---|
| `types::ContentBlock` | `packages/types/src/content.ts` | `{type:"text"|"image_url"|"reasoning"|"tool_call"|"tool_result", ...}` |
| `types::AgentMessage` | `packages/types/src/message.ts` | `role` + `content[]`；`to_llm()` 下降为 wire Message |
| `types::Message` | `packages/types/src/wire.ts` | OpenAI wire 格式（content/tool_calls/tool_call_id/reasoning_content） |
| `types::ToolDef/AgentTool` | `packages/types/src/tool.ts` | `{type:"function",function:{name,description,parameters}}` + handler |
| `types::Model/ModelCost` | `packages/types/src/model.ts` | id/name/provider/api/baseUrl/contextWindow/maxTokens/reasoning |
| `llm::schema::ModelRequest` | `packages/llm/src/schema.ts` | `{model,systemPrompt,messages,tools}` |
| `llm::schema::ModelStreamEvent` | `packages/llm/src/schema.ts` | delta/reasoning/tool_call/usage |
| `llm::adapters::*` | `packages/llm/src/adapters/` | openai-chat / openai-responses / anthropic |
| `runtime::run_state::RunControl` | `core/src/runtime/run-control.ts` | 阶段状态机 + 租约 + busy 策略 + 幂等 |
| `runtime::run_request::BusyPolicy` | `core/src/runtime/run-request.ts` | `enqueue_if_busy` / `supersede_session` |
| `session::Manager/Session` | `core/src/session/` | 会话管理 / fork / clone / tree / JSONL 持久化 |
| `sandbox::*` | `core/src/sandbox/` | 审批门 + 沙箱层级（off/manual/sandbox） |
| `tools::all_tools/coding_tools` | `core/src/tools/` + `coding/src` | 通用工具 + 编程工具合并注册 |
| `skills::discover_skills` | `core/src/skills/` | `~/.future/agent/skills/` 技能发现 |
| `models::Registry` | `core/src/models/` | 3800+ 模型目录 + 自定义 provider |
| `auth::AuthStore` | `core/src/config/` | `~/.future/agent/auth.json` |
| `rpc::ServerSession` | `rpc/src/` | JSON-RPC 会话端点 |
| `agent::Loop` / `RunEvent` | `core/src/agent/run-loop.ts` | 运行环 + 事件流 |

## 目录对照

```
future-os/agent/src/            →  infuture/packages/core/src + types + llm
future-os/channels/src/         →  infuture/packages/channels/src
future-os/packages/rpc/src/     →  infuture/packages/rpc/src
future-os/orchestration/loop/   →  infuture/packages/loop/src
future-os/cli/src/              →  infuture/packages/cli/src
future-os/tui/src/              →  infuture/packages/tui（并入 apps/tui）
future-os/desktop/src/          →  infuture/apps/desktop/src（去掉 Tauri 绑定）
```

## 迁移决策记录

1. **gRPC/protobuf → JSON-RPC**：桌面/CLI 走本进程或 stdio JSON-RPC，省去 Tonic/tonic-build；协议事件载荷（RunEvent、ApprovalRequest、Usage）字段名保持 snake_case 兼容。
2. **macOS Seatbelt / Windows 受限令牌**：TS 侧先提供策略描述与审批回调层；平台级强隔离作为 `SandboxTier=sandbox` 的降级实现（记录 `tier:"degraded"`），不静默假装已启用。
3. **并行/后台**：Rust async（tokio）→ Node 事件循环 + worker 线程（子 agent 用 `node:worker_threads` 或直接子进程）。
4. **不迁移**：`mobile`（React Native）本期不做；`desktop/src-tauri`（Rust Tauri 后端）被 JSON-RPC 网关替代。
