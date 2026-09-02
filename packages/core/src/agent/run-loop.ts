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
  emptyUsage,
  newAssistantMessage,
  newToolMessage,
  newUserMessage,
  toolCalls,
  hasToolCalls,
} from '@infuture/types';
import type { LLMProvider, ModelStreamEvent } from '@infuture/llm';
import type { ApprovalGate } from '../sandbox/gate.js';
import type { ToolRegistry } from '../tools/registry.js';
import { buildSelectionContext, classifyTaskType, selectToolDefs, type ToolSelectionOptions } from '../tools/selection.js';
import type { RunEventCallback } from './events.js';
import { generateId } from '../utils/id.js';

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
    const selected = selectToolDefs(registry.list(), contextText, toolSelection);
    // 识别结果透出（前端可展示"已识别：多 worker 协作任务"）
    if (turn === 0) emit({ type: 'task_type', runId, taskType });
    // 委派优先模式下收紧单轮推理上限：起 worker 不需要深推理
    const turnMaxReasoning = delegateMode ? DELEGATE_MAX_REASONING : maxReasoningChars;

    const request = {
      model,
      systemPrompt: config.systemPrompt,
      messages,
      tools: selected.defs,
      // 思考档位：config（engine 按设置注入）> input 直接参数
      thinkingLevel: config.thinkingLevel ?? thinkingLevel,
      // 显式保留 thinkingBudget（含 0=关闭思考）：adapter 据此决定是否启用/关闭模型思考，
      // 避免"想一大段 reasoning 才动手"；仅当未设置（undefined）时才交给模型默认。
      thinkingBudget: config.thinkingBudget !== undefined ? config.thinkingBudget : undefined,
      signal,
    };

    const stream = await provider.streamModel(request);
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
