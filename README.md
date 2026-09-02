# infuture

> **One AI agent, everywhere you work — 通用任务 + 编程能力一体化。**

infuture 是一体化 agent：既能处理常规任务（会话 / 模型 / 技能 / IM 通道 / 长运行 loop），又具备完整编程能力（LSP / DAP / 代码执行 / AST 结构化编辑 / 子 agent / 双模型审查 / Git）。在统一运行时上原生融合通用任务与编程能力，非外挂式集成。

## 架构一览

```
apps/
  cli(入口) ──> packages/rpc ──> packages/core ──> packages/llm · packages/coding
  tui ────────────┘                │
  desktop ─────────────────────────┘──> packages/channels (Feishu/DingTalk) · packages/loop (长运行)
```

完整架构图见 [`docs/graph.md`](docs/graph.md)，迁移与集成说明见 [`docs/migration.md`](docs/migration.md)、[`docs/integration.md`](docs/integration.md)。

## 快速开始

```bash
npm install          # 安装依赖

# 一次问答（需先配置 API key）
npx tsx packages/cli/src/index.ts auth login openai sk-xxx
npx tsx packages/cli/src/index.ts chat "你好，介绍一下你自己"

# 终端交互 UI
npx tsx packages/cli/src/index.ts tui

# 诊断环境（校验编程引擎 / 工具注册 / 沙箱）
npx tsx packages/cli/src/index.ts doctor

# agent 服务（stdio JSON-RPC）
echo '{"jsonrpc":"2.0","id":1,"method":"doctor","params":{}}' | npx tsx packages/cli/src/index.ts agent

# 桌面 workbench（两个终端）
npm run server --workspace @infuture/desktop   # 终端1：后端 ws://127.0.0.1:50051
npm run dev --workspace @infuture/desktop      # 终端2：前端 http://127.0.0.1:5173
```

## 能力矩阵

| 能力 | 说明 |
|---|---|
| 会话/记忆/模型目录/技能 | infuture 原生 |
| 审批门控工具 read/write/edit/shell | infuture（三态审批） |
| IM 通道（Feishu/DingTalk 桥接） | infuture |
| 长运行 loop 控制平面 | infuture（`/future-loop` 多 worker 并行探索） |
| 14 LSP 操作（`lsp_*`） | infuture（inloop 直调编程引擎） |
| 28 DAP 操作（`dap_*`，lldb/dlv/debugpy） | infuture |
| `execute_code`（Python/Bun worker） | infuture |
| `ast_edit` / `ast_grep`（hashline + ast-grep） | infuture |
| `subagent` / `review` / `git_pr` | infuture |
| 浏览器 / 网络搜索 / 图片理解 | infuture（web_search 多 provider + web_fetch） |
| Workbench 桌面 UI | infuture（浮动窗口 / 一致性配置设计） |

## 验证

```bash
npm run typecheck                 # 全仓 tsc --noEmit
npx tsx --test packages/core/tests/smoke.test.ts   # 核心状态机/消息/工具/loop 测试
npm run build --workspace @infuture/desktop         # 前端构建
```
