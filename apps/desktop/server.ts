/**
 * infuture desktop 后端 — WebSocket JSON-RPC 服务。
 * 宿主：Engine + ServerSession，监听 ws://127.0.0.1:50051。
 */
import { WebSocketServer, WebSocket } from 'ws';
import { Engine } from '@infuture/core';
import { ServerSession } from '@infuture/rpc';

const PORT = Number(process.env.INFUTURE_PORT ?? 50051);

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

  const wss = new WebSocketServer({ port: PORT });
  console.log(`[infuture server] ws://127.0.0.1:${PORT}`);

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

  process.on('SIGINT', () => {
    wss.close();
    engine.dispose();
    process.exit(0);
  });
}

void main();
