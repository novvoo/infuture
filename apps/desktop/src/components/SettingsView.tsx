import React, { useState } from 'react';
import { useAppState, useAppApi } from '../state';
import { LLMSetupModal } from './LLMSetupModal';
import { SearchConfigModal } from './SearchConfigModal';

/**
 * Settings 视图 — 一致性配置（mastary 设计吸收）：
 * 沙箱 / 审批 / 轮数 / LLM 一处配齐；工作区目录在文件面板切换。
 */
export function SettingsView() {
  const { settings, auth, doctor, busy } = useAppState();
  const { updateSettings } = useAppApi();
  const [llmOpen, setLlmOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const s = settings ?? {};

  const setTier = (sandboxTier: string) => void updateSettings({ sandboxTier: sandboxTier as never });
  const setCoding = (codingToolsApproval: 'on' | 'auto' | 'off') => void updateSettings({ codingToolsApproval });
  const setNetwork = (networkToolsApproval: 'on' | 'auto' | 'off') => void updateSettings({ networkToolsApproval });
  const setGeneral = (generalToolsApproval: 'on' | 'auto' | 'off') => void updateSettings({ generalToolsApproval });

  const settingsRow = (
    <div className="settings-row">
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
  );

  const codingRow = (
    <div className="settings-row">
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
  );

  const generalRow = (
    <div className="settings-row">
      <div>
        <div className="l">通用工具审批</div>
        <div className="d">文件/执行/检索/GitHub 等其余工具（默认自动审批，不弹窗）</div>
      </div>
      <select className="select" style={{ width: 130 }} value={s.generalToolsApproval ?? 'auto'} onChange={(e) => setGeneral(e.target.value as 'on' | 'auto' | 'off')}>
        <option value="on">需审批</option>
        <option value="auto">自动审批</option>
        <option value="off">完全执行</option>
      </select>
    </div>
  );

  const networkRow = (
    <div className="settings-row">
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
  );

  const turnsRow = (
    <div className="settings-row">
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
  );

  const llmRow = (
    <div className="settings-row">
      <div>
        <div className="l">LLM 配置</div>
        <div className="d">模型完全自定义：id / API 协议 / Base URL / Key</div>
      </div>
      <button className="btn sm" onClick={() => setLlmOpen(true)}>配置…</button>
    </div>
  );

  return (
    <div className="worker-panel">
      <h3 style={{ marginTop: 0 }}>设置</h3>

      <div className="settings-card">
        <div style={{ fontWeight: 700, marginBottom: 8 }}>运行时</div>
        {settingsRow}
        {codingRow}
        {networkRow}
        {generalRow}
        {turnsRow}
      </div>

      <div className="settings-card">
        <div style={{ fontWeight: 700, marginBottom: 8 }}>模型与凭据</div>
        {llmRow}
        <div className="settings-row">
          <div>
            <div className="l">搜索配置</div>
            <div className="d">web_search 默认引擎 + provider key（免费项自动启用）</div>
          </div>
          <button className="btn sm" onClick={() => setSearchOpen(true)}>配置…</button>
        </div>
        <div className="settings-row">
          <div>
            <div className="l">已配置模型</div>
            <div className="d">当前 {s.defaultModel ? `默认模型 ${s.defaultModel}` : '未设置默认模型'}</div>
          </div>
          <span className="badge accent" style={{ fontSize: 10 }}>{auth ? `${Object.keys(auth.credentials ?? {}).length} provider 凭据` : '无凭据'}</span>
        </div>
      </div>

      <div className="settings-card">
        <div style={{ fontWeight: 700, marginBottom: 8 }}>环境</div>
        <div className="settings-row">
          <div>
            <div className="l">infuture 编程能力</div>
            <div className="d">工作区目录在「文件」面板切换</div>
          </div>
          <span className={`badge ${doctor ? (doctor.programming ? 'ok' : 'err') : 'accent'}`}>{doctor ? (doctor.programming ? '可用' : '缺失') : '…'}</span>
        </div>
        {busy && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>agent 运行中，部分配置稍后生效</div>}
      </div>

      {llmOpen && <LLMSetupModal onClose={() => setLlmOpen(false)} />}
      {searchOpen && <SearchConfigModal onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
