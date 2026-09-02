/**
 * Settings — 应用设置。对应 Rust `config::Settings`。
 * 读取 ~/.future/agent/settings.json。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultConfigDir } from '../utils/id.js';
import { parseSandboxTier, type SandboxTier } from '../sandbox/gate.js';

export interface Settings {
  defaultModel: string;
  sandboxTier: SandboxTier;
  /** 编程工具审批：on=需审批 · auto=自动审批 · off=完全执行（免审批）。 */
  codingToolsApproval: 'on' | 'auto' | 'off';
  /** 联网工具审批（browser / web_search 等）：on=需审批 · auto=自动审批 · off=免审批直行。 */
  networkToolsApproval: 'on' | 'auto' | 'off';
  /** 通用工具审批（read/write/edit/list/shell、grep/glob/code_edit/inspect_image、github_* 等其余工具）：默认 auto=自动审批（不弹窗）。 */
  generalToolsApproval: 'on' | 'auto' | 'off';
  /** 默认搜索引擎（web_search provider）：auto 自动按可用链 fallback，或显式指定 tinyfish/exa/jina/kagi/tavily/perplexity/xai/codex/gemini/anthropic/zai/tinyfish 等。 */
  searchProvider: string;
  maxTurns: number;
  thinkingBudget: number;
  /** 统一思考档位（空=未显式指定，走模型默认 + ACTION-FIRST 引导）：off | low | medium | high | max。 */
  thinkingLevel: string;
  /** 工作区根目录（绝对路径）。空 = 未指定，首次启动在系统 tmp 下创建临时目录并回填。 */
  workspaceDir: string;
  [key: string]: unknown;
}

export const DEFAULT_SETTINGS: Settings = {
  // 不内置官方模型：默认模型留空，由用户在 LLM 配置中添加并选择
  defaultModel: '',
  sandboxTier: 'manual',
  codingToolsApproval: 'on',
  networkToolsApproval: 'on',
  // 通用工具默认自动审批，避免 read/write/shell/list 等日常操作频繁弹窗
  generalToolsApproval: 'auto',
  searchProvider: 'auto',
  maxTurns: 10,
  thinkingBudget: 0,
  thinkingLevel: '',
  // 工作区：默认在系统临时目录下创建，由 Engine.resolveWorkspace 回填
  workspaceDir: '',
};

export interface SettingsOptions {
  configDir?: string;
}

export async function loadSettings(options: SettingsOptions = {}): Promise<Settings> {
  const file = path.join(options.configDir ?? defaultConfigDir(), 'settings.json');
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const tier = parseSandboxTier(String(json.sandboxTier ?? DEFAULT_SETTINGS.sandboxTier));
    return {
      ...DEFAULT_SETTINGS,
      ...json,
      sandboxTier: tier,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings, options: SettingsOptions = {}): Promise<void> {
  const file = path.join(options.configDir ?? defaultConfigDir(), 'settings.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2), 'utf-8');
}
