# 编程能力 + 前端设计集成设计

## 1. 依赖引入

```jsonc
// infuture 根 package.json（workspace catalog 示意）
{
  "name": "infuture",
  "workspaces": ["packages/*", "apps/*"],
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "^16.4.6"   // 满足 mastery 声明的版本
  }
}
```

- **版本选择**：mastery 依赖 `^16.4.6`，本地实测安装到 16.4.8；npm 源最新 18.x，但**保持与 mastery 一致的 16.4.x 语义**，避免 breaking API。
- **仅 `@infuture/coding` 可见**：核心包不得直接 `import` `@oh-my-pi/*`，通过 `coding` 包的 `OmpAdapter` 间接调用，保证可替换性（未来可换 `OMP_CLI_PATH` 指向外部 omp CLI）。

## 2. OmpAdapter 设计

移植自参考实现桌面适配器，基于编程引擎真实 `--mode rpc` 协议（已实测）：

> `bun <cli> --mode rpc` → stdout 输出 `{type:'ready'}` 握手；
> 命令 `{id, type, ...}`（`get_state` / `prompt` / `follow_up` / `steer` / `bash` / `abort` / `new_session` / `get_available_models` …）→
> 响应 `{id, type:'response', command, success, data|error}`；agent 运行期流式输出
> `agent_start` / `message_update` / `message_end` / `agent_end` 事件。

```ts
class OmpAdapter {
  // 1) 解析 @oh-my-pi/pi-coding-agent 位置
  //    - options.cliPath / env OMP_CLI_PATH 优先
  //    - 其次从本包位置向上搜 node_modules，其次从 cwd 向上搜
  // 2) spawn(bun, [cliPath, '--mode', 'rpc'])，等 ready 握手（幂等）
  // 3) runTask(input, {mode:'prompt'|'steer'|'follow_up'}):
  //     委派一个编码子任务 → 等 response（agentInvoked 校验）→ 等 agent_end → 汇总最终答案
  // 4) runBash(command): 直接走 `bash` RPC 命令（无 agent 轮，快速执行）
  // 5) abort() / getState() / availableModels() / verify()（真实握手，doctor 用）
  dispose(): void
}
```

> ⚠️ 重要更正（v2）：早期版本按 `--json-rpc --stdio` + `tools/call`（MCP 客户端协议）设计，
> 实测编程引擎 CLI 不支持该参数，48 个编程工具全部不可用。已重写为上方 `--mode rpc` 协议，
> `tools/call` 只是编程引擎作为 **MCP 客户端**调用外部 server 的协议，不是其服务端接口。

### 工具命名空间（注册进 agent 工具注册表）

| 命名空间 | 前缀 | 操作数 | 执行方式 |
|---|---|---|---|
| LSP | `lsp_` | 14 | 委派 `runTask`（内置 lsp 工具） |
| DAP | `dap_` | 28 | 委派 `runTask`（内置 debug 工具，lldb/dlv/debugpy） |
| 代码执行 | `execute_code` | — | 直连 `runBash`（python/js/ts/bash，base64 转义） |
| Shell | `bash` | — | 直连 `runBash`（持久 shell） |
| 结构化编辑 | `ast_edit` / `ast_grep` | — | 委派 `runTask`（ast-grep） |
| 子 agent | `subagent` | — | infuture 递归 inloop（一等子 agent） |
| 审查 | `review` | — | infuture 自实现（双模型 advisor） |
| Git | `git_pr` | — | 委派 `runTask`（内置 github op=repo_view） |
| 文件检索 | `grep` / `glob` | — | 直调内置 GrepTool / GlobTool |
| 浏览器 | `browser` | — | 直调内置 BrowserTool（Puppeteer） |
| 网络搜索 | `web_search` | — | 直调内置 WebSearchTool（需搜索 provider 凭据，15s 超时） |
| 图片理解 | `inspect_image` | — | 直调内置 InspectImageTool（需视觉模型） |
| 冲突感知编辑 | `code_edit` | — | 直调内置 EditTool（replace 模式，内置 git 冲突检测/记忆） |
| GitHub 远程 | `github_*` | 8 | 直调内置 github（pr_create/checkout/push + 5 搜索） |
| 通用 | `read/write/edit/shell/web_fetch` | 6 | infuture（审批门控）；web_fetch 配套 web_search 抓取网页正文 |

> 委派式（`runTask`）需要编程会话配置模型 key（与主 LLM 同源）；`execute_code`/`bash` 直连无需模型。
> 通用工具走审批门；编程工具默认也过审批门（可配置 `codingToolsApproval`：`on` 需审批 / `auto` 自动审批 / `off` 完全执行）。

## 3. 能力合并表（最终形态）

| 能力 | 通用 agent | 编程 agent | infuture 融合结果 |
|---|---|---|---|
| 核心定位 | 通用 AI 操作系统/平台 | 终端编程专用 agent | **通用 + 编程一体** |
| LSP 集成 | ❌ | ✅ 14 操作（符号重命名、引用追踪） | ✅ |
| 调试器 | ❌ | ✅ 28 DAP 操作（lldb、dlv、debugpy） | ✅ |
| 代码执行 | 仅 shell | ✅ 内嵌 Python + Bun worker | ✅ |
| AST 编辑 | 文本级 edit | ✅ hashline 锚定 + ast-grep | ✅（两种都保留） |
| 子 agent | ❌ | ✅ 一等子 agent，隔离 worktree 并行 | ✅ |
| 代码审查 | ❌ | ✅ 双模型审查（advisor） | ✅ |
| Git 集成 | ❌ | ✅ 原子提交拆分、冲突解决、PR 读取 | ✅ |
| 浏览器 | ✅ | ✅（更完善，支持 Electron 应用） | ✅ |
| 文件操作 | ✅ read/write/edit/shell | ✅ 31 个内置工具 | ✅（合并，去重） |
| 会话/记忆 | ✅ | — | ✅ |
| IM 通道 | ✅ Feishu/DingTalk | — | ✅ |
| 长运行 loop | ✅ 24h+ 控制平面 | — | ✅ |
| 模型目录 | ✅ 3800+ 模型 | — | ✅ |

## 4. mastery 前端设计引入

### 设计来源
`mastery/desktop/renderer/`：workbench 式 agent IDE。

### 引入组件清单（到 `apps/desktop/src`）

| 来源（mastery） | 组件 | 在 infuture 的作用 |
|---|---|---|
| components/workbench | `ActivityRail` `ChatWorkspace` `FileWorkbench` `InspectorPanel` `InteractionConsole` `ProjectTree` `RuntimeSelector` `SidebarPanel` | workbench 外壳 |
| components/workbench/controls | 工作台控件 | 会话/运行控制 |
| components/chrome | `ActionFeedback` `CapabilityStatusBar` `ChromeCapsules` `UIErrorBoundary` | 全局 chrome |
| components/message-log | `MessageLog` `MarkdownMessageContent` `RuntimeDetailsPanel` `SubagentStatusPanel` | 对话区 + 运行详情 |
| components/management | `ManagementPage` `ModelManagement` `McpManagement` | 模型/能力管理 |
| components/ui | `Badge Button ConfirmDialog ContextMenu EmptyState Icon Input InputDialog Panel Switch Tab` | UI 组件库 |
| app/layout | `layout-state.js` | 布局状态 |
| app/interaction | `interaction-model.js` `animation-system.js` | 交互模型 |
| app/capabilities | `capability-graph.js` | 能力图 |
| app/actions | `ui-action-graph.js` | UI 动作图 |

### 布局量化
- ActivityRail：56px（左侧图标导航）
- SidebarPanel：280px（会话树 / 项目树）
- InspectorPanel：320px（运行详情、子 agent 状态）
- BottomTerminalPanel：220px（底部终端）
- 主区：ChatWorkspace ↔ FileWorkbench 切换
- 主题：mastery 暗色 token + 强调色；未来 `SettingsMenu` 提供亮色

### 适配原则
- **设计与逻辑统一在 infuture**：UI 结构/组件/交互来自 mastery；数据流、状态、事件来自 `useAgentThreadState` / `agentClient` / `threadRunProjection` 等 hooks。
- 去掉 mastery 的 Electron IPC 与 `ipc-adapter`，替换为 infuture `rpc` 客户端（本地 JSON-RPC）。
- 审批弹窗（`ApprovalPrompt`）保留审批语义，但视觉套用 mastery `ConfirmDialog` / `ToolPanel`。

## 5. 验收检查点

- [ ] `npm install` 后 `node_modules/@oh-my-pi/pi-coding-agent` 版本 ≥16.4.6
- [ ] `infuture` 单一 agent 同时暴露 `read/write/edit/shell` 与 `lsp_*`/`dap_*`/`execute_code` 工具
- [ ] `OmpAdapter` 能 resolve 到本地 pi-coding-agent（OMP_CLI_PATH 可覆盖）
- [ ] 桌面 workbench 加载统一布局与数据流，`vite build` 通过
- [ ] 全部包 `tsc --noEmit` 通过
