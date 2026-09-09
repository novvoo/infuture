import React from 'react';
import { SettingsMenu } from './SettingsMenu';
import type { RailView } from '../types';

export type { RailView };

const ICONS: Record<RailView, string> = {
  chat: '💬',
  files: '🗂',
  workers: '🎯',
  settings: '⚙',
  local: '🧠',
};

const LABELS: Record<RailView, string> = {
  chat: '会话',
  files: '文件',
  workers: '目标',
  settings: '设置',
  local: '本地模型',
};

export function ActivityRail({ view, onView }: { view: RailView; onView: (v: RailView) => void }) {
  const items: RailView[] = ['chat', 'files', 'workers', 'local'];
  return (
    <nav className="rail" aria-label="活动导航">
      <div className="rail-logo">∞</div>
      {items.map((item) => (
        <button
          key={item}
          className={`rail-btn ${view === item ? 'active' : ''}`}
          onClick={() => onView(item)}
          title={LABELS[item]}
          aria-label={LABELS[item]}
        >
          {ICONS[item]}
        </button>
      ))}
      <div className="rail-spacer" />
      <SettingsMenu />
    </nav>
  );
}
