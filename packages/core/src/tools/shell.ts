/**
 * shell 工具 — 在会话 cwd 中执行命令，输出截断防爆。
 * 对应 Rust `tools::shell` + `cmd_exe_rewrite`。
 */
import { spawn } from 'node:child_process';
import type { AgentTool, ToolCallResult } from '@infuture/types';
import { toolDef } from '@infuture/types';

const MAX_OUTPUT = 200_000;

export interface ShellToolOptions {
  cwd?: string;
  maxOutput?: number;
  /** 允许的 shell 路径（默认 /bin/sh）。 */
  shell?: string;
}

export function shellTool(options: ShellToolOptions = {}): AgentTool {
  const cwd = options.cwd ?? process.cwd();
  const maxOutput = options.maxOutput ?? MAX_OUTPUT;
  const shell = options.shell ?? '/bin/sh';

  return {
    def: toolDef('shell', 'Run a shell command and return its stdout/stderr.', {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        timeout_ms: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['command'],
    }),
    guidelines: ['Shell is gated by approval', 'Long-running commands should set timeout_ms'],
    handler: (args, ctx): Promise<ToolCallResult> =>
      new Promise((resolve) => {
        const { command, timeout_ms } = (args ?? {}) as { command?: string; timeout_ms?: number };
        if (!command) {
          resolve({ result: 'shell: missing `command`', is_error: true });
          return;
        }
        // detached + 进程组：超时/取消时能杀掉整个进程组（含子进程），避免孤儿进程。
        const child = spawn(shell, ['-c', command], {
          cwd: ctx?.cwd ?? cwd,
          env: process.env,
          detached: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const killGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const settle = (result: ToolCallResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (abortHandler) ctx?.signal?.removeEventListener('abort', abortHandler);
          resolve(result);
        };

        const timer = timeout_ms
          ? setTimeout(() => {
              killGroup();
              settle({ result: `shell: timed out after ${timeout_ms}ms`, is_error: true });
            }, timeout_ms)
          : null;
        const abortHandler = ctx?.signal
          ? () => {
              killGroup();
              settle({ result: 'shell: cancelled', is_error: true });
            }
          : undefined;
        if (ctx?.signal) {
          if (ctx.signal.aborted) abortHandler?.();
          else ctx.signal.addEventListener('abort', abortHandler!, { once: true });
        }

        child.stdout.on('data', (d: Buffer) => {
          if (stdout.length < maxOutput) stdout += d.toString();
        });
        child.stderr.on('data', (d: Buffer) => {
          if (stderr.length < maxOutput) stderr += d.toString();
        });
        child.on('error', (err) => {
          settle({ result: `shell: ${err.message}`, is_error: true });
        });
        child.on('close', (code) => {
          if (settled) return;
          const truncated = stdout.length >= maxOutput || stderr.length >= maxOutput;
          const result = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}${truncated ? '\n[output truncated]' : ''}`;
          settle({
            result: result.trim() || `(no output, exit ${code})`,
            is_error: code !== 0,
          });
        });
      }),
  };
}
