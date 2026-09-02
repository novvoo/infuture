#!/usr/bin/env node
/**
 * infuture desktop dev — 参照 mastery `scripts/desktop-dev.js` 的编排方式：
 * 用 child_process.spawn 自己拉起「后端 ws server + 前端 vite」两个子进程，
 * 轮询等待前后台都 ready 后才打印就绪信息，任一子进程退出即统一清理。
 * 相比裸 concurrently：带 ready 探测、生命周期统一管理、退出时 kill 全部子进程。
 *
 * 用法：npm run desktop（等价于 node scripts/desktop-dev.mjs）
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const WS_HOST = '127.0.0.1';
const WS_PORT = Number(process.env.INFUTURE_PORT ?? 50051);
const RENDERER_HOST = '127.0.0.1';
const RENDERER_PORT = Number(process.env.INFUTURE_RENDERER_PORT ?? 5173);
const READY_TIMEOUT_MS = 30_000;

const children = new Set();
let shuttingDown = false;

/** spawn 一个 npm workspace 脚本子进程，登记到 children，并放入独立进程组以便整组清理。 */
function run(args, options = {}) {
  const child = spawn('npm', args, {
    stdio: 'inherit',
    // detached：让子进程成为进程组组长；shutdown 时 kill(-pid) 可穿透 npm→tsx/vite 两层
    detached: true,
    ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

/** 轮询 HTTP 直到返回 2xx。 */
async function waitHttp(url, timeoutMs = READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 服务仍在启动
    }
    await delay(250);
  }
  throw new Error(`前端未在 ${timeoutMs}ms 内就绪: ${url}`);
}

/** 轮询 TCP 端口直到可连接。 */
async function waitTcp(port, host, timeoutMs = READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await delay(250);
  }
  throw new Error(`后端未在 ${timeoutMs}ms 内就绪: ${host}:${port}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        // 负 PID = 整个进程组（穿透 npm → tsx/vite）
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  // 后端 ws JSON-RPC（tsx server.ts）
  const server = run(['run', 'server', '--workspace', '@infuture/desktop']);
  // 前端 vite renderer
  const vite = run(['run', 'dev', '--workspace', '@infuture/desktop']);

  server.once('exit', (code) => {
    if (!shuttingDown) shutdown(code || 1);
  });
  vite.once('exit', (code) => {
    if (!shuttingDown) shutdown(code || 1);
  });

  // 等前后台都 ready 再放行
  await waitTcp(WS_PORT, WS_HOST);
  await waitHttp(`http://${RENDERER_HOST}:${RENDERER_PORT}/`);
  console.log(`\n[desktop] ready — ws://${WS_HOST}:${WS_PORT} + http://${RENDERER_HOST}:${RENDERER_PORT}/\n`);

  // 常驻；任一子进程退出即整体关闭
  await Promise.race([once(server, 'exit'), once(vite, 'exit')]);
  shutdown(0);
}

main().catch((error) => {
  console.error(error);
  shutdown(1);
});
