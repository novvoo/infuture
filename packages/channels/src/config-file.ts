/**
 * 通道配置文件读写 — ~/.future/agent/channels.json
 * 供桌面端在 web 里配置 IM 凭证并持久化；环境变量（loadChannelConfig）仍可覆盖，env 优先。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ChannelConfig } from './config.js';

/** 默认通道配置文件路径（与 engine 配置目录一致：~/.future/agent）。 */
export function defaultChannelsFile(): string {
  return path.join(os.homedir(), '.future', 'agent', 'channels.json');
}

export async function loadChannelsFile(file = defaultChannelsFile()): Promise<ChannelConfig> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(raw) as Partial<ChannelConfig>;
    return {
      feishu: json.feishu
        ? {
            appId: json.feishu.appId ?? '',
            appSecret: json.feishu.appSecret ?? '',
            useWebSocket: json.feishu.useWebSocket,
            verifyToken: json.feishu.verifyToken,
            encryptKey: json.feishu.encryptKey,
          }
        : undefined,
      dingtalk: json.dingtalk
        ? {
            appKey: json.dingtalk.appKey ?? '',
            appSecret: json.dingtalk.appSecret ?? '',
            useWebSocket: json.dingtalk.useWebSocket,
          }
        : undefined,
    };
  } catch {
    return {};
  }
}

export async function saveChannelsFile(config: ChannelConfig, file = defaultChannelsFile()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf-8');
}
