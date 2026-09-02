import React, { useEffect, useRef } from 'react';
import { useAppState, useAppApi } from '../state';

/** 审批弹窗 — future-os ApprovalPrompt + mastery ConfirmDialog 的融合。默认批准：Enter 批准 / Esc 拒绝。 */
export function ApprovalModal() {
  const { pendingApproval } = useAppState();
  const { resolveApproval } = useAppApi();
  const resolvingRef = useRef(false);

  useEffect(() => {
    if (!pendingApproval) return;
    const onKey = (e: KeyboardEvent) => {
      if (resolvingRef.current) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        resolvingRef.current = true;
        void resolveApproval(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        resolvingRef.current = true;
        void resolveApproval(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingApproval, resolveApproval]);

  if (!pendingApproval) return null;
  const { toolName, args, requestId } = pendingApproval;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>工具调用审批</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          agent 请求执行工具 <span style={{ color: 'var(--yellow)', fontFamily: 'var(--mono)' }}>{toolName}</span>
        </p>
        <div className="mono">{JSON.stringify(args, null, 2)}</div>
        <div className="btn-row">
          <button className="btn danger" onClick={() => void resolveApproval(false)}>
            拒绝
          </button>
          <button className="btn primary" autoFocus onClick={() => void resolveApproval(true)}>
            批准 ↵
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, fontFamily: 'var(--mono)' }}>
          requestId: {requestId} · Enter 批准 · Esc 拒绝
        </div>
      </div>
    </div>
  );
}
