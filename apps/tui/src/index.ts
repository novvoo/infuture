/**
 * TUI — 终端交互聊天界面。对应 future-os `tui`。
 * 基于 readline 的精简实现：会话、模型、技能、审批。
 */
import readline from 'node:readline';
import { Engine, type Session, type RunEvent } from '@infuture/core';

const COL = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export interface TuiOptions {
  model?: string;
  sandboxTier?: 'off' | 'manual' | 'sandbox';
  onExit?: () => void;
}

export async function startTui(options: TuiOptions = {}): Promise<void> {
  const engine = new Engine({
    model: options.model,
    sandboxTier: options.sandboxTier ?? 'manual',
  });
  await engine.init();
  let session: Session = await engine.sessions.create();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    rl.setPrompt(COL.green(`infuture ${COL.dim(`[${session.meta.name}]`)} › `));
    rl.prompt();
  };

  console.log(COL.cyan('infuture — one AI agent, everywhere you work'));
  console.log(COL.dim('输入 /help 查看命令。每个工具调用都经审批门。'));
  console.log('');

  const helpText = [
    '/new           新会话',
    '/model         列出并切换模型',
    '/skills        列出已安装技能',
    '/approve <id>  批准挂起的工具调用',
    '/reject <id>   拒绝挂起的工具调用',
    '/status        会话状态',
    '/quit          退出',
  ].join('\n');

  const printStream = () => ({
    onEvent: (ev: RunEvent) => {
      switch (ev.type) {
        case 'text_delta':
          process.stdout.write(COL.cyan(ev.text));
          break;
        case 'reasoning_delta':
          process.stdout.write(COL.dim(ev.text));
          break;
        case 'tool_call':
          console.log('');
          console.log(COL.yellow(`  ⚙ ${ev.name} ${JSON.stringify(ev.args).slice(0, 160)}`));
          break;
        case 'tool_result':
          console.log(COL.dim(`    ↳ ${ev.isError ? COL.red('✗') : COL.green('✓')} ${ev.result.slice(0, 240)}`));
          break;
        case 'approval_requested':
          console.log('');
          console.log(COL.yellow(`  [审批] ${ev.toolName} — 运行 /approve ${ev.requestId} 或 /reject ${ev.requestId}`));
          break;
        case 'complete':
          console.log('');
          break;
        default:
          break;
      }
    },
  });

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }

    // ── 斜杠命令 ──
    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      switch (cmd) {
        case 'help':
          console.log(helpText);
          break;
        case 'new': {
          session = await engine.sessions.create();
          console.log(COL.dim(`新会话 ${session.id}`));
          break;
        }
        case 'model': {
          const models = engine.models.list();
          if (rest[0]) {
            const m = engine.models.get(rest[0]);
            if (m) {
              session.meta.model = m.id;
              console.log(COL.green(`模型 → ${m.id}`));
            } else console.log(COL.red(`未知模型 ${rest[0]}`));
          } else {
            models.forEach((m) => console.log(`${m.id.padEnd(24)} ${COL.dim(m.provider)}`));
          }
          break;
        }
        case 'skills': {
          const { discoverSkills } = await import('@infuture/core');
          const skills = await discoverSkills();
          skills.forEach((s) => console.log(`${s.name.padEnd(24)} ${COL.dim(s.description)}`));
          if (skills.length === 0) console.log(COL.dim('(无已安装技能)'));
          break;
        }
        case 'approve':
        case 'reject': {
          const id = rest[0];
          if (!id) {
            console.log(COL.yellow(`挂起审批数: ${engine.approval.pendingCount()}`));
            break;
          }
          engine.approval.resolveApproval(id, cmd === 'approve');
          console.log(COL.dim(`审批 ${cmd === 'approve' ? '批准' : '拒绝'} ${id}`));
          break;
        }
        case 'status':
          console.log(`会话: ${session.meta.name} (${session.id})`);
          console.log(`模型: ${session.meta.model}`);
          console.log(`流式: ${session.control.isStreaming}`);
          console.log(`挂起审批: ${engine.approval.pendingCount()}`);
          break;
        case 'quit':
        case 'exit':
          rl.close();
          engine.dispose();
          options.onExit?.();
          return;
        default:
          console.log(COL.red(`未知命令 /${cmd}（/help 查看）`));
      }
      prompt();
      return;
    }

    // ── 正常对话 ──
    console.log('');
    console.log(COL.dim('── 思考中 ──'));
    const outcome = await engine.run(session, input, { onEvent: printStream().onEvent });
    if (outcome.error) {
      console.log(COL.red(`\n[error] ${outcome.error}`));
    } else if (outcome.reply) {
      console.log('');
      console.log(COL.green('── 回复 ──'));
      console.log(outcome.reply);
    }
    console.log('');
    prompt();
  });

  prompt();
  process.stdin.on('close', () => {
    engine.dispose();
    options.onExit?.();
  });
}
