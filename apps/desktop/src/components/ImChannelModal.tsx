import React, { useEffect, useState } from 'react';
import { useAppState, useAppApi } from '../state';
import type { ChannelStatus, ChannelStatusEntry } from '../types';

const STATE_META: Record<ChannelStatusEntry['state'], { text: string; color: string }> = {
  stopped: { text: '已停止', color: 'var(--text-dim, #888)' },
  starting: { text: '连接中…', color: 'var(--amber, #fbbf24)' },
  running: { text: '已连接', color: 'var(--green, #6ee7b7)' },
  error: { text: '错误', color: 'var(--red, #f87171)' },
};

function StateBadge({ entry }: { entry: ChannelStatusEntry }) {
  const meta = STATE_META[entry.state] ?? STATE_META.stopped;
  return (
    <span className="badge" style={{ color: meta.color, borderColor: meta.color, fontSize: 10 }}>
      {meta.text}
    </span>
  );
}

/** IM 通道菜单：配置飞书/钉钉凭证，启停 IM 桥接（channel.* RPC）。 */
export function ImChannelModal({ onClose }: { onClose: () => void }) {
  const { channelStatus, busy } = useAppState();
  const { loadChannel, saveChannel, startChannel, stopChannel } = useAppApi();

  const [feishu, setFeishu] = useState({ appId: '', appSecret: '', useWebSocket: true });
  const [dingtalk, setDingtalk] = useState({ appKey: '', appSecret: '' });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 打开时拉取配置与状态（仅一次）
  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    void (async () => {
      try {
        const { config } = await loadChannel();
        setFeishu((f) => ({ ...f, appId: config.feishu?.appId ?? '', useWebSocket: config.feishu?.useWebSocket ?? true }));
        setDingtalk((d) => ({ ...d, appKey: config.dingtalk?.appKey ?? '' }));
      } catch {
        /* 忽略，保持默认 */
      }
    })();
  }, [loaded, loadChannel]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const patch: { feishu?: Record<string, unknown>; dingtalk?: Record<string, unknown> } = {};
      const fAppId = feishu.appId.trim();
      const fSecret = feishu.appSecret.trim();
      if (fAppId || fSecret) {
        patch.feishu = { appId: fAppId, useWebSocket: feishu.useWebSocket };
        if (fSecret && fSecret !== '••••••') patch.feishu.appSecret = fSecret;
      }
      const dKey = dingtalk.appKey.trim();
      const dSecret = dingtalk.appSecret.trim();
      if (dKey || dSecret) {
        patch.dingtalk = { appKey: dKey };
        if (dSecret && dSecret !== '••••••') patch.dingtalk.appSecret = dSecret;
      }
      await saveChannel(patch as never);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const run = async (channel: 'feishu' | 'dingtalk', action: 'start' | 'stop') => {
    setMsg(null);
    try {
      if (action === 'start') await startChannel(channel);
      else await stopChannel(channel);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const status: ChannelStatus | null = channelStatus;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: 560, maxHeight: '86vh', overflow: 'auto' }}>
        <h2>IM 通道</h2>
        <div className="sub">
          把 infuture 接到 IM 机器人：IM 里发消息即进入同一套 Engine 会话（支持 /approve /reject 审批指令）。凭证保存到本地配置文件
          <code style={{ fontSize: 10 }}> ~/.future/agent/channels.json</code>，不随 RPC 回传明文。
        </div>

        {/* 飞书 */}
        <div className="setting-row" style={{ marginTop: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="l">
              飞书 {status?.feishu && <StateBadge entry={status.feishu} />}
            </div>
            <div className="d">自建应用：凭 App ID / App Secret，选「长连接」免公网回调，或 Webhook 模式</div>
          </div>
          <select
            className="select"
            style={{ width: 130 }}
            value={feishu.useWebSocket ? 'ws' : 'webhook'}
            onChange={(e) => setFeishu((f) => ({ ...f, useWebSocket: e.target.value === 'ws' }))}
          >
            <option value="ws">长连接（推荐）</option>
            <option value="webhook">Webhook</option>
          </select>
        </div>
        <div className="setting-row">
          <div style={{ flex: 1 }}>
            <div className="l">App ID</div>
            <input
              className="input"
              style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="cli_xxxxxxxx"
              value={feishu.appId}
              onChange={(e) => setFeishu((f) => ({ ...f, appId: e.target.value }))}
            />
          </div>
        </div>
        <div className="setting-row">
          <div style={{ flex: 1 }}>
            <div className="l">App Secret</div>
            <input
              className="input"
              style={{ width: '100%', boxSizing: 'border-box' }}
              type="password"
              placeholder={status?.feishu?.hasConfig ? '已保存，留空不变' : 'app secret'}
              value={feishu.appSecret}
              onChange={(e) => setFeishu((f) => ({ ...f, appSecret: e.target.value }))}
            />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, margin: '6px 0 4px' }}>
          {status?.feishu?.detail && (
            <div style={{ fontSize: 11, color: 'var(--red, #f87171)', flex: 1, textAlign: 'left', alignSelf: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status.feishu.detail}>
              {status.feishu.detail}
            </div>
          )}
          <button className="btn ghost" disabled={!status?.feishu?.hasConfig || status?.feishu?.state === 'running' || status?.feishu?.state === 'starting'} onClick={() => void run('feishu', 'start')}>
            启动
          </button>
          <button className="btn ghost" disabled={!status?.feishu || status?.feishu.state === 'stopped'} onClick={() => void run('feishu', 'stop')}>
            停止
          </button>
        </div>

        <div style={{ borderTop: '1px solid var(--border, #2a2f3a)', margin: '12px 0' }} />

        {/* 钉钉 */}
        <div className="setting-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="l">
              钉钉 {status?.dingtalk && <StateBadge entry={status.dingtalk} />}
            </div>
            <div className="d">机器人 App Key / App Secret。当前为简化实现（凭证校验 + 发送），消息接收待后续接入</div>
          </div>
        </div>
        <div className="setting-row">
          <div style={{ flex: 1 }}>
            <div className="l">App Key</div>
            <input
              className="input"
              style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="dingxxxxxxxx"
              value={dingtalk.appKey}
              onChange={(e) => setDingtalk((d) => ({ ...d, appKey: e.target.value }))}
            />
          </div>
        </div>
        <div className="setting-row">
          <div style={{ flex: 1 }}>
            <div className="l">App Secret</div>
            <input
              className="input"
              style={{ width: '100%', boxSizing: 'border-box' }}
              type="password"
              placeholder={status?.dingtalk?.hasConfig ? '已保存，留空不变' : 'app secret'}
              value={dingtalk.appSecret}
              onChange={(e) => setDingtalk((d) => ({ ...d, appSecret: e.target.value }))}
            />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, margin: '6px 0 4px' }}>
          {status?.dingtalk?.detail && (
            <div style={{ fontSize: 11, color: 'var(--red, #f87171)', flex: 1, textAlign: 'left', alignSelf: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status.dingtalk.detail}>
              {status.dingtalk.detail}
            </div>
          )}
          <button className="btn ghost" disabled={!status?.dingtalk?.hasConfig || status?.dingtalk?.state === 'running' || status?.dingtalk?.state === 'starting'} onClick={() => void run('dingtalk', 'start')}>
            启动
          </button>
          <button className="btn ghost" disabled={!status?.dingtalk || status?.dingtalk.state === 'stopped'} onClick={() => void run('dingtalk', 'stop')}>
            停止
          </button>
        </div>

        {msg && (
          <div style={{ fontSize: 12, color: msg.ok ? 'var(--green, #6ee7b7)' : 'var(--red, #f87171)', marginTop: 10 }}>
            {msg.text}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14, alignItems: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--text-dim, #888)', flex: 1 }}>
            提示：在飞书开放平台创建「自建应用」，开通「机器人」能力并启用长连接事件订阅。
          </div>
          <button className="btn ghost" onClick={onClose}>关闭</button>
          <button className="btn" disabled={busy || saving} onClick={() => void save()}>
            {saved ? '✓ 已保存' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  );
}
