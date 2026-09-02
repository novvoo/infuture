import React, { useEffect, useRef, useState } from 'react';
import { useAppState, useAppApi } from '../state';

/**
 * 审批浮动胶囊 — 吸收 mastery AskUserFloatingCapsule：
 * 右下角悬浮、可拖拽、可最小化，替代全屏遮罩弹窗。
 * 默认批准：Enter 批准 / Esc 拒绝 / 批准按钮自动聚焦。
 */
export function ApprovalCapsule() {
  const { pendingApproval } = useAppState();
  const { resolveApproval } = useAppApi();
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // 防重复提交：一次审批只允许一次决议
  const resolvingRef = useRef(false);

  useEffect(() => {
    if (!pendingApproval || minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void resolve(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void resolve(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingApproval, minimized]);

  const resolve = (approved: boolean) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    void resolveApproval(approved).finally(() => {
      resolvingRef.current = false;
    });
  };

  if (!pendingApproval) return null;
  const { toolName, args, requestId, sessionId } = pendingApproval;

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { dx: e.clientX, dy: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPos({ x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const style: React.CSSProperties = pos
    ? { right: undefined, bottom: undefined, left: pos.x, top: pos.y, transform: 'none' }
    : {};

  return (
    <div className="capsule" style={style}>
      <div
        className="capsule-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="拖拽移动"
      >
        <span className="capsule-dot" />
        <div>
          <div className="capsule-title">工具调用待审批</div>
          <div className="capsule-sub">{minimized ? `${toolName} · ${requestId.slice(0, 8)}` : 'agent 请求执行工具'}</div>
        </div>
        <button className="btn ghost sm capsule-min" onClick={() => setMinimized((m) => !m)} title={minimized ? '展开' : '最小化'}>
          {minimized ? '▢' : '—'}
        </button>
      </div>
      {!minimized && (
        <div className="capsule-body">
          <div className="capsule-tool">
            <b style={{ color: 'var(--yellow)' }}>{toolName}</b>
            {'\n'}
            {JSON.stringify(args, null, 2)}
          </div>
          {sessionId && <div className="capsule-sub" style={{ marginBottom: 8 }}>会话 {sessionId.slice(0, 14)}</div>}
          <div className="capsule-actions">
            <button className="btn sm danger" onClick={() => void resolve(false)}>
              拒绝
            </button>
            <button className="btn sm primary" autoFocus onClick={() => void resolve(true)}>
              批准 ↵
            </button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
            Enter 批准 · Esc 拒绝
          </div>
        </div>
      )}
    </div>
  );
}
