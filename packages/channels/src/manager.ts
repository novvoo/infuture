/**
 * ChannelManager — 桌面端 IM 桥接生命周期管理。
 * 持有 FeishuBridge / DingTalkBridge，提供配置持久化与状态查询，
 * 供桌面 RPC（channel.*）与 CLI 复用。
 */
import path from 'node:path';
import os from 'node:os';
import type { Engine } from '@infuture/core';
import { FeishuBridge } from './feishu/bridge.js';
import { DingTalkBridge } from './dingtalk/bridge.js';
import type { ChannelConfig } from './config.js';
import { loadChannelsFile, saveChannelsFile } from './config-file.js';

export type ChannelState = 'stopped' | 'starting' | 'running' | 'error';

export interface ChannelStatusEntry {
  state: ChannelState;
  hasConfig: boolean;
  detail?: string;
}

export interface ChannelStatus {
  feishu: ChannelStatusEntry;
  dingtalk: ChannelStatusEntry;
}

export interface ChannelManagerOptions {
  /** channels.json 所在目录（默认 ~/.future/agent）。 */
  configDir?: string;
}

/** 掩码版配置：secret 只暴露"是否已配置"，明文不回传前端。 */
export function maskChannelConfig(cfg: ChannelConfig): ChannelConfig {
  return {
    feishu: cfg.feishu
      ? {
          appId: cfg.feishu.appId ?? '',
          appSecret: cfg.feishu.appSecret ? '••••••' : '',
          useWebSocket: cfg.feishu.useWebSocket,
          verifyToken: cfg.feishu.verifyToken ? '••••••' : '',
        }
      : undefined,
    dingtalk: cfg.dingtalk
      ? {
          appKey: cfg.dingtalk.appKey ?? '',
          appSecret: cfg.dingtalk.appSecret ? '••••••' : '',
        }
      : undefined,
  };
}

export class ChannelManager {
  private config: ChannelConfig = {};
  private feishu: FeishuBridge | null = null;
  private dingtalk: DingTalkBridge | null = null;
  private feishuState: ChannelState = 'stopped';
  private feishuDetail = '';
  private dingtalkState: ChannelState = 'stopped';
  private dingtalkDetail = '';
  private readonly file: string;

  constructor(
    private readonly engine: Engine,
    options: ChannelManagerOptions = {},
  ) {
    this.file = path.join(options.configDir ?? path.join(os.homedir(), '.future', 'agent'), 'channels.json');
  }

  /** 加载配置文件到内存。 */
  async load(): Promise<void> {
    this.config = await loadChannelsFile(this.file);
  }

  /** 当前配置（掩码版，供 UI 展示）。 */
  configView(): ChannelConfig {
    return maskChannelConfig(this.config);
  }

  getStatus(): ChannelStatus {
    return {
      feishu: {
        state: this.feishuState,
        hasConfig: Boolean(this.config.feishu?.appId && this.config.feishu.appSecret),
        detail: this.feishuDetail || undefined,
      },
      dingtalk: {
        state: this.dingtalkState,
        hasConfig: Boolean(this.config.dingtalk?.appKey && this.config.dingtalk.appSecret),
        detail: this.dingtalkDetail || undefined,
      },
    };
  }

  /** 合并并持久化配置，返回掩码视图。 */
  async setConfig(patch: Partial<ChannelConfig>): Promise<ChannelConfig> {
    this.config = {
      feishu: patch.feishu ? { ...(this.config.feishu ?? {}), ...patch.feishu } : this.config.feishu,
      dingtalk: patch.dingtalk ? { ...(this.config.dingtalk ?? {}), ...patch.dingtalk } : this.config.dingtalk,
    };
    await saveChannelsFile(this.config, this.file);
    return this.configView();
  }

  async startFeishu(): Promise<void> {
    const c = this.config.feishu;
    if (!c?.appId || !c.appSecret) throw new Error('未配置飞书 App ID / App Secret');
    this.stopFeishu();
    this.feishuState = 'starting';
    this.feishuDetail = '';
    try {
      const bridge = new FeishuBridge({
        appId: c.appId,
        appSecret: c.appSecret,
        engine: this.engine,
        useWebSocket: c.useWebSocket,
        onError: (err) => {
          // 连接/凭证失败 → 标记 error（保持错误直到用户停止或重试）
          this.feishuState = 'error';
          this.feishuDetail = err.message;
        },
      });
      await bridge.start();
      // start() 已尝试首连：若首连阶段未触发 onError，视为连接建立
      if (this.feishuState === 'starting') this.feishuState = 'running';
      this.feishu = bridge;
    } catch (err) {
      this.feishuState = 'error';
      this.feishuDetail = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  stopFeishu(): void {
    this.feishu?.stop();
    this.feishu = null;
    this.feishuState = 'stopped';
    this.feishuDetail = '';
  }

  /** 钉钉为简化实现（可发送、接收需外部喂入）：验证 token 可联通即视为 running。 */
  async startDingtalk(): Promise<void> {
    const c = this.config.dingtalk;
    if (!c?.appKey || !c.appSecret) throw new Error('未配置钉钉 App Key / App Secret');
    this.stopDingtalk();
    this.dingtalkState = 'starting';
    this.dingtalkDetail = '';
    try {
      const bridge = new DingTalkBridge({ appKey: c.appKey, appSecret: c.appSecret, engine: this.engine, useWebSocket: c.useWebSocket });
      await bridge.ping();
      this.dingtalk = bridge;
      this.dingtalkState = 'running';
    } catch (err) {
      this.dingtalkState = 'error';
      this.dingtalkDetail = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  stopDingtalk(): void {
    this.dingtalk = null;
    this.dingtalkState = 'stopped';
    this.dingtalkDetail = '';
  }
}
