# infuture

> **One AI agent, everywhere you work — 通用任务 + 编程能力一体化。**

infuture 是一体化 agent：既能处理常规任务（会话 / 模型 / 技能 / IM 通道 / 长运行 loop），又具备完整编程能力（LSP / DAP / 代码执行 / AST 结构化编辑 / 子 agent / 双模型审查 / Git）。在统一运行时上原生融合通用任务与编程能力，非外挂式集成。

## 安装

```bash
npm install
```

## 快速开始

```bash
# 配置 API key（provider 可选 openai / anthropic 等）
npm run dev -- auth login openai sk-xxx

# 一次问答
npm run chat -- "你好，介绍一下你自己"

# 终端交互 UI
npm run tui

# 桌面 Workbench（一键拉起后端 + 前端）
npm run desktop
# → 后端 ws://127.0.0.1:50051 · 前端 http://127.0.0.1:5173

# 诊断环境（校验编程引擎 / 工具注册 / 沙箱）
npm run doctor
```

> 全局安装后也可直接使用 bin 命令 `infuture …`（见 `packages/cli/package.json`）。

## 命令一览

| 命令 | 说明 |
|---|---|
| `npm run chat -- "<prompt>"` | 一次问答 |
| `npm run tui` | 终端交互 UI |
| `npm run agent` | 启动 agent（stdio JSON-RPC 服务） |
| `npm run desktop` | 桌面 Workbench（一键拉起前后端） |
| `npm run dev -- channel` | 启动 Feishu/DingTalk 桥接（见下） |
| `npm run dev -- auth login <provider> <key>` | 写入 API key |
| `npm run dev -- models` | 列出模型 |
| `npm run dev -- skills list` | 列出技能 |
| `npm run dev -- doctor` | 诊断环境 |
| `npm run dev -- loop …` | 长运行控制平面（见下） |
| `npm run dev -- help` | 查看 CLI 帮助 |

**IM 通道（channel）**：通过环境变量配置后启动桥接 —— `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（飞书，`FEISHU_WS=1` 走长连接）、`DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET`（钉钉）。

## 配置 loop 命令

loop 是长运行的多 worker 并行探索控制平面。**无需单独配置**：复用 `auth login` 写入的 API key 与模型，事件源持久化在 `~/.future/agent/loop/events.jsonl`。

**1. 前置：配置 API key（一次性）**

```bash
npm run dev -- auth login openai sk-xxx
```

**2. 审批模式**（影响 worker 调用工具时的放行策略）：

| 模式 | 说明 |
|---|---|
| 默认（`timeout`） | 工具审批超时自动拒绝 |
| `--approve` | 自动批准工具调用 |
| `--strict` | 一律拒绝（只读推进） |

**3. 典型流程示例**：

```bash
# 并行探索：4 个 worker、worktree 隔离、自动批准工具
npm run dev -- loop start "调研 RAG 检索方案选型" --workers 4 --isolate --approve

# 查看状态 / 运行历史 / 可推进前沿 / worker 列表
npm run dev -- loop status
npm run dev -- loop runs
npm run dev -- loop frontier
npm run dev -- loop list

# 给 worker 追加指引 / 停止
npm run dev -- loop steer <workerId> "重点对比向量数据库的运维成本"
npm run dev -- loop stop <workerId>

# 清理目标全部状态（含 worker 会话 / 隔离目录）
npm run dev -- loop delete --all
```

**4. 常用子命令**：

| 命令 | 说明 |
|---|---|
| `loop start "<目标>" [--workers N] [--isolate] [--approve\|--strict]` | 启动 N 个并行探索 worker |
| `loop list` / `loop stop <workerId>` / `loop steer <workerId\|--all goalId> "<指令>"` | worker 管理 |
| `loop status [--goal G]` | 目标状态总览 |
| `loop runs [--goal G]` | 运行历史 |
| `loop frontier [--goal G]` | 可推进前沿 |
| `loop task-graph <goalId>` | 任务依赖图 |
| `loop replan <goalId>` | 依赖一致性重规划 |
| `loop lease <claim\|renew\|release\|status> <goalId>` | 目标租约管理 |
| `loop backup [--dir DIR]` | 备份事件源 |
| `loop delete <goalId\|--all>` | 清理目标状态（含 worker 会话 / 隔离目录） |
| `loop "<目标>" [--approve\|--strict]` | 单 goal 串行推进 |

**5. 环境变量**：后端端口 `INFUTURE_PORT`（默认 `50051`）。

## 桌面 Workbench

- 一键启动：`npm run desktop`（自动拉起后端 ws server 与前端 vite，任一进程退出即整体清理）
- 或分两个终端：
  ```bash
  npm run desktop:server   # 后端 ws://127.0.0.1:50051
  npm run desktop:dev      # 前端 http://127.0.0.1:5173
  ```

## 发布产物

**1. 构建前端产物**（输出到 `apps/desktop/dist/`）：

```bash
npm run desktop:build
```

**2. 本地运行产物**：后端检测到 dist 后在同一端口托管页面与 ws，无需额外静态服务器：

```bash
npm run desktop:server      # 打开 http://127.0.0.1:50051 即完整 Web 应用
```

**3. Docker 部署**（镜像内置国内 npm 镜像源，多层构建）：

```bash
npm run docker:build        # 等价 docker build -t infuture .
npm run docker:run          # 等价 docker run --rm -p 50051:50051 infuture
```

- 打开 `http://localhost:50051` 使用
- 远程/公网部署时覆盖前端连接的 ws 地址：
  ```bash
  docker build --build-arg VITE_WS_URL=wss://<你的域名>:50051 -t infuture .
  ```
- 依赖镜像源默认 `registry.npmmirror.com`，可 `--build-arg NPM_REGISTRY=<镜像>` 覆盖
- 说明：容器内默认不启用编程工具（bun coding 服务懒启动），如需 LSP/DAP/代码执行请在镜像内安装 bun

## 能力矩阵

| 能力 | 说明 |
|---|---|
| 会话/记忆/模型目录/技能 | infuture 原生 |
| 审批门控工具 read/write/edit/shell | infuture（三态审批） |
| IM 通道（Feishu/DingTalk 桥接） | infuture |
| 长运行 loop 控制平面 | infuture（`loop` 多 worker 并行探索） |
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
npm test                          # 核心状态机/消息/工具/loop 测试
npm run desktop:build             # 前端构建
```
