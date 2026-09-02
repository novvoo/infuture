import React, { useState } from 'react';
import { useAppState, useAppApi } from '../state';

/**
 * 思考程度选择菜单（输入区，与模型选择并列）。
 * 档位：无需思考 / 中等思考 / 高级思考 → settings.thinkingLevel（off/medium/high），
 * 由 adapter 按模型能力映射（GLM→reasoning_effort low/high/max；低思考实测可把 reasoning 压到接近 0）。
 */
export const THINKING_LEVELS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'off', label: '无需思考', hint: '直接行动，最小化思考' },
  { key: 'medium', label: '中等思考', hint: '常规深度推理' },
  { key: 'high', label: '高级思考', hint: '深度推理，适合复杂题' },
];

/** 从 settings.thinkingLevel 推导当前档位（未设置时按无需思考展示，贴合当前默认行为）。 */
export function currentThinkingKey(level?: string): string {
  if (!level) return 'off';
  const l = level.toLowerCase();
  if (THINKING_LEVELS.some((t) => t.key === l)) return l;
  if (['low', 'none', 'minimal'].includes(l)) return 'off';
  if (['max', 'xhigh', 'deep'].includes(l)) return 'high';
  return 'medium';
}

export function ThinkingMenu() {
  const { settings } = useAppState();
  const { updateSettings } = useAppApi();
  const [open, setOpen] = useState(false);
  const cur = currentThinkingKey(settings?.thinkingLevel);
  const label = THINKING_LEVELS.find((t) => t.key === cur)?.label ?? '无需思考';

  return (
    <div className="model-menu" style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn" style={{ fontSize: 12 }} onClick={() => setOpen((o) => !o)}>
        {label} ▾
      </button>
      {open && (
        <div className="model-list">
          <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)' }}>思考程度</div>
          {THINKING_LEVELS.map((t) => (
            <div
              key={t.key}
              className={`model-option ${t.key === cur ? 'active' : ''}`}
              onClick={() => {
                void updateSettings({ thinkingLevel: t.key });
                setOpen(false);
              }}
            >
              <span className="n">{t.label}</span>
              <span className="d">{t.hint}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
