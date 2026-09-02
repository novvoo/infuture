import React from 'react';
import { useAppState } from '../state';

/** 底部状态栏 — CapabilityStatusBar。 */
export function StatusBar() {
  const { connected, doctor, busy } = useAppState();
  return (
    <footer className="statusbar">
      <span>
        <span className={`badge ${connected ? 'ok' : 'err'}`}>{connected ? '已连接' : '未连接'}</span>
      </span>
      <span>编程: {doctor ? (doctor.programming ? '✓' : '✗') : '…'}</span>
      <span>{busy ? '运行中…' : '就绪'}</span>
      <span style={{ marginLeft: 'auto' }}>infuture 0.1.0</span>
    </footer>
  );
}
