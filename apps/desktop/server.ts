/**
 * infuture desktop 后端 — WebSocket JSON-RPC 服务。
 * 宿主：Engine + ServerSession，监听 ws://127.0.0.1:50051。
 *
 * 生产模式：若前端构建产物（apps/desktop/dist，可用 INFUTURE_STATIC_DIR 覆盖）存在，
 * 则同一端口同时托管静态页面（SPA 回退）与 WebSocket，打开 http://<host>:<port> 即可使用。
 * 开发模式（dist 不存在）：仅提供 ws，前端由 vite 在 5173 提供。
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Engine } from '@infuture/core';
import { ServerSession } from '@infuture/rpc';

const PORT = Number(process.env.INFUTURE_PORT ?? 50051);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.INFUTURE_STATIC_DIR ?? path.join(__dirname, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/** 静态文件服务（SPA 回退：非资源路径统一回 index.html）。 */
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  // 防目录穿越：解析后必须仍在 STATIC_DIR 内
  const filePath = path.normalize(path.join(STATIC_DIR, path.normalize(urlPath)));
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // 文件不存在 → SPA 回退到 index.html（前端路由由客户端处理）
    try {
      const idx = await fs.readFile(path.join(STATIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(idx);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}

async function main() {
  let server!: ServerSession;
  const engine = new Engine({
    // 桌面端默认 manual 审批，弹窗由前端触发
    sandboxTier: 'manual',
    // 普通对话经 spawn_workers 工具启动多 worker：委托 rpc 的 loop worker 运行时
    workerSpawner: (goalId, tasks, isolate) => server.spawnWorkers(goalId, tasks, isolate),
    workerLister: (goal) => server.listWorkers(goal),
  });
  await engine.init();

  // 不注入 resolver：审批走 DefaultApprovalGate 的挂起通道，
  // 由前端通过 approval.resolve RPC 决议（带超时自动拒绝兜底）。
  server = new ServerSession(engine);
  server.setNotificationHandler((n) => broadcast(n));

  // 同一 HTTP 服务器上挂 WebSocket：GET 走静态托管，upgrade 走 ws JSON-RPC
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res);
    } else {
      res.writeHead(405).end('method not allowed');
    }
  });
  const wss = new WebSocketServer({ server: httpServer });

  const sockets = new Set<WebSocket>();

  function broadcast(n: unknown): void {
    const line = JSON.stringify(n);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(line);
    }
  }

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('message', async (data) => {
      const line = data.toString();
      try {
        const req = JSON.parse(line);
        const resp = await server.handle(req);
        if (resp && 'id' in resp) ws.send(JSON.stringify(resp));
      } catch (err) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(err) } }));
      }
    });
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => sockets.delete(ws));
  });

  // 检查前端产物是否存在，决定是否启用静态托管
  let staticEnabled = false;
  try {
    const st = await fs.stat(STATIC_DIR);
    staticEnabled = st.isDirectory();
  } catch {
    staticEnabled = false;
  }

  httpServer.listen(PORT, () => {
    if (staticEnabled) {
      console.log(`[infuture server] ws + static http://127.0.0.1:${PORT} (static: ${STATIC_DIR})`);
    } else {
      console.log(`[infuture server] ws://127.0.0.1:${PORT} (未发现前端产物 ${STATIC_DIR}，前端请用 vite dev)`);
    }
  });

  process.on('SIGINT', () => {
    wss.close();
    httpServer.close();
    engine.dispose();
    process.exit(0);
  });
}

void main();
