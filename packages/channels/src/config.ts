/**
 * 通道配置 — 对应 future-os `channels/config.rs`。
 */
export interface ChannelConfig {
  /** Feishu / DingTalk app 配置。 */
  feishu?: {
    appId: string;
    appSecret: string;
    /** 长连接模式：true 用 WebSocket，false 用 Webhook。 */
    useWebSocket?: boolean;
    verifyToken?: string;
    encryptKey?: string;
  };
  dingtalk?: {
    appKey: string;
    appSecret: string;
    useWebSocket?: boolean;
  };
  /** 会话默认模型。 */
  defaultModel?: string;
}

export function loadChannelConfig(env: Record<string, string | undefined> = process.env): ChannelConfig {
  return {
    feishu: {
      appId: env.FEISHU_APP_ID ?? '',
      appSecret: env.FEISHU_APP_SECRET ?? '',
      useWebSocket: env.FEISHU_WS === '1',
      verifyToken: env.FEISHU_VERIFY_TOKEN,
      encryptKey: env.FEISHU_ENCRYPT_KEY,
    },
    dingtalk: {
      appKey: env.DINGTALK_APP_KEY ?? '',
      appSecret: env.DINGTALK_APP_SECRET ?? '',
      useWebSocket: env.DINGTALK_WS === '1',
    },
    defaultModel: env.INFUTURE_MODEL,
  };
}
