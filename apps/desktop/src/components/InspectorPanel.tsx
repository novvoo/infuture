import React, { useState } from 'react';
import { useAppState } from '../state';

/** Inspector — 运行详情/能力状态/工具调用日志。
 *  支持 docked / 浮动窗口（mastery layout-state 悬浮模式）。 */
export function InspectorPanel() {
  const { runLog, doctor, currentSessionId, settings, busy } = useAppState();
  const [floating, setFloating] = useState(false);

  const sandboxLabel = (settings?.sandboxTier ?? 'manual') === 'sandbox' ? 'sandbox' : settings?.sandboxTier ?? 'manual';

  return (
    <aside className={`inspector ${floating ? 'float' : ''}`}>
      <div className="inspector-toolbar">
        <button
          className="btn ghost sm"
          title={floating ? '停靠回侧栏' : '浮动为独立窗口'}
          onClick={() => setFloating((f) => !f)}
        >
          {floating ? '⤷ 停靠' : '⤢ 浮动'}
        </button>
      </div>
      <h3>能力状态</h3>
      <div className="kv">
        <span className="k">编程能力</span>
        <span className="v">
          {doctor ? (
            <span className={`badge ${doctor.programming ? 'ok' : 'err'}`}>{doctor.programming ? '可用' : '缺失'}</span>
          ) : (
            <span className="badge accent">…</span>
          )}
        </span>
      </div>
      <div className="kv">
        <span className="k">通用工具</span>
        <span className="v">{doctor ? doctor.tools - doctor.codingTools : '—'}</span>
      </div>
      <div className="kv">
        <span className="k">编程工具</span>
        <span className="v">{doctor ? doctor.codingTools : '—'}</span>
      </div>
      <div className="kv">
        <span className="k">沙箱</span>
        <span className="v">
          <span className={`badge ${sandboxLabel === 'off' ? 'ok' : sandboxLabel === 'sandbox' ? 'accent' : 'warn'}`}>{sandboxLabel}</span>
        </span>
      </div>
      <div className="kv">
        <span className="k">编码审批</span>
        <span className="v">
          <span className={`badge ${(settings?.codingToolsApproval ?? 'on') === 'on' ? 'warn' : (settings?.codingToolsApproval ?? 'on') === 'auto' ? 'accent' : 'ok'}`}>
            {(settings?.codingToolsApproval ?? 'on') === 'on' ? '需审批' : (settings?.codingToolsApproval ?? 'on') === 'auto' ? '自动审批' : '完全执行'}
          </span>
        </span>
      </div>
      <div className="kv">
        <span className="k">联网审批</span>
        <span className="v">
          <span className={`badge ${(settings?.networkToolsApproval ?? 'on') === 'on' ? 'warn' : (settings?.networkToolsApproval ?? 'on') === 'auto' ? 'accent' : 'ok'}`}>
            {(settings?.networkToolsApproval ?? 'on') === 'on' ? '需审批' : (settings?.networkToolsApproval ?? 'on') === 'auto' ? '自动审批' : '完全执行'}
          </span>
        </span>
      </div>
      <div className="kv">
        <span className="k">搜索引擎</span>
        <span className="v">
          <span className="badge accent">{(settings?.searchProvider ?? 'auto') === 'auto' ? '自动' : settings?.searchProvider ?? 'auto'}</span>
        </span>
      </div>
      <div className="kv">
        <span className="k">会话</span>
        <span className="v">{currentSessionId ? currentSessionId.slice(0, 12) : '—'}</span>
      </div>
      <div className="kv">
        <span className="k">状态</span>
        <span className="v">
          <span className={`badge ${busy ? 'warn' : 'ok'}`}>{busy ? '运行中' : '就绪'}</span>
        </span>
      </div>

      <h3>运行日志</h3>
      {runLog.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: '8px 0' }}>暂无运行活动</div>
      )}
      {runLog.map((item, i) => (
        <div key={i} style={{ marginBottom: 8, fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={`badge ${item.kind === 'error' ? 'err' : item.kind === 'tool_call' ? 'warn' : 'accent'}`}>
              {item.kind === 'tool_call' ? '⚙' : item.kind === 'tool_result' ? (item.isError ? '✗' : '✓') : item.kind === 'error' ? '✕' : '∑'}
            </span>
            {item.coding && <span className="badge code">{item.kind === 'tool_call' ? 'code' : '·'}</span>}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{item.label}</span>
          </div>
          <div className="tool-result" style={{ marginLeft: 22 }}>{item.detail}</div>
        </div>
      ))}
    </aside>
  );
}
