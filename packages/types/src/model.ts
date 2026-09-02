/**
 * Model / ModelCost / Usage — 模型目录与用量。
 * 对应 对应 Rust `types::Model`。
 */

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function defaultModelCost(): ModelCost {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input_types?: string[];
  cost?: ModelCost;
  thinkingLevelMap?: unknown;
  headers?: Record<string, string>;
  compat?: unknown;
  hide?: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  /** 上游返回的信用成本（字符串或数字），累计用 f64。 */
  credit_cost?: number;
  provider_metadata?: Record<string, unknown>;
}

export function emptyUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/** credit_cost 可能是字符串（"0.00019"）或数字。 */
export function parseCreditCost(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}
