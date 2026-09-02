# infuture 架构图（graph）

本文是 infuture 的权威架构设计。所有图为 Mermaid 语法，可在任意 Mermaid 渲染器（VS Code 插件、mermaid.live、GitHub）中直接查看。

---

## 1. 模块依赖图（Monorepo）

```mermaid
graph TD
    subgraph apps["apps · 界面层"]
        CLI["@infuture/cli<br/>future agent / chat / channel / loop / skills / auth"]
        TUI["@infuture/tui<br/>终端聊天 UI（readline）"]
        DESKTOP["@infuture/desktop<br/>React + Vite workbench"]
    end

    subgraph core["packages · 核心"]
        TYPES["@infuture/types<br/>ContentBlock / AgentMessage / Message / ToolDef / Model"]
        LLM["@infuture/llm<br/>OpenAI Chat / Responses · Anthropic 适配器"]
        CORE["@infuture/core<br/>agent 运行环 · session · runtime · sandbox · tools · skills"]
        RPC["@infuture/rpc<br/>JSON-RPC 协议 + ServerSession"]
    end

    subgraph coding["packages · 编程能力"]
        CODING["@infuture/coding<br/>OmpAdapter · 编程工具注册 · 子 agent 调度"]
    end

    subgraph ext["packages · 扩展"]
        CHANNELS["@infuture/channels<br/>Feishu / DingTalk 桥接"]
        LOOP["@infuture/loop<br/>长运行控制平面（goals/todos/gates/monitors）"]
    end

    CLI --> RPC
    TUI --> RPC
    DESKTOP --> RPC
    RPC --> CORE
    CORE --> TYPES
    CORE --> LLM
    CORE --> CODING
    CODING -->|"依赖 + spawn"| OMP["@oh-my-pi/pi-coding-agent<br/>(npm ^16.4.6)"]
    CHANNELS --> CORE
    LOOP --> CORE
    LOOP --> TYPES
```

**依赖方向**：界面层只依赖 `rpc`，`rpc` 只依赖 `core`，`core` 依赖 `types` / `llm` / `coding`。`coding` 是唯一接触第三方 `@oh-my-pi/*` 的包——其余包对编程能力无感知。

---

## 2. Agent 运行环（Run Loop）数据流

移植自原版 Rust agent 的 `run_loop.rs`（4279 行）。核心不变式：**每轮 = 模型流式输出 → 若有工具调用 → 审批门 → 执行 → 回填 → 再请求**。

```mermaid
sequenceDiagram
    participant U as 用户/调用方
    participant S as SessionRuntime
    participant RC as RunControl(状态机)
    participant L as AgentLoop
    participant M as LLM 适配器
    participant T as 工具注册表
    participant P as ApprovalGate(审批门)
    participant O as @oh-my-pi coding

    U->>S: send(prompt, busyPolicy)
    S->>RC: begin(runId) → RunLease(epoch)
    RC-->>S: lease 或 "session busy"
    S->>L: run(lease, modelRequest)
    L->>M: stream_model(request)
    M-->>L: ModelStreamEvent* (delta/tool_call/usage)
    L->>L: 累积 assistant 消息（reasoning/text/tool_calls）
    alt 有 tool_calls
        loop 每个工具调用
            L->>P: requestApproval(toolName, args)
            alt 审批通过
                alt 工具名属于 coding_* / lsp_* / dap_*
                    L->>O: executeCodingTool(name, args)
                    O-->>L: ToolResult
                else 通用工具 read/write/edit/shell
                    L->>T: execute(name, args)
                    T-->>L: ToolResult
                end
            else 拒绝
                L-->>L: ToolResult(is_error=审批被拒)
            end
            L->>L: 回填 assistant + tool 消息
        end
        L->>M: stream_model(带工具结果)
    else 无工具调用
        L-->>S: RunEvent.Complete
    end
    S->>RC: finalize(lease)
    RC-->>S: 释放会话（is_streaming=false）
    S-->>U: 最终回复 + 用量
```

**运行环关键配置**（`AgentConfig` 的 TS 对应）：

| 配置 | 说明 |
|---|---|
| `maxTurns` | 最大工具轮数（默认 10） |
| `thinkingBudget` | 思考预算（reasoning tokens） |
| `maxRetries` | 单次请求最大重试 |
| `beforeToolCall` / `afterToolCall` | 钩子：拦截/改写/后处理工具调用 |
| `toolsExecutionMode` | `parallel` / `sequential` |

---

## 3. 会话生命周期状态机

移植自 `agent/src/runtime/run_state.rs` 的 `RunControl`。

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Starting: begin(runId)
    Starting --> Running: installCancellation(interrupt)
    Running --> Cancelling: cancel()
    Cancelling --> Finalizing: 任务退出
    Cancelling --> CancellationStuck: 超时未退出
    CancellationStuck --> Starting: 新 begin 自愈释放死租约
    Running --> Finalizing: 正常完成/出错
    Finalizing --> Idle: 提交持久化 + 释放
    Running --> PersistenceDegraded: 终止态提交失败（fail-closed）
```

要点：
- **busy 策略**：`enqueue_if_busy`（追加排队）/ `supersede_session`（打断当前 run）。
- **幂等**：同 `clientRequestId` 拒绝重复接受；`CancellationStuck` 的租约在下次 `begin` 时自愈释放。
- **阶段语义**：`is_streaming` 仅作旧客户端兼容投影，权威状态是此状态机。

---

## 4. 沙箱与审批门（Trust-First）

移植自 `agent/src/sandbox/mod.rs`（1624 行）+ `windows.rs`（Seatbelt/受限令牌）。

```mermaid
flowchart LR
    A[工具调用 read/write/edit/shell] --> B{SandboxTier}
    B -->|"off"| C[直接执行]
    B -->|"manual"| D{ApprovalGate}
    B -->|"sandbox"| E[规则检查<br/>Seatbelt macOS / 受限令牌 Windows]
    D -->|同意| F[执行]
    D -->|拒绝| G[ToolResult is_error]
    E -->|允许| D
    E -->|拒绝| G
```

TS 侧的沙箱层实现：
- `SandboxTier`：`off` / `manual` / `sandbox`，会话级可切换。
- `ApprovalGate`：工具执行前回调，桌面端弹出审批 UI、CLI 端进入 `/approve` 状态。
- 平台规则：macOS 用 `sandbox-exec`(seatbelt) 策略模板；Windows 用受限令牌（本实现先做策略描述层与回调层，平台降级为 `manual` 并记录）。

---

## 5. LLM 适配器图

移植自 `agent/src/llm/adapters/*`（openai_chat 1003 行 / openai_responses / anthropic）。

```mermaid
graph LR
    subgraph protocols["ApiProtocol"]
        P1["openai-completions"]
        P2["openai-responses"]
        P3["anthropic"]
    end
    P1 --> A1[OpenAiChatAdapter]
    P2 --> A2[OpenAiResponsesAdapter]
    P3 --> A3[AnthropicAdapter]
    A1 --> O[Provider 路由<br/>baseUrl + apiKey + headers]
    A2 --> O
    A3 --> O
    O --> R[(HTTP SSE 流)]
    R --> E[ModelStreamEvent<br/>delta / reasoning / tool_call / usage]
```

- `ModelRequest { model, systemPrompt, messages, tools }`，`stream_model` 返回异步事件流。
- `ProviderMetadata`：不透明命名空间协议状态（`openai` / `anthropic`），未知命名空间原样保留，保证多轮往返无损。
- 思考预算 `updateThinking(level, budget)` 运行时热更新。

---

## 6. 编程能力接入图

`@infuture/coding` 是 infuture 与 `@oh-my-pi/pi-coding-agent` 之间的唯一桥梁，模式取自 mastery 的 `omp-adapter.js`（spawn CLI）并扩展为**进程内 API 适配**。

```mermaid
flowchart TD
    CORE["@infuture/core · AgentLoop"] -->|executeCodingTool| AD[OmpAdapter]
    AD -->|resolve| PKG["node_modules/@oh-my-pi/pi-coding-agent<br/>(OMP_CLI_PATH 可覆盖)"]
    AD --> MODE1["进程模式：spawn 编程引擎 CLI<br/>stdio JSON-RPC"]
    AD --> MODE2["API 模式：import 核心包<br/>（能力缺失时降级）"]
    MODE1 --> TOOLS["编程工具命名空间"]
    TOOLS --> LSP["lsp_* · 14 操作<br/>符号重命名 / 引用追踪"]
    TOOLS --> DAP["dap_* · 28 操作<br/>lldb / dlv / debugpy"]
    TOOLS --> EXEC["execute_code<br/>内嵌 Python + Bun worker"]
    TOOLS --> AST["ast_edit<br/>hashline 锚定 + ast-grep"]
    TOOLS --> SUB["subagent · 隔离 worktree 并行任务"]
    TOOLS --> REV["review · 双模型 advisor 审查"]
    TOOLS --> GIT["git_* · 原子提交拆分 / PR 读取"]
```

能力合并清单（`docs/integration.md` 有完整表）：

| 维度 | 通用 agent 提供 | 编程 agent 提供 |
|---|---|---|
| 核心定位 | 通用 AI 操作系统/平台 | 终端编程专用 agent |
| LSP | — | 14 个 LSP 操作 |
| 调试器 | — | 28 个 DAP 操作 |
| 代码执行 | 仅 shell | 内嵌 Python + Bun worker |
| AST 编辑 | 文本级 edit | hashline 锚定 + ast-grep 结构化重写 |
| 子 agent | — | 一等子 agent，并行分发到隔离 worktree |
| 代码审查 | — | 双模型审查（advisor） |
| Git | — | 原子提交拆分、冲突解决、PR 读取 |
| 浏览器 | 有 | 有（更完善，支持 Electron 应用） |
| 文件操作 | read/write/edit/shell | 31 个内置工具（更丰富） |

---

## 7. 前端（desktop）组件图

设计语言来自参考 workbench，业务逻辑在 `apps/desktop/src`。

```mermaid
graph TB
    subgraph shell["Workbench 外壳（mastery 设计）"]
        RA["ActivityRail<br/>活动导航"]
        SB["SidebarPanel<br/>侧栏：会话树/项目树"]
        CW["ChatWorkspace<br/>对话工作区"]
        FW["FileWorkbench<br/>文件工作台"]
        IP["InspectorPanel<br/>检查器：运行详情/子 agent"]
        BT["BottomTerminalPanel<br/>底部终端"]
    end

    subgraph components["核心组件（mastery）"]
        ML["MessageLog + MarkdownMessageContent"]
        AC["AgentControl · AskUserFloatingCapsule"]
        TP["ToolPanel · CommandSuggestions"]
        LS["LLMSetupModal · SettingsMenu"]
        MG["ManagementPage · ModelManagement · McpManagement"]
    end

    subgraph features["业务功能"]
        F1["AgentThread / Composer / ApprovalPrompt"]
        F2["Artifacts / FileTree / FilePreview"]
        F3["Skills / Review / Runs / Settings"]
        F4["Remote / Markdown"]
    end

    shell --> components
    components --> features
    features --> RPC
```

布局规则（量化）：侧栏 280px、ActivityRail 56px、InspectorPanel 320px、底部终端 220px；主区为 ChatWorkspace/FileWorkbench 切换；主题采用 mastery 的暗色 + 强调色 token。

---

## 8. 部署/表面（Surfaces）总览

```mermaid
graph TD
    SUBJ["infuture 核心（@infuture/core + coding）"]
    SUBJ --> S1["CLI：infuture chat（一次问答）"]
    SUBJ --> S2["TUI：infuture tui（交互终端）"]
    SUBJ --> S3["Desktop：workbench 桌面应用"]
    SUBJ --> S4["IM：Feishu / DingTalk 机器人"]
    SUBJ --> S5["Loop：infuture loop（24h+ 长任务）"]
```

所有表面共享同一 session / memory / skills / 审批门——一处批准，处处生效。
