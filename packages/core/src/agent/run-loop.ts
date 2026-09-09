/**
 * AgentLoop — agent 运行环。对应 Rust `agent/run_loop.rs`。
 *
 * 每轮：模型流式输出 → 若有工具调用 → 审批门 → 执行 → 回填 → 再请求。
 * 无工具调用即完成；达到 maxTurns 停止。
 */
import {
  type AgentMessage,
  type AgentConfig,
  type Usage,
  addImage,
  emptyAgentMessage,
  emptyUsage,
  newAssistantMessage,
  newToolMessage,
  newUserMessage,
  toolCalls,
  hasToolCalls,
} from '@infuture/types';
import type { LLMProvider, ModelStream, ModelStreamEvent } from '@infuture/llm';
import type { ApprovalGate } from '../sandbox/gate.js';
import type { ToolRegistry } from '../tools/registry.js';
import { buildSelectionContext, classifyTaskType, selectToolDefs, type ToolSelectionOptions } from '../tools/selection.js';
import type { RunEventCallback } from './events.js';
import { generateId } from '../utils/id.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

/**
 * 读取图片用于模型注入：GLM 等供应商只接受 JPEG（PNG 会报 1210 图片格式错误）→
 * macOS 用系统 sips 把 PNG 转 JPEG 再注入；转换失败或非 PNG 则原样返回。
 */
async function readImageForInjection(p: string): Promise<{ mime: string; base64: string }> {
  const ext = path.extname(p).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
  if (mime === 'image/png' && process.platform === 'darwin') {
    try {
      const tmp = path.join(os.tmpdir(), `infuture-png-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
      await execFileAsync('sips', ['-s', 'format', 'jpeg', p, '--out', tmp], { timeout: 20_000 });
      const data = await fs.readFile(tmp);
      await fs.unlink(tmp).catch(() => {});
      return { mime: 'image/jpeg', base64: data.toString('base64') };
    } catch {
      // sips 不可用（非 macOS）→ 原样返回 PNG
    }
  }
  const data = await fs.readFile(p);
  return { mime, base64: data.toString('base64') };
}

/**
 * 模型流超时保护：GLM 等供应商偶发"SSE 中途挂起不结束"，裸 for-await 会永久卡住任务。
 * - 空闲超时：连续 idleMs 无任何事件 → 若已累积内容则正常结束流（保留已产出），否则抛错；
 * - 总时长超时：整个流超过 totalMs 强制结束。
 */
function withStreamTimeout(stream: ModelStream, idleMs = 90_000, totalMs = 600_000): ModelStream {
  return {
    [Symbol.asyncIterator]() {
      const it = stream[Symbol.asyncIterator]();
      const started = Date.now();
      let timers: ReturnType<typeof setTimeout>[] = [];
      const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers = [];
      };
      return {
        async next(): Promise<IteratorResult<ModelStreamEvent>> {
          clearTimers();
          if (Date.now() - started > totalMs) {
            throw new Error(`模型流总时长超时（${Math.round(totalMs / 1000)}s），已中断`);
          }
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const idleP = new Promise<never>((_, rej) => {
            idleTimer = setTimeout(() => rej(new Error(`模型流空闲超时（${Math.round(idleMs / 1000)}s 无输出）`)), idleMs);
            timers.push(idleTimer!);
          });
          try {
            return await Promise.race([it.next(), idleP]);
          } finally {
            clearTimers();
          }
        },
        async return(): Promise<IteratorResult<ModelStreamEvent>> {
          clearTimers();
          return typeof it.return === 'function' ? it.return() : { done: true, value: undefined };
        },
      };
    },
  };
}

/** 工具结果文本里出现的图片路径（截图/图片文件）→ 读取并作为图像块注入同一 tool 消息，形成视觉闭环。 */
async function attachImagesFromResult(msg: AgentMessage, resultText: string, cwd?: string): Promise<void> {
  const base = cwd || process.cwd();
  const re =
    /(?:screenshot saved|image(?: file)?|图片(?:路径|文件)?)[:：]?\s*([^\s"']+\.(?:png|jpe?g|gif|webp))|!\[[^\]]*\]\(([^)]+\.(?:png|jpe?g|gif|webp))\)/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(resultText))) {
    const raw = (m[1] ?? m[2] ?? '').trim().replace(/[)\]"'`]/g, '');
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const p = path.isAbsolute(raw) ? raw : path.resolve(base, raw);
    try {
      const st = await fs.stat(p);
      if (!st.isFile() || st.size > 10 * 1024 * 1024) continue; // 上限 10MB，防止超大截图撑爆上下文
      const { mime, base64 } = await readImageForInjection(p);
      addImage(msg, mime, base64);
    } catch {
      // 文件不存在/读取失败：跳过，不阻断工具结果
    }
  }
}

/**
 * 视觉/截图任务首轮自动截图：执行 computer_use action=screenshot，
 * 把当前屏幕作为图像消息注入对话（模型首轮即可看到屏幕，无需先自觉调用工具）。
 * 返回 null 表示截图失败或不可用（不阻断流程）。
 */
async function autoScreenshotForVisualTask(registry: ToolRegistry): Promise<AgentMessage | null> {
  const r = await registry.execute('computer_use', { action: 'screenshot' });
  const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '');
  const m = /screenshot saved:\s*([^\s"']+\.(?:png|jpe?g|gif|webp))/i.exec(text);
  if (!m || r.is_error) return null;
  const p = m[1];
  const st = await fs.stat(p);
  if (!st.isFile() || st.size > 10 * 1024 * 1024) return null;
  const { mime, base64 } = await readImageForInjection(p);
  const msg = emptyAgentMessage();
  msg.content.push({
    type: 'text',
    text: '[系统] 检测到视觉/截图任务，已自动截取当前屏幕并注入（screenshot）。直接基于屏幕内容开始工作；后续每完成关键步骤可再调用 computer_use action=screenshot 验证当前状态。',
  });
  addImage(msg, mime, base64);
  return msg;
}

export interface RunLoopInput {
  runId: string;
  sessionId: string;
  model: string;
  provider: LLMProvider;
  config: AgentConfig;
  registry: ToolRegistry;
  approval: ApprovalGate;
  /** 编程工具是否也过审批门（'off' = 编程工具免审批直行）。 */
  codingToolsApproval?: 'on' | 'auto' | 'off';
  /** 联网工具审批（browser / web_search 等）：'off' = 免审批直行。 */
  networkToolsApproval?: 'on' | 'auto' | 'off';
  /** 通用工具审批（read/write/edit/list/shell、grep/glob/code_edit/inspect_image、github_* 等其余工具）：'on'=需审批 · 'auto'=自动审批 · 'off'=免审批直行。 */
  generalToolsApproval?: 'on' | 'auto' | 'off';
  /** 本 run 之前的会话历史。 */
  history: AgentMessage[];
  /** 工具选择覆盖：forceGroups（强制启用分组）/ always（额外恒包含工具名）。 */
  toolSelection?: ToolSelectionOptions;
  /** 工具执行的工作目录（worker worktree 隔离时覆盖工具默认 cwd）。 */
  cwd?: string;
  thinkingLevel?: string;
  onEvent?: RunEventCallback;
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 编程工具：编程工具（lsp/dap/execute_code/bash/ast/subagent/review/git），按 codingToolsApproval 三态审批。 */
const CODING_TOOL_RE = /^(lsp_|dap_|execute_code|bash|ast_|subagent|review|git_|shell|read|write|edit|list|code_edit|glob|grep|inspect_image|spawn_workers)/;
/** 联网工具：browser / web_search / web_fetch 等（走 networkToolsApproval 三态审批）。 */
const NETWORK_TOOL_RE = /^(browser|web_search|web_fetch|general_search|image_search|scholar_search|fetch|http_)/;

export interface RunLoopResult {
  message: AgentMessage;
  usage?: Usage;
  turns: number;
  cancelled: boolean;
}

function parseToolArgs(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  return raw;
}

interface ApprovalForOptions {
  requestId: string;
  toolName: string;
  args: unknown;
  sessionId: string;
  emit: RunEventCallback;
  runId: string;
}

/** 审批决策：编程工具按 codingToolsApproval、联网工具按 networkToolsApproval、其余通用工具按 generalToolsApproval 三态处理（on=需审批 / auto=自动审批 / off=免审批直行）。 */
async function approvalFor(
  approval: ApprovalGate,
  codingToolsApproval: 'on' | 'auto' | 'off' | undefined,
  networkToolsApproval: 'on' | 'auto' | 'off' | undefined,
  generalToolsApproval: 'on' | 'auto' | 'off' | undefined,
  toolName: string,
  opts: ApprovalForOptions,
): Promise<{ approved: boolean; reason?: string }> {
  if (CODING_TOOL_RE.test(toolName)) {
    if (codingToolsApproval === 'off') {
      // 完全执行：跳过审批门，直接放行（无批准记录）
      opts.emit({ type: 'approval_resolved', runId: opts.runId, requestId: opts.requestId, approved: true });
      return { approved: true, reason: 'off' };
    }
    if (codingToolsApproval === 'auto') {
      // 自动审批：走审批记录但立即自动通过（不挂起、不弹窗）
      opts.emit({ type: 'approval_requested', runId: opts.runId, requestId: opts.requestId, toolName: opts.toolName, args: opts.args });
      opts.emit({ type: 'approval_resolved', runId: opts.runId, requestId: opts.requestId, approved: true, reason: 'auto' });
      return { approved: true, reason: 'auto' };
    }
    // 'on'：编程工具也过审批门（人工批准）
  }
  if (NETWORK_TOOL_RE.test(toolName)) {
    if (networkToolsApproval === 'off') {
      opts.emit({ type: 'approval_resolved', runId: opts.runId, requestId: opts.requestId, approved: true });
      return { approved: true, reason: 'off' };
    }
    if (networkToolsApproval === 'auto') {
      opts.emit({ type: 'approval_requested', runId: opts.runId, requestId: opts.requestId, toolName: opts.toolName, args: opts.args });
      opts.emit({ type: 'approval_resolved', runId: opts.runId, requestId: opts.requestId, approved: true, reason: 'auto' });
      return { approved: true, reason: 'auto' };
    }
    // 'on'：联网工具过审批门（人工批准）
  }
  // 通用/其余工具（read/write/edit/list/shell、grep/glob/code_edit/inspect_image、github_* 等）：
  // 到达此处即非编程/非联网工具，由 generalToolsApproval 三态决定；未提供则回退到审批门。
  if (generalToolsApproval !== undefined) {
    if (generalToolsApproval === 'off') {
      opts.emit({ type: 'approval_resolved', runId: opts.runId, requestId: opts.requestId, approved: true });
      return { approved: true, reason: 'off' };
    }
    if (generalToolsApproval === 'auto') {
      opts.emit({ type: 'approval_requested', runId: opts.runId, requestId: opts.requestId, toolName: opts.toolName, args: opts.args });
      opts.emit({ type: 'approval_resolved', runId: opts.runId, requestId: opts.requestId, approved: true, reason: 'auto' });
      return { approved: true, reason: 'auto' };
    }
    // 'on'：通用工具过审批门（人工批准）
  }
  opts.emit({ type: 'approval_requested', runId: opts.runId, requestId: opts.requestId, toolName: opts.toolName, args: opts.args });
  const decision = await approval.request({
    requestId: opts.requestId,
    toolName: opts.toolName,
    args: opts.args,
    sessionId: opts.sessionId,
  });
  opts.emit({ type: 'approval_resolved', runId: opts.runId, requestId: opts.requestId, approved: decision.approved });
  return decision;
}

export async function inloop(input: RunLoopInput): Promise<RunLoopResult> {
  const { runId, sessionId, model, provider, config, registry, approval, codingToolsApproval, networkToolsApproval, generalToolsApproval, history, cwd, thinkingLevel, onEvent, signal } =
    input;
  const emit = onEvent ?? (() => {});
  const messages: AgentMessage[] = [...history];
  let usage: Usage = emptyUsage();
  let cancelled = false;
  /** 图片错误降级已执行（只允许一次：剥离 image 重发）。 */
  let visionFallbackDone = false;
  /** 追踪最近的 assistant 消息（含文本），供 maxTurns/错误收尾时返回。 */
  let lastAssistant: AgentMessage = newAssistantMessage();

  const abort = () => {
    cancelled = true;
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  // 推理超长兜底：reasoning 超限且无文本/工具输出时，强制收敛并提示模型直接调工具（有上限重试）。
  let reasoningRetries = 0;
  const maxReasoningRetries = 2;
  const maxReasoningChars = config.maxReasoningChars ?? 4000;
  // 委派优先模式下更低的单轮推理上限（起 worker 不需要深推理，防止模型借"自己解题"拖延）
  const DELEGATE_MAX_REASONING = 2000;
  // 是否已调用 spawn_workers（一旦调用即退出委派优先，恢复完整工具集）
  let spawned = false;
  // 委派强制未能在重试内达成（模型迟迟不调 spawn）→ 放弃委派优先，下一轮用完整工具+正常推理，避免空回复
  let delegateForceExhausted = false;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    if (cancelled) break;

    // 识别命令任务类型 → 决定本轮执行路由（工具暴露 + 推理策略）
    const contextText = buildSelectionContext(messages);
    const taskType = classifyTaskType(contextText);
    // 委派优先：worker 任务且尚未 spawn → 仅暴露 worker 工具并压低推理上限，
    // 让"起 worker"成为模型唯一可执行动作（防止推理模型拿数学题"自己解题"拖延/跑偏）；
    // spawn 一旦成功即退出委派优先，恢复完整工具集（用于后续 list_workers / 汇报）。
    const delegateMode = taskType === 'worker' && !spawned && !delegateForceExhausted;
    let toolSelection: ToolSelectionOptions | undefined = input.toolSelection;
    if (delegateMode) {
      // 只暴露 spawn_workers：避免模型先调 list_workers 造成"有调用无结果"的历史污染
      toolSelection = { only: ['spawn_workers'] };
    } else if (taskType === 'coding' && !input.toolSelection?.forceGroups) {
      toolSelection = { ...(input.toolSelection ?? {}), forceGroups: ['coding'] };
    }
    // 视觉/还原任务：禁用 browser（headless 网页工具无法操作真实画布/截图验证），强制走 computer_use 真实画布
    if (taskType === 'visual') {
      toolSelection = { ...(toolSelection ?? {}), exclude: [...(toolSelection?.exclude ?? []), 'browser'] };
    }
    const selected = selectToolDefs(registry.list(), contextText, toolSelection);
    // 识别结果透出（前端可展示"已识别：多 worker 协作任务"）
    if (turn === 0) emit({ type: 'task_type', runId, taskType });
    // 视觉/截图类任务：首轮自动截取当前屏幕并注入图像上下文（不等模型自觉调用 computer_use）。
    // 仅视觉模型生效：非视觉模型截图会被剥离，跳过以免白截。
    // 截图失败（如 Screen Recording 权限缺失）静默跳过，不阻断流程。
    if (turn === 0 && taskType === 'visual' && config.vision === true) {
      try {
        const shot = await autoScreenshotForVisualTask(registry);
        if (shot) messages.push(shot);
      } catch {
        // 自动截图非关键路径：失败不影响任务执行
      }
    }
    // 委派优先模式下收紧单轮推理上限：起 worker 不需要深推理
    const turnMaxReasoning = delegateMode ? DELEGATE_MAX_REASONING : maxReasoningChars;

    // 模型不支持视觉：剥离注入的 image_url 块（自动截图/工具结果截图），防止上游 1210 报错中断；
    // 并在 system prompt 追加提示，引导用文本手段（get_app_state/读文件）了解状态。
    const hasImageBlocks = messages.some((m) => m.content.some((b) => b.type === 'image_url'));
    let requestMessages: AgentMessage[] = messages;
    let effectiveSystemPrompt = config.systemPrompt;
    if (hasImageBlocks && config.vision !== true) {
      requestMessages = messages.map((m) =>
        m.content.some((b) => b.type === 'image_url')
          ? { ...m, content: m.content.filter((b) => b.type !== 'image_url') }
          : m,
      );
      effectiveSystemPrompt =
        config.systemPrompt +
        '\n（注意：当前模型不支持视觉，截图图像已被剥离；请用 computer_use get_app_state、读文件等文本手段了解屏幕/画布状态，并在无法看到画面时明确告知用户需要视觉模型。）';
    }

    const request = {
      model,
      systemPrompt: effectiveSystemPrompt,
      messages: requestMessages,
      tools: selected.defs,
      // 思考档位：config（engine 按设置注入）> input 直接参数
      thinkingLevel: config.thinkingLevel ?? thinkingLevel,
      // 显式保留 thinkingBudget（含 0=关闭思考）：adapter 据此决定是否启用/关闭模型思考，
      // 避免"想一大段 reasoning 才动手"；仅当未设置（undefined）时才交给模型默认。
      thinkingBudget: config.thinkingBudget !== undefined ? config.thinkingBudget : undefined,
      signal,
    };

    const stream = withStreamTimeout(await provider.streamModel(request), 90_000, 600_000);
    const assistant = newAssistantMessage();
    let textAcc = '';
    let reasoningAcc = '';
    let reasoningCharsThisTurn = 0;
    let textEmitted = false;
    let sawToolCallThisTurn = false;

    const flushText = () => {
      if (textAcc) {
        assistant.content.push({ type: 'text', text: textAcc });
        textAcc = '';
      }
    };
    const flushReasoning = () => {
      if (reasoningAcc) {
        assistant.content.push({ type: 'reasoning', text: reasoningAcc });
        reasoningAcc = '';
      }
    };

    try {
      streamLoop: for await (const ev of stream) {
        if (cancelled) break;
        switch (ev.type) {
          case 'text':
            textAcc += ev.text;
            textEmitted = true;
            // 实时逐块推送正文（content 仍整段累积，保证消息完整）
            emit({ type: 'text_delta', runId, text: ev.text });
            break;
          case 'reasoning':
            reasoningAcc += ev.text;
            reasoningCharsThisTurn += ev.text.length;
            // 实时逐块推送思考过程，前端可边想边显示
            emit({ type: 'reasoning_delta', runId, text: ev.text });
            // 推理超长且尚无任何文本/工具输出 → 停止等待，强制收敛（后续按"未完成"注入提示重试）
            if (!textEmitted && !sawToolCallThisTurn && reasoningCharsThisTurn > turnMaxReasoning) {
              break streamLoop;
            }
            break;
          case 'tool_call':
            sawToolCallThisTurn = true;
            assistant.content.push({
              type: 'tool_call',
              id: ev.id,
              name: ev.name,
              args: parseToolArgs(ev.arguments),
            });
            break;
          case 'usage':
            usage = { ...usage, ...ev.usage, total_tokens: ev.usage.total_tokens || usage.total_tokens };
            emit({ type: 'usage', runId, usage });
            break;
          case 'done':
            break;
        }
      }
    } catch (err) {
      // 图片相关错误（模型标注支持视觉但上游拒绝/格式问题）：剥离图像降级重发一次，避免任务中断
      const errMsg = err instanceof Error ? err.message : String(err);
      const hasImgNow = messages.some((m) => m.content.some((b) => b.type === 'image_url'));
      if (!visionFallbackDone && hasImgNow && /1210|图片|vision|image/i.test(errMsg)) {
        visionFallbackDone = true;
        // 原地剥离全部 image_url 块，下一轮不带图重发
        for (let i = 0; i < messages.length; i++) {
          if (messages[i] && messages[i].content.some((b) => b.type === 'image_url')) {
            messages[i] = { ...messages[i]!, content: messages[i]!.content.filter((b) => b.type !== 'image_url') };
          }
        }
        continue;
      }
      // 模型流挂起（SSE 中途不结束）但已产出部分内容：当作本轮自然结束，保留产出继续下一轮，
      // 避免任务永久卡死；完全无产出时走下方错误终止。
      const isStreamHang = /模型流(空闲超时|总时长超时)/.test(errMsg);
      const hasPartial = assistant.content.length > 0 || Boolean(textAcc) || Boolean(reasoningAcc);
      if (isStreamHang && hasPartial) {
        flushText();
        flushReasoning();
        if (assistant.content.length > 0) {
          lastAssistant = assistant;
          messages.push(assistant);
        }
        continue;
      }
      if (cancelled || (signal?.aborted ?? false)) {
        flushText();
        flushReasoning();
        if (assistant.content.length > 0) lastAssistant = assistant;
        messages.push(assistant);
        emit({ type: 'cancelled', runId });
        return { message: lastAssistant, usage, turns: turn + 1, cancelled: true };
      }
      emit({ type: 'error', runId, message: err instanceof Error ? err.message : String(err) });
      flushText();
      flushReasoning();
      if (assistant.content.length > 0) lastAssistant = assistant;
      messages.push(assistant);
      // 出错也把已生成的 assistant 入史，供前端展示；停止本轮
      return { message: lastAssistant, usage, turns: turn + 1, cancelled: false };
    }

    flushText();
    flushReasoning();
    messages.push(assistant);
    if (assistant.content.length > 0) lastAssistant = assistant;

    // 委派优先判定：本轮是否已调用 spawn_workers；一旦成功即退出委派优先（恢复完整工具集）
    const spawnCalledThisTurn = hasToolCalls(assistant) && toolCalls(assistant).some((c) => c.name === 'spawn_workers');
    if (spawnCalledThisTurn) spawned = true;
    const delegatePending = taskType === 'worker' && !spawned && !delegateForceExhausted;

    // 未完成判定 → 注入提示并重试（有上限）：
    //  - 委派优先模式下，只要还没调用 spawn_workers 就重试（强制委派，禁止"自己解题"或直接作答）；
    //  - 普通模式下，仅"推理超长被强制收敛 / 只输出 reasoning 而无文本与工具调用"才重试。
    const incomplete = delegatePending || (!hasToolCalls(assistant) && !textEmitted);
    if (!cancelled && incomplete && reasoningRetries < maxReasoningRetries) {
      reasoningRetries++;
      messages.push(
        newUserMessage(
          'user',
          delegatePending
            ? '（系统提示）此任务已识别为多 worker/子 agent 协作。请调用 spawn_workers 工具真实启动 worker：tasks 按角色拆分（第 1 个解决目标，后续用 {w1}/{w2} 引用前序输出），不要自己直接解题。'
            : '（系统提示）你只输出了推理过程，没有给出回答或发起工具调用。请直接给出最终回答，或发起合适的工具调用来完成用户请求；若需要某个工具但列表中缺失，请直接写出该工具名。',
        ),
      );
      continue;
    }

    // 委派强制未能在重试内达成（仍 pending、无 spawn）：放弃委派优先并进入下一轮，
    // 下一轮用完整工具集+正常推理——模型可重新决策（spawn 或直接作答/澄清），避免空回复收尾。
    if (delegatePending && !cancelled) {
      delegateForceExhausted = true;
      continue;
    }

    // 委派强制未能在重试内达成（仍 pending、无 spawn）：放弃委派优先，
    // 下一轮用完整工具集+正常推理——模型可重新决策（spawn 或直接作答/澄清），避免空回复收尾。
    if (delegatePending && !cancelled) {
      delegateForceExhausted = true;
    }

    if (config.stopCondition && config.stopCondition(messages, assistant.role)) {
      break;
    }

    if (!hasToolCalls(assistant)) {
      emit({ type: 'complete', runId, message: assistant, usage });
      return { message: assistant, usage, turns: turn + 1, cancelled: false };
    }

    const calls = toolCalls(assistant);
    for (const call of calls) {
      if (cancelled) break;
      const requestId = generateId('approval');

      // 审批钩子
      if (config.hooks?.beforeToolCall) {
        const early = config.hooks.beforeToolCall(call.name, call.args);
        if (early) {
          emit({ type: 'approval_resolved', runId, requestId, approved: true });
          emit({ type: 'tool_result', runId, id: call.id, name: call.name, result: early.result, isError: early.is_error });
          messages.push(newToolMessage(call.id, early.result, early.is_error));
          await attachImagesFromResult(messages[messages.length - 1] as AgentMessage, early.result, cwd);
          continue;
        }
      }

      const decision = await approvalFor(approval, codingToolsApproval, networkToolsApproval, generalToolsApproval, call.name, {
        requestId,
        toolName: call.name,
        args: call.args,
        sessionId,
        emit,
        runId,
      });

      let resultText: string;
      let isError: boolean;
      let costMs: number | undefined;
      if (!decision.approved) {
        resultText = `user rejected tool \`${call.name}\`${decision.reason ? `: ${decision.reason}` : ''}`;
        isError = true;
      } else {
        const prepared = config.hooks?.prepareToolCall ? config.hooks.prepareToolCall(call.name, call.args) : call.args;
        const t0 = Date.now();
        const res = await registry.execute(call.name, prepared, { signal, cwd });
        costMs = Date.now() - t0;
        resultText = res.result;
        isError = res.is_error;
        if (config.hooks?.finalizeToolCall) {
          const fin = config.hooks.finalizeToolCall(call.name, resultText, isError ? new Error(resultText) : null);
          if (fin) {
            resultText = fin.result;
            isError = fin.error !== null;
          }
        }
      }
      emit({ type: 'tool_result', runId, id: call.id, name: call.name, result: resultText, isError, costMs });
      messages.push(newToolMessage(call.id, resultText, isError));
      await attachImagesFromResult(messages[messages.length - 1] as AgentMessage, resultText, cwd);
    }
  }

  // 达到 maxTurns 或中途取消停止
  if (cancelled) {
    emit({ type: 'cancelled', runId });
    return { message: lastAssistant, usage, turns: config.maxTurns, cancelled: true };
  }
  emit({ type: 'complete', runId, message: lastAssistant, usage });
  return { message: lastAssistant, usage, turns: config.maxTurns, cancelled };
}
