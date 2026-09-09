/**
 * 上下文压缩（context compaction）— 吸收自 oh-my-pi（omp）的 compaction 思路的轻量实现。
 *
 * 目标：长任务（多轮工具循环）消息无限累积，一旦超过模型窗口 provider 即报错/异常。
 * 机制（保留 omp 最小闭环）：
 *   1. 估算：estimateTokens 对消息序列做近似 token 估算（中英混合 + 安全边际）；
 *   2. 触发：每轮请求前，估算上下文占用 ≥ 窗口×thresholdRatio 时压缩；
 *   3. 剪切：findCompactionCut 从尾部按 keepRecentTokens 预算保留最近消息，
 *      切点调整到整轮边界（不拆 tool_result 与其 tool_call 的配对）；
 *   4. 摘要：compactHistory 用当前 provider 把更早历史 LLM 摘要为一段文本，
 *      替换为一条 role=system 的摘要消息（旧摘要也纳入合并，迭代更新）；
 *   5. 降级：摘要失败/超时 → 跳过压缩不阻断任务（有界：180s 超时）。
 */
import type { AgentMessage } from '@infuture/types';
import { newUserMessage } from '@infuture/types';
import type { LLMProvider } from '@infuture/llm';
import type { RunEventCallback } from './events.js';

/** 近似 token 估算：中文/全角字符 ≈1 token，其余 ≈ 4 字符/token，加安全边际。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0x3000 && code <= 0x303f) || // CJK 标点
      (code >= 0xff00 && code <= 0xffef) // 全角
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  // 中文 ≈1 token/字；其余按 4 字符/token（OpenAI/GLM 近似）；空行/结构符号有损耗，乘 1.15 安全边际
  return Math.ceil((cjk + other / 4) * 1.15);
}

/** 单条消息的 token 估算（text + tool_result 内容；image 按固定 800 token 计）。 */
export function estimateMessageTokens(m: AgentMessage): number {
  let sum = 0;
  for (const b of m.content) {
    if (b.type === 'text') sum += estimateTokens(b.text);
    else if (b.type === 'tool_result') sum += estimateTokens(b.content);
    else if (b.type === 'reasoning') sum += estimateTokens(b.text);
    else if (b.type === 'image_url') sum += 800;
    else if (b.type === 'tool_call') sum += estimateTokens(JSON.stringify(b.args ?? {}).slice(0, 2000));
  }
  return sum;
}

/** 消息序列 + 附加文本（systemPrompt、工具定义等）的总估算。 */
export function estimateMessagesTokens(msgs: AgentMessage[], extraTexts: string[] = []): number {
  let sum = extraTexts.reduce((acc, t) => acc + estimateTokens(t), 0);
  for (const m of msgs) sum += estimateMessageTokens(m);
  return sum;
}

export interface CompactionCut {
  /** 要摘要的历史消息（[0, cutIndex)），保留 [cutIndex, end)。 */
  cutIndex: number;
  /** 保留的最近消息 token 估算。 */
  keptTokens: number;
  /** 是否存在可摘要的历史（否则无需压缩）。 */
  hasHistory: boolean;
}

/**
 * 找剪切点：从尾部向前累计到 keepRecentTokens 预算，切点调整到整轮边界。
 * 规则（对齐 omp findValidCutPoints/findTurnStartIndex 的核心约束）：
 *   - 不切在 tool_result 上（其必须紧跟配对的 tool_call）；切 assistant(带 tool_call) 时
 *     其后的 tool_result 会一并保留；
 *   - 切点优先落在 user / assistant 消息上；
 *   - 至少保留最近 2 条消息，避免极端压缩。
 */
export function findCompactionCut(msgs: AgentMessage[], keepRecentTokens: number): CompactionCut {
  if (msgs.length <= 2) return { cutIndex: 0, keptTokens: estimateMessagesTokens(msgs), hasHistory: false };

  let acc = 0;
  let cut = msgs.length; // 初始假设全保留
  for (let i = msgs.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(msgs[i]!);
    if (acc >= keepRecentTokens || msgs.length - i >= 200) {
      // 预算已用尽（或保留消息数封顶 200 条）→ 候选切点在此
      cut = i;
      break;
    }
  }
  if (cut >= msgs.length) {
    // 整个序列都没达到保留预算 → 无需压缩
    return { cutIndex: 0, keptTokens: estimateMessagesTokens(msgs), hasHistory: false };
  }
  if (cut <= 1) cut = 1; // 至少保留最后 1 条

  // 向上调整到合法切点：跳过 tool_result（它必须跟在 tool_call 后）
  let idx = cut;
  while (idx > 0) {
    const role = msgs[idx]!.role;
    if (role === 'tool') {
      idx--;
      continue;
    }
    break;
  }
  // 若切点落在 assistant 消息中间（其后还有同一轮的 tool_result 配对），
  // 前移切点到该 assistant 消息之前：不把 tool_call 与其 tool_result 拆开
  while (idx > 0 && msgs[idx]!.role === 'assistant' && msgs[idx + 1]?.role === 'tool') {
    idx--;
  }

  const cutIndex = Math.max(0, idx);
  const hasHistory = cutIndex > 0;
  const kept = msgs.slice(cutIndex);
  return { cutIndex, keptTokens: estimateMessagesTokens(kept), hasHistory };
}

/** 摘要请求的 system prompt：要求输出纯文本摘要（后续轮次据此继续任务）。 */
export const SUMMARY_SYSTEM_PROMPT =
  '你是一个会话压缩器。下面是同一个 agent 会话中较早的对话历史（可能是已压缩的摘要 + 新增消息）。' +
  '请把它们压缩为一段精炼但信息完整的摘要，要求：\n' +
  '1. 保留：用户的目标与关键需求、已完成的步骤与结论、读取/修改的文件路径与关键内容、' +
  '执行过的命令与结果、遇到并解决的问题、尚未完成的事项、所有明确承诺/待办。\n' +
  '2. 面向"后续轮次继续执行任务"而写：让一个没有看过原对话的 agent 仅凭摘要就能继续工作。\n' +
  '3. 若历史包含旧的压缩摘要，把旧摘要与新消息合并更新，不要重复堆叠。\n' +
  '4. 只输出摘要正文，不要任何解释、标题层级或格式包装（可用纯文本列表）。';

export interface CompactContextOptions {
  /** 当前模型 id（摘要也用它生成）。 */
  model: string;
  provider: LLMProvider;
  systemPrompt: string;
  contextWindow: number;
  /** 触发阈值比例（默认 0.85）。 */
  thresholdRatio?: number;
  /** 保留最近 token 预算（默认 20000）。 */
  keepRecentTokens?: number;
  thinkingLevel?: string;
  thinkingBudget?: number;
  onEvent?: RunEventCallback;
  signal?: AbortSignal;
  runId: string;
}

export interface CompactContextResult {
  /** 是否实际执行了压缩。 */
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  keptMessages: number;
}

/**
 * 是否需要压缩：估算（消息 + systemPrompt + 工具定义）占用 ≥ 窗口×ratio。
 * 保留窗口×10% 的余量给响应输出。
 */
export function needsCompaction(
  msgs: AgentMessage[],
  opts: Pick<CompactContextOptions, 'contextWindow' | 'thresholdRatio' | 'systemPrompt'> & { toolSpecText?: string },
): boolean {
  const window = opts.contextWindow;
  if (window <= 0) return false;
  const ratio = opts.thresholdRatio ?? 0.85;
  const threshold = Math.floor(window * ratio);
  const used = estimateMessagesTokens(msgs, [opts.systemPrompt, opts.toolSpecText ?? '']);
  return used >= threshold;
}

/** 摘要请求的总超时（摘要是后台动作，不可无限等待；有界 180s）。 */
const SUMMARY_TIMEOUT_MS = 180_000;
const SUMMARY_IDLE_MS = 60_000;

/** 提取摘要消息文本（第一条 system 摘要消息）。 */
export function findSummaryMessage(msgs: AgentMessage[]): AgentMessage | undefined {
  return msgs.find((m) => m.role === 'system' && m.metadata?.compacted === true);
}

/**
 * 执行压缩：把 [0, cutIndex) 的历史（含旧摘要，若有）交给模型生成合并摘要，
 * 原地把 messages 重组为 [摘要消息, ...保留消息]。
 *
 * 摘要失败/超时/被取消 → 返回 compacted:false 且不修改 messages（不阻断任务）。
 */
export async function compactContext(
  messages: AgentMessage[],
  opts: CompactContextOptions,
): Promise<CompactContextResult> {
  const window = opts.contextWindow;
  if (window <= 0) return { compacted: false, tokensBefore: 0, tokensAfter: 0, keptMessages: messages.length };
  const keepRecentTokens = opts.keepRecentTokens ?? 20_000;
  const tokensBefore = estimateMessagesTokens(messages, [opts.systemPrompt]);

  const cut = findCompactionCut(messages, keepRecentTokens);
  if (!cut.hasHistory) return { compacted: false, tokensBefore, tokensAfter: tokensBefore, keptMessages: messages.length };

  const historyToSummarize = messages.slice(0, cut.cutIndex);
  const kept = messages.slice(cut.cutIndex);

  // 摘要请求：无工具、低思考强度、有界超时；失败静默降级
  let summary = '';
  try {
    const signal = opts.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)])
      : opts.signal;
    const stream = await opts.provider.streamModel({
      model: opts.model,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: historyToSummarize,
      tools: [],
      thinkingLevel: opts.thinkingLevel ?? 'low',
      thinkingBudget: opts.thinkingBudget ?? 0,
      signal,
    });
    for await (const ev of stream) {
      if (ev.type === 'text') summary += ev.text;
    }
  } catch {
    // 摘要失败/超时/取消 → 跳过压缩，不阻断主任务
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore, keptMessages: messages.length };
  }

  const trimmed = summary.trim();
  if (!trimmed) return { compacted: false, tokensBefore, tokensAfter: tokensBefore, keptMessages: messages.length };

  const summaryMsg = newUserMessage(
    'system',
    `[上下文已压缩] 为控制上下文长度，较早对话已压缩为摘要（保留最近 ${kept.length} 条消息原文）。\n\n${trimmed}`,
  );
  summaryMsg.metadata = { compacted: true };

  messages.splice(0, messages.length, summaryMsg, ...kept);
  const tokensAfter = estimateMessagesTokens(messages, [opts.systemPrompt]);
  opts.onEvent?.({
    type: 'compacted',
    runId: opts.runId,
    tokensBefore,
    tokensAfter,
    keptMessages: kept.length,
  });
  return { compacted: true, tokensBefore, tokensAfter, keptMessages: kept.length };
}
