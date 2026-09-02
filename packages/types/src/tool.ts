/**
 * ToolDef / AgentTool / AgentConfig — 工具定义与运行配置。
 * 对应 对应 Rust `types::ToolDef` / `AgentTool` / `AgentConfig`。
 */

export interface FunctionDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolDef {
  type: string;
  function: FunctionDef;
}

export function toolDef(name: string, description: string, parameters: unknown): ToolDef {
  return { type: 'function', function: { name, description, parameters } };
}

/** 工具执行上下文（可选传给 handler，用于取消等）。 */
export interface ToolExecutionContext {
  /** 运行取消信号。handler 应据此中断长任务（如终止 shell 子进程）。 */
  signal?: AbortSignal;
  /** 本次调用的工作目录（worker worktree 隔离时覆盖工具默认 cwd）。 */
  cwd?: string;
}

/** 工具处理函数：输入参数 JSON，返回文本结果（is_error 单独标志）。 */
export type ToolHandler = (args: unknown, ctx?: ToolExecutionContext) => Promise<{ result: string; is_error: boolean }>;

/** AgentTool = 定义 + 处理函数 + 使用准则。 */
export interface AgentTool {
  def: ToolDef;
  handler: ToolHandler;
  guidelines: string[];
}

/** 工具调用结果。 */
export interface ToolCallResult {
  result: string;
  is_error: boolean;
}

export interface ToolCallHooks {
  beforeToolCall?: (name: string, args: unknown) => ToolCallResult | undefined;
  prepareToolCall?: (name: string, args: unknown) => unknown;
  finalizeToolCall?: (name: string, result: string, error: Error | null) => { result: string; error: Error | null };
  afterToolCall?: (name: string, args: unknown, result: string, error: Error | null) => ToolCallResult | undefined;
}

export interface AgentConfig {
  systemPrompt: string;
  maxTurns: number;
  thinkingBudget: number;
  /** 统一思考档位：off | low | medium | high | max。adapter 按模型能力映射（GLM→low/high/max 等）。 */
  thinkingLevel?: string;
  maxRetries: number;
  stopCondition?: (messages: unknown[], lastRole: string) => boolean;
  toolsExecutionMode: 'parallel' | 'sequential';
  /** 单轮 reasoning 字符数上限：超限且仍无任何文本/工具调用时强制收敛。默认 30000——只兜底病态无限推理；深推理任务（如 worker 解题）不应被掐断。委派优先模式另有更低的专用上限。 */
  maxReasoningChars?: number;
  hooks?: ToolCallHooks;
}

export function defaultAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    systemPrompt: '',
    maxTurns: 10,
    thinkingBudget: 0,
    maxRetries: 3,
    toolsExecutionMode: 'parallel',
    maxReasoningChars: 30000,
    ...overrides,
  };
}

/** 本地文件附件（GUI）。agent 保留绝对路径按需读取。 */
export interface Attachment {
  path: string;
  kind: 'image' | 'file';
  name: string;
  thumbnail?: string;
}
