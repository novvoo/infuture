import React, { useState } from 'react';
import { useAppState, useAppApi } from '../state';
import { LLMSetupModal } from './LLMSetupModal';

/** 模型切换菜单。模型全部由用户自配；未配置时给出添加引导。 */
export function ModelMenu() {
  const { models, currentModel } = useAppState();
  const { setModel, refreshModels } = useAppApi();
  const [open, setOpen] = useState(false);
  const [llmOpen, setLlmOpen] = useState(false);

  return (
    <div className="model-menu" style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="btn"
        style={{ fontSize: 12 }}
        onClick={() => {
          // 打开时重新拉取，拾取外部（CLI/文件）新增或修改的模型配置
          void refreshModels();
          setOpen((o) => !o);
        }}
      >
        {currentModel || '未配置模型'} ▾
      </button>
      {open && (
        <div className="model-list">
          {models.length === 0 ? (
            <div style={{ padding: '16px 14px', textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
                尚未配置模型。<br />请添加模型后再开始对话。
              </div>
              <button className="btn sm primary" onClick={() => setLlmOpen(true)}>
                + 添加模型
              </button>
            </div>
          ) : (
            <>
              <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)' }}>
                选择模型（{models.length}） ·{' '}
                <a
                  style={{ color: 'var(--accent)', cursor: 'pointer' }}
                  onClick={() => setLlmOpen(true)}
                >
                  + 添加
                </a>
              </div>
              {models.map((m) => (
                <div
                  key={m.id}
                  className={`model-option ${m.id === currentModel ? 'active' : ''}`}
                  onClick={() => {
                    void setModel(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="n">{m.id}</span>
                  <span className="d">
                    {m.provider} · {m.contextWindow.toLocaleString()}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {llmOpen && <LLMSetupModal onClose={() => setLlmOpen(false)} />}
    </div>
  );
}
