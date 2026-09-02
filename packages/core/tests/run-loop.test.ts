/**
 * Run-loop 测试：codingToolsApproval 开关、取消语义、maxTurns 收尾。
 * 使用 fake provider，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inloop } from '../src/agent/run-loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { DefaultApprovalGate, type ApprovalRequest } from '../src/sandbox/gate.js';
import type { LLMProvider, ModelRequest, ModelStream } from '@infuture/llm';
import { defaultAgentConfig } from '@infuture/types';
import type { RunEvent } from '../src/agent/events.js';

class FakeProvider implements LLMProvider {
  private plan: Array<'text' | 'tool' | 'error'>;
  constructor(plan: Array<'text' | 'tool' | 'error'>) {
    this.plan = plan;
  }
  async *streamModel(_req: ModelRequest): ModelStream {
    const step = this.plan.shift() ?? 'text';
    if (step === 'tool') {
      yield { type: 'tool_call', id: 't1', name: 'bash', arguments: '{"command":"echo hi"}' };
      yield { type: 'done' };
    } else if (step === 'error') {
      throw new Error('provider exploded');
    } else {
      yield { type: 'text', text: 'final answer' };
      yield { type: 'done' };
    }
  }
}

class CountingGate extends DefaultApprovalGate {
  requests: ApprovalRequest[] = [];
  constructor() {
    super({ tier: 'manual', timeoutMs: 500 });
  }
  override async request(a: ApprovalRequest) {
    this.requests.push(a);
    return super.request(a);
  }
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    def: {
      type: 'function',
      function: { name: 'bash', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    },
    handler: async () => ({ result: 'ok', is_error: false }),
  });
  return reg;
}

async function collectEvents(input: Parameters<typeof inloop>[0]): Promise<{ result: Awaited<ReturnType<typeof inloop>>; events: RunEvent[] }> {
  const events: RunEvent[] = [];
  const result = await inloop({ ...input, onEvent: (e) => events.push(e) });
  return { result, events };
}

test('codingToolsApproval=on: 编程工具走审批门', async () => {
  const gate = new CountingGate();
  const registry = makeRegistry();
  const { result, events } = await collectEvents({
    runId: 'r1',
    sessionId: 's1',
    model: 'test',
    provider: new FakeProvider(['tool', 'text']),
    config: defaultAgentConfig({ maxTurns: 2 }),
    registry,
    approval: gate,
    codingToolsApproval: 'on',
    history: [],
  });
  assert.equal(result.cancelled, false);
  assert.ok(result.message.content.some((b) => b.type === 'text' && b.text === 'final answer'));
  assert.equal(gate.requests.length, 1, 'on 模式应请求审批');
  assert.ok(events.some((e) => e.type === 'approval_requested'));
});

test('codingToolsApproval=off: 编程工具免审批直行', async () => {
  const gate = new CountingGate();
  const registry = makeRegistry();
  // 需要在审批请求挂起前 resolve，off 模式下不会请求审批 → 不会挂起
  const { result, events } = await collectEvents({
    runId: 'r2',
    sessionId: 's2',
    model: 'test',
    provider: new FakeProvider(['tool', 'text']),
    config: defaultAgentConfig({ maxTurns: 2 }),
    registry,
    approval: gate,
    codingToolsApproval: 'off',
    history: [],
  });
  assert.equal(result.cancelled, false);
  assert.equal(gate.requests.length, 0, 'off 模式不应请求审批');
  assert.ok(!events.some((e) => e.type === 'approval_requested'));
});

test('codingToolsApproval=auto: 编程工具自动审批不挂起', async () => {
  const gate = new CountingGate();
  const registry = makeRegistry();
  const { result, events } = await collectEvents({
    runId: 'r3',
    sessionId: 's3',
    model: 'test',
    provider: new FakeProvider(['tool', 'text']),
    config: defaultAgentConfig({ maxTurns: 2 }),
    registry,
    approval: gate,
    codingToolsApproval: 'auto',
    history: [],
  });
  assert.equal(result.cancelled, false);
  assert.equal(gate.requests.length, 0, 'auto 模式不应请求人工审批（不挂起）');
  assert.ok(events.some((e) => e.type === 'approval_requested'), '应有审批记录');
  const resolved = events.filter((e) => e.type === 'approval_resolved');
  assert.ok(resolved.length >= 1, '应有自动批准记录');
  assert.ok(resolved.every((e) => e.approved === true), '全部自动通过');
  assert.ok(resolved.some((e) => 'reason' in e && e.reason === 'auto'), '应带 auto reason');
});

/** 通用工具（shell/list/write/read/grep/glob/code_edit/inspect_image、github_*）由 generalToolsApproval 三态控制。 */
test('generalToolsApproval=auto: 通用工具（含 github_*）自动审批不弹窗，且不受 coding=on 影响', async () => {
  const gate = new CountingGate();
  const registry = new ToolRegistry();
  for (const name of ['shell', 'list', 'write', 'read', 'grep', 'glob', 'code_edit', 'inspect_image', 'github_pr_create', 'github_search_repos']) {
    registry.register({
      def: {
        type: 'function',
        function: { name, description: `generic ${name}`, parameters: { type: 'object', properties: {} } },
      },
      handler: async () => ({ result: 'ok', is_error: false }),
    });
  }
  class MultiProvider implements LLMProvider {
    private idx = 0;
    constructor(private names: string[]) {}
    async *streamModel(_req: ModelRequest): ModelStream {
      if (this.idx < this.names.length) {
        const n = this.names[this.idx++];
        yield { type: 'tool_call', id: n, name: n, arguments: '{}' };
        yield { type: 'done' };
      } else {
        yield { type: 'text', text: 'done' };
        yield { type: 'done' };
      }
    }
  }
  const names = ['shell', 'list', 'write', 'read', 'grep', 'glob', 'code_edit', 'inspect_image', 'github_pr_create', 'github_search_repos'];
  const { result, events } = await collectEvents({
    runId: 'r-g',
    sessionId: 's-g',
    model: 'test',
    provider: new MultiProvider(names),
    config: defaultAgentConfig({ maxTurns: 20 }),
    registry,
    approval: gate,
    codingToolsApproval: 'on', // 编程工具需审批，但通用工具应独立走 general=auto 免弹窗
    generalToolsApproval: 'auto',
    history: [],
  });
  assert.equal(result.cancelled, false);
  assert.equal(gate.requests.length, 0, 'general=auto 下通用工具（含 github_*）不应请求人工审批');
  const resolved = events.filter((e) => e.type === 'approval_resolved');
  assert.ok(resolved.length >= names.length, `应有 ${names.length} 条自动批准记录，实际 ${resolved.length}`);
  assert.ok(resolved.every((e) => e.approved === true), '全部自动通过');
});

test('generalToolsApproval=on: 通用工具 github_* 走审批门（弹窗）', async () => {
  const gate = new CountingGate();
  const registry = new ToolRegistry();
  for (const name of ['github_pr_create']) {
    registry.register({
      def: {
        type: 'function',
        function: { name, description: `generic ${name}`, parameters: { type: 'object', properties: {} } },
      },
      handler: async () => ({ result: 'ok', is_error: false }),
    });
  }
  class MultiProvider implements LLMProvider {
    private idx = 0;
    constructor(private names: string[]) {}
    async *streamModel(_req: ModelRequest): ModelStream {
      if (this.idx < this.names.length) {
        const n = this.names[this.idx++];
        yield { type: 'tool_call', id: n, name: n, arguments: '{}' };
        yield { type: 'done' };
      } else {
        yield { type: 'text', text: 'done' };
        yield { type: 'done' };
      }
    }
  }
  const { result, events } = await collectEvents({
    runId: 'r-gon',
    sessionId: 's-gon',
    model: 'test',
    provider: new MultiProvider(['shell', 'github_pr_create']),
    config: defaultAgentConfig({ maxTurns: 10 }),
    registry,
    approval: gate,
    codingToolsApproval: 'auto',
    networkToolsApproval: 'auto',
    generalToolsApproval: 'on',
    history: [],
  });
  assert.equal(result.cancelled, false);
  assert.equal(gate.requests.length, 1, 'general=on 下真通用工具应请求人工审批');
  assert.ok(events.some((e) => e.type === 'approval_requested'));
});

test('codingToolsApproval=auto: shell/read/write 等编程工具自动审批不弹窗', async () => {
  const gate = new CountingGate();
  const registry = new ToolRegistry();
  for (const name of ['shell', 'read', 'write', 'edit', 'list', 'grep', 'spawn_workers']) {
    registry.register({
      def: {
        type: 'function',
        function: { name, description: `coding ${name}`, parameters: { type: 'object', properties: {} } },
      },
      handler: async () => ({ result: 'ok', is_error: false }),
    });
  }
  class MultiProvider implements LLMProvider {
    private idx = 0;
    constructor(private names: string[]) {}
    async *streamModel(_req: ModelRequest): ModelStream {
      if (this.idx < this.names.length) {
        const n = this.names[this.idx++];
        yield { type: 'tool_call', id: n, name: n, arguments: '{}' };
        yield { type: 'done' };
      } else {
        yield { type: 'text', text: 'done' };
        yield { type: 'done' };
      }
    }
  }
  const { result, events } = await collectEvents({
    runId: 'r-cauto',
    sessionId: 's-cauto',
    model: 'test',
    provider: new MultiProvider(['shell', 'read', 'write', 'edit', 'list', 'grep', 'spawn_workers']),
    config: defaultAgentConfig({ maxTurns: 10 }),
    registry,
    approval: gate,
    codingToolsApproval: 'auto',
    networkToolsApproval: 'auto',
    generalToolsApproval: 'on',
    history: [],
  });
  assert.equal(result.cancelled, false);
  assert.equal(gate.requests.length, 0, 'coding=auto 下编程工具应自动通过、不弹窗');
  const approved = events.filter((e) => e.type === 'approval_resolved' && e.reason === 'auto');
  assert.equal(approved.length, 7, '每个编程工具都应有 auto 批准记录');
});

test('取消：工具执行中 abort 返回 cancelled 且带最近 assistant 文本', async () => {
  const gate = new CountingGate();
  const registry = makeRegistry();
  const ac = new AbortController();
  const p = collectEvents({
    runId: 'r3',
    sessionId: 's3',
    model: 'test',
    provider: new FakeProvider(['tool', 'text']),
    config: defaultAgentConfig({ maxTurns: 5 }),
    registry,
    approval: gate,
    history: [],
    signal: ac.signal,
  });
  // 等审批请求出现（审批会被 gate 挂起 500ms），此时 abort
  await new Promise((r) => setTimeout(r, 150));
  ac.abort();
  const { result, events } = await p;
  assert.equal(result.cancelled, true);
  assert.ok(events.some((e) => e.type === 'cancelled'));
});

test('provider 抛错：返回 error 事件且不崩溃', async () => {
  const gate = new CountingGate();
  const registry = makeRegistry();
  const { result, events } = await collectEvents({
    runId: 'r4',
    sessionId: 's4',
    model: 'test',
    provider: new FakeProvider(['error']),
    config: defaultAgentConfig({ maxTurns: 3 }),
    registry,
    approval: gate,
    history: [],
  });
  assert.equal(result.cancelled, false);
  assert.ok(events.some((e) => e.type === 'error' && (e as { message?: string }).message?.includes('provider exploded')));
});

test('maxTurns 耗尽：返回最近 assistant 文本而非空回复', async () => {
  const gate = new CountingGate();
  const registry = makeRegistry();
  const provider = new FakeProvider(['text', 'text', 'text', 'text']);
  const { result } = await collectEvents({
    runId: 'r5',
    sessionId: 's5',
    model: 'test',
    provider,
    config: defaultAgentConfig({ maxTurns: 2 }),
    registry,
    approval: gate,
    history: [],
  });
  // 每轮都返回 'final answer'，maxTurns=2 耗尽后返回最近 assistant（非空）
  const text = result.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.ok(text.length > 0, '不应返回空回复');
});

/** 仅推理、无文本无工具调用 → 不应视为完成：注入提示重试，直到模型给出回答。 */
test('仅推理无输出：run-loop 注入提示重试而非返回空回复', async () => {
  class ReasoningFirstProvider implements LLMProvider {
    private call = 0;
    async *streamModel(_req: ModelRequest): ModelStream {
      this.call++;
      if (this.call === 1) {
        // 第一轮：只吐 reasoning，不吐文本/工具
        yield { type: 'reasoning', text: '让我想想……' };
        yield { type: 'done' };
      } else {
        // 重试后：给出最终回答
        yield { type: 'reasoning', text: '继续思考……' };
        yield { type: 'text', text: '最终答案' };
        yield { type: 'done' };
      }
    }
  }
  const gate = new CountingGate();
  const registry = makeRegistry();
  const provider = new ReasoningFirstProvider();
  const { result, events } = await collectEvents({
    runId: 'r-r-only',
    sessionId: 's-r-only',
    model: 'test',
    provider,
    config: defaultAgentConfig({ maxTurns: 5 }),
    registry,
    approval: gate,
    history: [],
  });
  assert.equal(result.cancelled, false);
  const text = result.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.equal(text, '最终答案', '应重试并拿到最终回答');
  assert.ok(provider['call'] >= 2, '应发生至少两轮调用');
});

/** 委派优先：worker 任务首轮只暴露 spawn_workers/list_workers；未 spawn 前强制重试，直到调用 spawn_workers。 */
test('委派优先：worker 任务首轮 only worker 工具，强制重试直到 spawn', async () => {
  const gate = new CountingGate();
  const registry = new ToolRegistry();
  registry.register({
    def: { type: 'function', function: { name: 'spawn_workers', description: 'spawn', parameters: { type: 'object', properties: {} } } },
    handler: async () => ({ result: '已启动 3 个 worker', is_error: false }),
  });
  registry.register({
    def: { type: 'function', function: { name: 'list_workers', description: 'list', parameters: { type: 'object', properties: {} } } },
    handler: async () => ({ result: '[]', is_error: false }),
  });
  registry.register({
    def: { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } } },
    handler: async () => ({ result: 'file', is_error: false }),
  });

  const seenTools: string[][] = [];
  let call = 0;
  class DelegateProvider implements LLMProvider {
    async *streamModel(req: ModelRequest): ModelStream {
      seenTools.push(req.tools.map((t) => t.function.name));
      call++;
      if (call === 1) {
        // 第一轮（委派优先）：只吐推理，不调工具 → 应被强制重试
        yield { type: 'reasoning', text: '这个问题我可以自己解……' };
        yield { type: 'done' };
      } else if (call === 2) {
        // 第二轮：调用 spawn_workers
        yield { type: 'tool_call', id: 's1', name: 'spawn_workers', arguments: '{}' };
        yield { type: 'done' };
      } else {
        // 后续：给出最终回复
        yield { type: 'text', text: '三个 worker 已完成' };
        yield { type: 'done' };
      }
    }
  }

  const { result } = await collectEvents({
    runId: 'r-del',
    sessionId: 's-del',
    model: 'test',
    provider: new DelegateProvider(),
    config: defaultAgentConfig({ maxTurns: 6 }),
    registry,
    approval: gate,
    history: [{ role: 'user', content: [{ type: 'text', text: '启动三个 worker，第一个解题，第二个反思，第三个再探索' }] }],
  });

  // 首轮委派优先：只暴露 spawn_workers（避免先调 list_workers 造成无结果的历史污染）
  assert.ok(seenTools[0] && seenTools[0].length === 1 && seenTools[0][0] === 'spawn_workers', `首轮应 only spawn_workers，实际 ${JSON.stringify(seenTools[0])}`);
  // 至少发生两轮调用（强制重试）
  assert.ok(call >= 2, `应发生至少两轮调用，实际 ${call}`);
  // spawn 后恢复完整工具集（第二轮之后应包含 read 等核心工具）
  const afterSpawn = seenTools.find((t) => t.includes('read') && t.includes('spawn_workers'));
  assert.ok(afterSpawn, `spawn 后应恢复完整工具集，seen=${JSON.stringify(seenTools)}`);
  const text = result.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.equal(text, '三个 worker 已完成');
});

/** 深推理防截断：单轮内大量 reasoning（>4000 字符）后接文本 → 不应被掐断，应正常产出最终答案（worker 解题场景回归）。 */
test('深推理不截断：单轮 >4000 字符 reasoning + text → 正常返回文本', async () => {
  const gate = new CountingGate();
  const registry = makeRegistry();
  let calls = 0;
  class DeepReasonProvider implements LLMProvider {
    async *streamModel(_req: ModelRequest): ModelStream {
      calls++;
      // 单轮内：先输出 6000 字符推理，再输出最终文本（模拟 worker 解数学题）
      yield { type: 'reasoning', text: '推理'.repeat(3000) };
      yield { type: 'text', text: '最终答案 30' };
      yield { type: 'done' };
    }
  }
  const { result } = await collectEvents({
    runId: 'r-deep',
    sessionId: 's-deep',
    model: 'test',
    provider: new DeepReasonProvider(),
    config: defaultAgentConfig({ maxTurns: 5 }),
    registry,
    approval: gate,
    history: [],
  });
  const text = result.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.equal(text, '最终答案 30', '深推理应正常产出文本');
  assert.equal(calls, 1, '不应因截断触发重试（单轮完成）');
});

/** 委派强制失败回退：retries 耗尽后放弃委派优先，下一轮恢复完整工具+正常推理，避免空回复。 */
test('委派强制失败回退：retries 耗尽后恢复完整工具，非空回复收尾', async () => {
  const gate = new CountingGate();
  const registry = new ToolRegistry();
  registry.register({
    def: { type: 'function', function: { name: 'spawn_workers', description: 'spawn', parameters: { type: 'object', properties: {} } } },
    handler: async () => ({ result: 'ok', is_error: false }),
  });
  registry.register({
    def: { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } } },
    handler: async () => ({ result: 'file', is_error: false }),
  });

  const seenTools: string[][] = [];
  let call = 0;
  class StubbornProvider implements LLMProvider {
    async *streamModel(req: ModelRequest): ModelStream {
      seenTools.push(req.tools.map((t) => t.function.name));
      call++;
      if (call <= 3) {
        // 委派模式前 3 轮：只吐推理，迟迟不调 spawn
        yield { type: 'reasoning', text: '我在犹豫要不要 spawn_workers……' };
        yield { type: 'done' };
      } else {
        // 回退后的完整工具轮：直接作答
        yield { type: 'text', text: '好吧，我直接给出结论' };
        yield { type: 'done' };
      }
    }
  }

  const { result } = await collectEvents({
    runId: 'r-fb',
    sessionId: 's-fb',
    model: 'test',
    provider: new StubbornProvider(),
    config: defaultAgentConfig({ maxTurns: 8 }),
    registry,
    approval: gate,
    history: [{ role: 'user', content: [{ type: 'text', text: '启动 worker 解题' }] }],
  });

  // 前 3 轮（委派优先）仅暴露 spawn_workers
  assert.ok(seenTools.slice(0, 3).every((t) => t.length === 1 && t[0] === 'spawn_workers'), `前 3 轮应 only spawn_workers，实际 ${JSON.stringify(seenTools)}`);
  // 回退后恢复完整工具集
  const fallbackTurn = seenTools.find((t) => t.includes('read'));
  assert.ok(fallbackTurn, `回退后应包含 read 等完整工具，seen=${JSON.stringify(seenTools)}`);
  // 非空回复收尾
  const text = result.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.equal(text, '好吧，我直接给出结论');
});
