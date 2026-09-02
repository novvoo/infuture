import React, { useState } from 'react';
import { useAppState, useAppApi } from '../state';

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function SidebarPanel() {
  const { sessions, currentSessionId, settings, fsRoot } = useAppState();
  const { newSession, switchSession, deleteSession, renameSession, forkSession } = useAppApi();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };
  const commitRename = async (id: string) => {
    const name = editName.trim();
    setEditingId(null);
    if (name) await renameSession(id, name);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>会话</span>
        <button
          className="rail-btn"
          style={{ width: 26, height: 26, fontSize: 16 }}
          onClick={() => void newSession()}
          title="新会话"
        >
          ＋
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`sidebar-item ${s.id === currentSessionId ? 'active' : ''}`}
            onClick={() => void switchSession(s.id)}
          >
            {editingId === s.id ? (
              <div
                className="sidebar-edit"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(s.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
              >
                <input
                  autoFocus
                  className="input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="会话名称"
                />
                <button className="btn sm primary" title="保存" onClick={() => void commitRename(s.id)}>
                  ✓
                </button>
                <button className="btn sm" title="取消" onClick={() => setEditingId(null)}>
                  ✕
                </button>
              </div>
            ) : (
              <>
                <div className="sidebar-main">
                  <span className="t">{s.name}</span>
                  <span className="d">
                    {formatTs(s.updatedAt)} · {s.running ? '运行中' : '空闲'}
                  </span>
                </div>
                <div className="sidebar-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="act" title="重命名" onClick={() => startRename(s.id, s.name)}>
                    ✎
                  </button>
                  <button className="act" title="Fork（复制消息到新会话）" onClick={() => void forkSession(s.id)}>
                    ⧉
                  </button>
                  <button className="act danger" title="删除会话" onClick={() => void deleteSession(s.id)}>
                    🗑
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {sessions.length === 0 && (
          <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 12 }}>暂无会话</div>
        )}
      </div>
      <div className="sidebar-head" style={{ borderTop: '1px solid var(--border)' }}>
        <span>工作区</span>
      </div>
      <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
        {settings?.workspaceDir || fsRoot || '…'}
      </div>
    </aside>
  );
}
