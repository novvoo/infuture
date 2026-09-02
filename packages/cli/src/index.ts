/**
 * CLI — infuture 统一入口。对应 CLI。
 *
 * 用法：
 *   infuture chat "<prompt>"         一次问答
 *   infuture agent                   启动 agent（stdio JSON-RPC 服务）
 *   infuture tui                     终端交互 UI
 *   infuture channel                 启动 Feishu/DingTalk 桥接
 *   infuture loop "<goal>"           长运行控制平面驱动
 *   infuture auth login <provider> <key>   写入 API key
 *   infuture models                  列出模型
 *   infuture skills list             列出技能
 *   infuture doctor                  诊断环境
 */
import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { Engine } from '@infuture/core';
import { ServerSession } from '@infuture/rpc';
import { FeishuBridge, loadChannelConfig } from '@infuture/channels';
import { LoopControl, LoopPlanner, LoopStore, WorkerRuntime } from '@infuture/loop';
import { discoverSkills } from '@infuture/core';
import { startTui } from '@infuture/tui';

async function buildEngine(): Promise<Engine> {
  const engine = new Engine({});
  await engine.init();
  return engine;
}

async function cmdChat(prompt: string, rest: string[]): Promise<void> {
  const engine = await buildEngine();
  const session = await engine.sessions.create('CLI session');
  // 可追加多段文本
  const text = rest.length > 0 ? [prompt, ...rest].join(' ') : prompt;
  const outcome = await engine.run(session, text, { onEvent: (ev) => {
    if (ev.type === 'approval_requested') {
      // CLI 默认手动审批：stdin 询问
      void (async () => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`\n[审批] 允许执行 ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 200)}? (y/N) `, (ans) => {
          engine.approval.resolveApproval(ev.requestId, ans.trim().toLowerCase() === 'y');
          rl.close();
        });
      })();
    }
  } });
  if (outcome.error) {
    console.error(`[error] ${outcome.error}`);
    process.exitCode = 1;
  } else {
    console.log(`\n${outcome.reply}`);
    if (outcome.cancelled) console.log('\n[run cancelled]');
  }
  engine.dispose();
}

async function cmdAgent(): Promise<void> {
  const engine = await buildEngine();
  const server = new ServerSession(engine);
  engine.approval.onPending = (approval) => {
    // agent 服务模式下审批默认挂起，等待客户端 resolve
    console.error(`[approval pending] ${approval.toolName}`);
  };
  server.setNotificationHandler((n) => {
    process.stdout.write(JSON.stringify(n) + '\n');
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const req = JSON.parse(line);
      const resp = await server.handle(req);
      if (resp && 'id' in resp) process.stdout.write(JSON.stringify(resp) + '\n');
    } catch {
      // 忽略非 JSON 行
    }
  });
  console.error('[infuture agent] stdio JSON-RPC ready');
  process.stdin.resume();
}

async function cmdChannel(): Promise<void> {
  const engine = await buildEngine();
  const config = loadChannelConfig();
  if (config.feishu?.appId) {
    const bridge = new FeishuBridge({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      engine,
      useWebSocket: config.feishu.useWebSocket,
    });
    await bridge.start();
    console.error('[channel] feishu bridge started');
  } else {
    console.error('[channel] 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  process.stdin.resume();
}

async function cmdLoop(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  // engine 惰性构建：仅 start/list/stop/steer/单 goal 等需要运行时才启动；
  // status/replan/lease/task-graph/frontier/backup/runs 等只读控制命令秒回。
  let engine: Engine | null = null;
  const getEngine = async (): Promise<Engine> => {
    if (!engine) engine = await buildEngine();
    return engine;
  };
  const loopFile = path.join(process.env.HOME ?? '.', '.future', 'agent', 'loop', 'events.jsonl');
  const store = new LoopStore(loopFile);
  await store.restore();

  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const approvalMode = flags.has('--approve') ? 'auto' : flags.has('--strict') ? 'deny' : 'timeout';
  const numFlag = (name: string, dflt: number): number => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? Number(rest[i + 1]) || dflt : dflt;
  };
  const strFlag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a) => !a.startsWith('--'));

  switch (sub) {
    case 'start': {
      const engine = await getEngine();
      const goalText = positional.join(' ');
      if (!goalText) {
        console.error('用法: infuture loop start "<目标>" [--workers N] [--isolate] [--approve|--strict]');
        engine?.dispose();
        process.exitCode = 1;
        return;
      }
      const n = Math.max(1, numFlag('--workers', 3));
      const planner = new LoopPlanner({ engine, store, approvalMode });
      const goal = planner.createGoal(goalText.slice(0, 60), goalText, ['目标完成且有证据']);
      planner.addTodo(goal.id, goalText);
      planner.addGate(goal.id, 'evidence', '至少有 1 条工具执行证据', 1);
      const runtime = new WorkerRuntime({ engine, store });
      // 拆成 N 个并行探索 worker
      const tasks = Array.from({ length: n }, (_, i) => ({
        title: `探索 ${i + 1}/${n}`,
        prompt: `${goalText}\n\n你是 goal 下的并行探索 worker ${i + 1}/${n}。请独立探索这个目标（可从可行性、风险、实现路径、证据等角度分别切入），用工具收集证据，最后简明汇报你的发现。不要等待其他 worker。`,
      }));
      const workers = await runtime.spawn(goal.id, tasks, { isolate: flags.has('--isolate') });
      await store.persist();
      console.log(`[loop] goal=${goal.id} spawned ${workers.length} worker(s)`);
      for (const w of workers) console.log(`  worker ${w.id}  cwd=${w.cwd}`);
      break;
    }
    case 'list': {
      const ws = store.workersFor(positional[0] || undefined);
      if (ws.length === 0) console.log('(no workers)');
      for (const w of ws) {
        console.log(`${w.status.padEnd(8)} ${w.id}  ${w.title}  session=${w.sessionId}`);
        if (w.cwd) console.log(`           cwd=${w.cwd}`);
        if (w.lastSteer) console.log(`           steer@${new Date(w.lastSteer.at).toLocaleTimeString()}: ${w.lastSteer.instruction}`);
        if (w.error) console.log(`           error=${w.error}`);
      }
      break;
    }
    case 'stop': {
      const wid = positional[0];
      if (!wid) {
        console.error('用法: infuture loop stop <workerId>');
        process.exitCode = 1;
        return;
      }
      const engine = await getEngine();
      const runtime = new WorkerRuntime({ engine, store });
      const w = await runtime.stop(wid);
      await store.persist();
      console.log(w ? `[loop] stopped worker ${wid} (${w.status})` : `[loop] worker ${wid} not found`);
      break;
    }
    case 'steer': {
      const wid = positional[0];
      const instruction = positional.slice(1).join(' ');
      if (!wid || !instruction) {
        console.error('用法: infuture loop steer <workerId|--all goalId> "<指令>"');
        process.exitCode = 1;
        return;
      }
      const engine = await getEngine();
      const runtime = new WorkerRuntime({ engine, store });
      if (flags.has('--all')) {
        const n = await runtime.steerAll(wid, instruction);
        console.log(`[loop] steered ${n} worker(s) of goal ${wid}`);
      } else {
        const w = await runtime.steer(wid, instruction);
        console.log(w ? `[loop] steered worker ${wid}` : `[loop] worker ${wid} not found`);
      }
      await store.persist();
      break;
    }
    // ── 吸收 future-loop 控制平面子命令：delete/status/replan/lease/task-graph/frontier/backup/runs ──
    case 'delete': {
      // 清理目标状态：停止运行中的 worker → 删除 worker 会话与隔离工作目录 → 移除 goal 全部状态/事件
      const target = positional[0];
      const ctl = new LoopControl(store);
      if (target === '--all' || flags.has('--all')) {
        const engine = await getEngine();
        const goals = ctl.status();
        for (const g of goals) {
          await cleanGoalResources(engine, store, g.goalId);
          await ctl.removeGoal(g.goalId);
        }
        await store.persist();
        console.log(`[loop] deleted ${goals.length} goal(s)，目标状态已全部清理`);
        break;
      }
      if (!target) {
        console.error('用法: infuture loop delete <goalId> | infuture loop delete --all');
        process.exitCode = 1;
        break;
      }
      const engine = await getEngine();
      await cleanGoalResources(engine, store, target);
      const r = await ctl.removeGoal(target);
      await store.persist();
      console.log(`[loop] deleted goal ${target}「${r.goalTitle}」：${r.removedEvents} 条事件已清除`);
      break;
    }
    case 'status': {
      const ctl = new LoopControl(store);
      const reports = ctl.status(strFlag('--goal') ?? undefined);
      if (reports.length === 0) {
        console.log('(no goals)');
        break;
      }
      for (const r of reports) {
        console.log(`${r.status.padEnd(9)} ${r.goalId}  ${r.title}`);
        console.log(`  objective: ${r.objective.slice(0, 80)}`);
        console.log(
          `  progress: ${r.progress}%  todos=${r.todos.done}/${r.todos.total} (blocked=${r.todos.blocked})  gates=${r.gates.passed}/${r.gates.total}  workers=${r.workers.total} (running=${r.workers.running})`,
        );
        if (r.lease) console.log(`  lease: ${r.lease.holder} until ${new Date(r.lease.expiresAt).toLocaleTimeString()}`);
        if (r.nextAction) console.log(`  next: ${r.nextAction}`);
      }
      break;
    }
    case 'replan': {
      const goalId = positional[0];
      if (!goalId) {
        console.error('用法: infuture loop replan <goalId>');
        process.exitCode = 1;
        return;
      }
      const ctl = new LoopControl(store);
      const r = ctl.replan(goalId);
      await store.persist();
      console.log(`[loop] replan ${r.goalId}: ${r.changes.length} change(s)`);
      for (const c of r.changes) console.log(`  ${c.todoId}: ${c.from} → ${c.to}`);
      if (r.nextAction) console.log(`  next: ${r.nextAction}`);
      break;
    }
    case 'lease': {
      const ctl = new LoopControl(store);
      const sub2 = positional[0];
      const goalId = strFlag('--goal') ?? positional[1];
      const holder = strFlag('--holder') ?? 'cli';
      const ttl = numFlag('--ttl', 300_000);
      switch (sub2) {
        case 'claim': {
          if (!goalId) {
            console.error('用法: infuture loop lease claim <goalId> [--holder H] [--ttl MS]');
            break;
          }
          const l = ctl.claimLease(goalId, holder, ttl);
          await store.persist();
          console.log(`[loop] lease ${l.id} claimed by ${l.holder} until ${new Date(l.expiresAt).toLocaleTimeString()}`);
          break;
        }
        case 'renew': {
          if (!goalId) {
            console.error('用法: infuture loop lease renew <goalId> [--holder H] [--ttl MS]');
            break;
          }
          const l = ctl.renewLease(goalId, holder, ttl);
          await store.persist();
          console.log(`[loop] lease renewed: ${l.holder} until ${new Date(l.expiresAt).toLocaleTimeString()}`);
          break;
        }
        case 'release': {
          if (!goalId) {
            console.error('用法: infuture loop lease release <goalId> [--holder H]');
            break;
          }
          const ok = ctl.releaseLease(goalId, holder);
          await store.persist();
          console.log(ok ? `[loop] lease released (${holder})` : `[loop] goal ${goalId} 无活跃 lease`);
          break;
        }
        case 'status': {
          const leases = ctl.leaseStatus(goalId ?? undefined);
          if (leases.length === 0) {
            console.log('(no active leases)');
            break;
          }
          for (const l of leases) {
            console.log(`${l.goalId}  holder=${l.holder}  until=${new Date(l.expiresAt).toLocaleTimeString()}  id=${l.id}`);
          }
          break;
        }
        default:
          console.error('用法: infuture loop lease <claim|renew|release|status> <goalId> [--holder H] [--ttl MS]');
      }
      break;
    }
    case 'task-graph': {
      const goalId = positional[0];
      if (!goalId) {
        console.error('用法: infuture loop task-graph <goalId>');
        process.exitCode = 1;
        return;
      }
      const ctl = new LoopControl(store);
      const g = ctl.taskGraph(goalId);
      if (g.nodes.length === 0) {
        console.log('(no todos)');
        break;
      }
      for (const n of g.nodes) {
        const block = n.blockedBy.length ? `  ⛔ 被 ${n.blockedBy.join(', ')} 阻塞` : '';
        console.log(`${n.status.padEnd(9)} ${n.id}  ${n.title}${block}`);
      }
      break;
    }
    case 'frontier': {
      const ctl = new LoopControl(store);
      const todos = ctl.frontier(strFlag('--goal') ?? undefined);
      if (todos.length === 0) {
        console.log('(no runnable todos)');
        break;
      }
      for (const t of todos) console.log(`${t.status.padEnd(9)} ${t.goalId}  ${t.title}`);
      break;
    }
    case 'backup': {
      const ctl = new LoopControl(store);
      const file = await ctl.backup(strFlag('--dir') ?? '.');
      console.log(`[loop] backup written to ${file}`);
      break;
    }
    case 'runs': {
      const ctl = new LoopControl(store);
      const recs = ctl.runs(strFlag('--goal') ?? undefined);
      if (recs.length === 0) {
        console.log('(no runs)');
        break;
      }
      for (const r of recs) {
        const tail = r.error ? `  error=${r.error.slice(0, 60)}` : r.result ? `  result=${r.result.slice(0, 60)}` : '';
        console.log(`${r.status.padEnd(8)} ${r.goalId}  ${r.title}  @${new Date(r.at).toLocaleTimeString()}${tail}`);
      }
      break;
    }
    default: {
      // 兼容原单 goal 串行推进：infuture loop "<goal>" [--approve|--strict]
      const goalText = args.filter((a) => !a.startsWith('--')).join(' ');
      if (!goalText) {
        console.error(
          '用法:\n  infuture loop start "<目标>" [--workers N] [--isolate]  # 多 worker 并行探索\n  infuture loop list\n  infuture loop stop <workerId>\n  infuture loop steer <workerId|--all goalId> "<指令>"\n  infuture loop status [--goal G]           # 目标状态总览\n  infuture loop delete <goalId|--all>       # 清理目标状态（含 worker 会话/隔离目录）\n  infuture loop replan <goalId>             # 依赖一致性重规划\n  infuture loop lease <claim|renew|release|status> <goalId> [--holder H] [--ttl MS]\n  infuture loop task-graph <goalId>         # 任务依赖图\n  infuture loop frontier [--goal G]         # 可推进前沿\n  infuture loop backup [--dir DIR]          # 备份事件源\n  infuture loop runs [--goal G]             # 运行历史\n  infuture loop "<目标>" [--approve|--strict]                       # 单 goal 串行推进',
        );
        process.exitCode = 1;
        return;
      }
      const engine = await getEngine();
      const planner = new LoopPlanner({ engine, store, approvalMode });
      const goal = planner.createGoal(goalText.slice(0, 60), goalText, ['目标完成且有证据']);
      planner.addTodo(goal.id, goalText);
      planner.addGate(goal.id, 'evidence', '至少有 1 条工具执行证据', 1);
      const result = await planner.driveOnce(process.cwd());
      await store.persist();
      console.log(`[loop] ran ${result.ran} todo(s) (approval=${approvalMode})`);
    }
  }
  const e = engine as Engine | null;
  if (e) e.dispose();
}

/**
 * 删除 goal 的关联资源：停止运行中的 worker、删除其 agent 会话与隔离工作目录
 * （worktree / 临时目录，不删除共享工作区根）。
 */
async function cleanGoalResources(engine: Engine, store: LoopStore, goalId: string): Promise<void> {
  const runtime = new WorkerRuntime({ engine, store });
  for (const w of store.workersFor(goalId)) {
    if (w.status === 'running' || w.status === 'idle') await runtime.stop(w.id);
    if (w.sessionId) await engine.sessions.delete(w.sessionId);
    if (w.cwd && w.cwd !== engine.workspace) {
      try {
        await fs.rm(w.cwd, { recursive: true, force: true });
      } catch {
        // 忽略清理失败（目录可能已被手动删除）
      }
    }
  }
}

async function cmdAuth(provider: string, key: string): Promise<void> {
  if (!provider || !key) {
    console.error('用法: infuture auth login <provider> <api-key>');
    process.exitCode = 1;
    return;
  }
  const engine = await buildEngine();
  await engine.auth.set(provider, { type: 'api_key', key });
  console.log(`[auth] saved key for provider \`${provider}\``);
}

async function cmdModels(): Promise<void> {
  const engine = await buildEngine();
  for (const m of engine.models.list()) {
    console.log(`${m.id.padEnd(24)} ${m.provider.padEnd(14)} ctx=${m.contextWindow}`);
  }
}

async function cmdSkills(): Promise<void> {
  const skills = await discoverSkills();
  for (const s of skills) console.log(`${s.name.padEnd(24)} ${s.description}`);
  if (skills.length === 0) console.log('(no skills installed — 运行 `infuture skills install` 占位)');
}

async function cmdDoctor(): Promise<void> {
  const engine = await buildEngine();
  let codingOk = false;
  let codingPath = '';
  try {
    await engine.coding.start(8000);
    codingOk = engine.coding.available;
    codingPath = engine.coding.servicePath;
  } catch {
    codingOk = false;
  }
  const tools = engine.tools.list();
  const coding = tools.filter((t) => /^(lsp_|dap_|execute_code|bash|ast_|subagent|review|git_)/.test(t.def.function.name));
  console.log('infuture doctor');
  console.log('──────────────────────────────');
  console.log(`node      : ${process.version}`);
  console.log(`coding    : ${codingOk ? 'ok (' + codingPath + ')' : 'coding tools 服务不可用'}`);
  console.log(`tools     : ${tools.length} (通用 ${tools.length - coding.length} + 编程 ${coding.length})`);
  console.log(`  coding  : ${coding.map((t) => t.def.function.name).slice(0, 6).join(', ')}${coding.length > 6 ? ' …' : ''}`);
  console.log(`sessions  : ${engine.sessions.list().length} in-memory`);
  console.log(`sandbox   : ${engine.settings.sandboxTier}`);
  engine.dispose();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'chat':
      await cmdChat(rest[0] ?? '', rest.slice(1));
      break;
    case 'tui':
      await startTui({});
      break;
    case 'agent':
      await cmdAgent();
      break;
    case 'channel':
      await cmdChannel();
      break;
    case 'loop':
      await cmdLoop(rest);
      break;
    case 'auth':
      if (rest[0] === 'login') await cmdAuth(rest[1] ?? '', rest[2] ?? '');
      else console.error('用法: infuture auth login <provider> <api-key>');
      break;
    case 'models':
      await cmdModels();
      break;
    case 'skills':
      if (rest[0] === 'list') await cmdSkills();
      else console.error('用法: infuture skills list');
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(usage());
      break;
    default:
      console.error(`未知命令 \`${cmd}\``);
      console.log(usage());
      process.exitCode = 1;
  }
}

function usage(): string {
  return [
    'infuture — one AI agent, everywhere you work',
    '',
    '用法:',
    '  infuture chat "<prompt>"        一次问答',
    '  infuture agent                  启动 agent（stdio JSON-RPC 服务）',
    '  infuture tui                    终端交互 UI',
    '  infuture channel                启动 Feishu/DingTalk 桥接',
    '  infuture loop "<goal>"          长运行控制平面',
    '  infuture loop delete <goalId|--all>   清理目标状态（含 worker 会话/隔离目录）',
    '  infuture auth login <p> <key>   写入 API key',
    '  infuture models                 列出模型',
    '  infuture skills list            列出技能',
    '  infuture doctor                 诊断环境',
  ].join('\n');
}

// 直接执行入口（bin）
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
