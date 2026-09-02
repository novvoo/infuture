import React, { useState } from 'react';
import { useAppState, useAppApi } from '../state';
import { LLMSetupModal } from './LLMSetupModal';
import { SearchConfigModal } from './SearchConfigModal';
import { ImChannelModal } from './ImChannelModal';

/** 设置菜单（侧栏底部触发）— 一致性配置：沙箱 / 审批 / 轮数 / LLM。工作区目录在文件面板切换。 */
export function SettingsMenu() {
  const { settings, busy, channelStatus } = useAppState();
  const { updateSettings } = useAppApi();
  const [open, setOpen] = useState(false);
  const [llmOpen, setLlmOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [imOpen, setImOpen] = useState(false);

  const s = settings ?? {};

  // IM 任一通道运行中 → 设置按钮显示状态点
  const imActive = !!channelStatus && (channelStatus.feishu?.state === 'running' || channelStatus.dingtalk?.state === 'running');
  const imRunning = !!channelStatus && (channelStatus.feishu?.state === 'running' || channelStatus.dingtalk?.state === 'running');

  const setTier = (sandboxTier: string) => void updateSettings({ sandboxTier: sandboxTier as never });
  const setCoding = (codingToolsApproval: 'on' | 'auto' | 'off') => void updateSettings({ codingToolsApproval });
  const setNetwork = (networkToolsApproval: 'on' | 'auto' | 'off') => void updateSettings({ networkToolsApproval });

  return (
    <div className="settings-trigger">
      {open && (
        <div className="settings-menu">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>设置</span>
            <button className="btn ghost sm" onClick={() => setOpen(false)}>✕</button>
          </div>

          <div className="setting-row">
            <div>
              <div className="l">沙箱模式</div>
              <div className="d">off：直行 · manual：审批 · sandbox：隔离执行</div>
            </div>
            <select className="select" style={{ width: 150 }} value={s.sandboxTier ?? 'manual'} onChange={(e) => setTier(e.target.value)}>
              <option value="off">off（直行）</option>
              <option value="manual">manual（审批）</option>
              <option value="sandbox">sandbox（隔离）</option>
            </select>
          </div>

          <div className="setting-row">
            <div>
              <div className="l">编程工具审批</div>
              <div className="d">编程工具（LSP/DAP/子 agent 等）：需审批 · 自动审批 · 完全执行</div>
            </div>
            <select className="select" style={{ width: 130 }} value={s.codingToolsApproval ?? 'on'} onChange={(e) => setCoding(e.target.value as 'on' | 'auto' | 'off')}>
              <option value="on">需审批</option>
              <option value="auto">自动审批</option>
              <option value="off">完全执行</option>
            </select>
          </div>

          <div className="setting-row">
            <div>
              <div className="l">联网审批</div>
              <div className="d">browser / web_search 等联网工具：需审批 · 自动审批 · 完全执行</div>
            </div>
            <select className="select" style={{ width: 130 }} value={s.networkToolsApproval ?? 'on'} onChange={(e) => setNetwork(e.target.value as 'on' | 'auto' | 'off')}>
              <option value="on">需审批</option>
              <option value="auto">自动审批</option>
              <option value="off">完全执行</option>
            </select>
          </div>

          <div className="setting-row">
            <div>
              <div className="l">最大轮数</div>
              <div className="d">单次运行的 agent 推理轮次上限</div>
            </div>
            <input
              className="input"
              type="number"
              style={{ width: 90 }}
              value={s.maxTurns ?? 8}
              onChange={(e) => void updateSettings({ maxTurns: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>

          <div className="setting-row">
            <div>
              <div className="l">LLM 配置</div>
              <div className="d">模型完全自定义：id / API 协议 / Base URL / Key</div>
            </div>
            <button className="btn sm" onClick={() => setLlmOpen(true)}>配置…</button>
          </div>

          <div className="setting-row">
            <div>
              <div className="l">搜索配置</div>
              <div className="d">web_search 默认引擎 + provider key</div>
            </div>
            <button className="btn sm" onClick={() => setSearchOpen(true)}>配置…</button>
          </div>

          <div className="setting-row">
            <div>
              <div className="l">
                IM 通道 {imRunning && <span className="badge ok" style={{ fontSize: 9 }}>运行中</span>}
              </div>
              <div className="d">飞书 / 钉钉桥接：IM 里对话与审批</div>
            </div>
            <button className="btn sm" onClick={() => setImOpen(true)}>配置…</button>
          </div>
        </div>
      )}

      <button className="rail-btn" style={{ width: 40, height: 40, position: 'relative' }} title="设置" disabled={busy} onClick={() => setOpen((o) => !o)}>
        ⚙
        {imActive && (
          <span
            style={{
              position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: '50%',
              background: 'var(--green, #6ee7b7)', boxShadow: '0 0 4px var(--green, #6ee7b7)',
            }}
          />
        )}
      </button>

      {llmOpen && <LLMSetupModal onClose={() => setLlmOpen(false)} />}
      {searchOpen && <SearchConfigModal onClose={() => setSearchOpen(false)} />}
      {imOpen && <ImChannelModal onClose={() => setImOpen(false)} />}
    </div>
  );
}
