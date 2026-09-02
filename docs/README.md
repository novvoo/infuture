# infuture · 设计文档

> 项目代号 `infuture`：通用任务 + 编程能力一体化的统一 agent。

## 文档索引

| 文档 | 内容 |
|---|---|
| [graph.md](./graph.md) | 架构图总览：模块依赖图、数据流、会话生命周期、审批流、编程能力接入 |
| [migration.md](./migration.md) | Rust → TypeScript 迁移映射（模块对模块、逐 crate） |
| [integration.md](./integration.md) | 编程能力 + 前端设计的集成设计 |

## 一句话架构

```
            ┌─────────────────────────────────────────────┐
            │              infuture（统一入口）              │
            │   CLI / TUI / Desktop / IM 通道 (Feishu/Ding) │
            └──────────────────┬──────────────────────────┘
                               │ JSON-RPC over stdio / WebSocket
            ┌──────────────────▼──────────────────────────┐
            │              @infuture/core                  │
            │  agent 运行环 · 会话 · 沙箱审批 · 工具注册表   │
            │        ┌──────────────┐  ┌──────────────┐   │
            │        │ 通用工具 (FS) │  │ 编程工具 │   │
            │        └──────┬───────┘  └──────┬───────┘   │
            └───────────────┼─────────────────┼───────────┘
                            │                 │
                    LLM 适配器 (OpenAI/Anthropic)   @oh-my-pi/pi-coding-agent
```

三个来源的职责划分：

- **通用操作系统层**：会话/记忆、模型目录、LLM 适配、审批门控的通用工具（read/write/edit/shell）、IM 通道、长运行 loop 控制平面、多端界面。→ 实现为 `@infuture/*` TypeScript 包。
- **oh-my-pi（编程 agent）**：LSP（14 操作）、DAP（28 操作）、内嵌 Python/Bun worker 代码执行、hashline+ast-grep 结构化编辑、一等子 agent、双模型审查、Git 原子提交。→ 由 `@infuture/coding` 通过 `@oh-my-pi/pi-coding-agent` 接入。
- **mastery（前端设计）**：workbench 式桌面布局（ActivityRail / ChatWorkspace / FileWorkbench / InspectorPanel / ToolPanel 等）与 UI 组件体系。→ 引入到 `apps/desktop`。
