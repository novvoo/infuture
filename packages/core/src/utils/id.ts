/** 工具函数：ID 生成、目录定位。对应 Rust `utils`。 */
import os from 'node:os';
import path from 'node:path';

let seq = 0;

/** 生成短随机 ID（如 run_xxxx）。 */
export function generateId(prefix = 'id'): string {
  seq = (seq + 1) % 0xffff;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}${seq.toString(36)}`;
}

/** 会话条目 ID。 */
export function generateEntryId(): string {
  return `entry_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 默认配置目录：~/.future/agent */
export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.future', 'agent');
}

/** 默认会话目录：~/.future/agent/sessions */
export function defaultSessionDir(): string {
  return path.join(defaultConfigDir(), 'sessions');
}
