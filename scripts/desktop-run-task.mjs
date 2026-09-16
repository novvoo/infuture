/**
 * desktop-run-task — 向运行中的 infuture desktop 后端（ws://127.0.0.1:50051）发送一条任务。
 *
 * 用法：node scripts/desktop-run-task.mjs "任务提示词"
 * 流程：JSON-RPC over WebSocket → session.create → session.send，随后打印服务端推送的事件。
 */
const WS_URL = process.env.INFUTURE_WS ?? 'ws://127.0.0.1:50051';
const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error('用法: node scripts/desktop-run-task.mjs "任务提示词"');
  process.exit(1);
}

const ws = new WebSocket(WS_URL);
let nextId = 0;
const pending = new Map();
const timers = new Map();

function call(method, params, timeoutMs = 30000) {
  const id = `t_${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC 超时: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject });
    timers.set(id, timer);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    clearTimeout(timers.get(msg.id));
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : entry.resolve(msg.result);
    return;
  }
  // 通知流：打印 agent 运行事件，便于观察进度
  const method = msg.method ?? '';
  if (!method) return;
  if (/tool|run|session|message|approval/i.test(method)) {
    const brief = JSON.stringify(msg.params ?? {}).slice(0, 200);
    console.log(`[event] ${method} ${brief}`);
  }
};

ws.onopen = async () => {
  try {
    const created = await call('session.create', { name: '浏览器拟人漫游' });
    const sessionId = created?.id ?? created?.session?.id;
    console.log(`▶ 会话已创建: ${sessionId}`);
    console.log(`▶ 发送任务…`);
    await call('session.send', { sessionId, prompt }, 60000);
    console.log(`▶ 任务已提交，agent 开始运行（事件流如上，浮窗会实时显示浏览器画面）`);
    console.log(`▶ 在浏览器打开 http://127.0.0.1:5173 可以实时观看`);
    // 保持连接 15 分钟接收事件，然后退出（不停止 agent 运行）
    setTimeout(() => { console.log('✓ 监听窗口结束，agent 仍在后台运行'); process.exit(0); }, 15 * 60 * 1000);
  } catch (err) {
    console.error('✗', err.message);
    process.exit(1);
  }
};

ws.onerror = (e) => { console.error('✗ WS 连接失败（desktop 后端未启动？）'); process.exit(1); };
