import React, { useState } from 'react';
import { useAppState, useAppApi } from '../state';
import type { ModelInfo } from '../types';

const API_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses API' },
  { value: 'anthropic', label: 'Anthropic Messages' },
];

export interface LLMSetupModalProps {
  onClose: () => void;
}

/** 单个已配置模型的卡片：模型 id / Base URL / API Key 三个输入框 + 保存 + 删除。 */
function ModelCard({ model }: { model: ModelInfo }) {
  const { auth } = useAppState();
  const { saveAuth, addModel, removeModel } = useAppApi();
  const [id, setId] = useState(model.id);
  const [baseUrl, setBaseUrl] = useState(model.baseUrl);
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasKey = !!auth?.[model.provider]?.hasKey;

  const save = async () => {
    setBusy(true);
    try {
      const newId = id.trim() || model.id;
      if (newId !== model.id) await removeModel(model.id);
      await addModel({
        id: newId,
        name: newId,
        provider: model.provider,
        api: model.api,
        baseUrl,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens ?? 4096,
        reasoning: model.reasoning,
      });
      if (key.trim()) await saveAuth(model.provider, key.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {model.name || model.id}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 6, fontFamily: 'var(--mono)' }}>{model.provider}</span>
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className={hasKey ? 'badge ok' : 'badge warn'}>{hasKey ? 'Key 已配置' : 'Key 未配置'}</span>
          <button className="btn sm danger" title="删除此模型" onClick={() => void removeModel(model.id)}>删除</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1.4fr', gap: 8 }}>
        <input className="input" placeholder="模型 id" value={id} onChange={(e) => setId(e.target.value)} />
        <input className="input" placeholder="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <input className="input" type="password" placeholder={hasKey ? '新 Key（留空不改）' : 'API Key'} value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn sm primary" disabled={busy} onClick={() => void save()}>{saved ? '已保存 ✓' : '保存'}</button>
      </div>
    </div>
  );
}

/** LLM 配置弹窗：添加自定义模型 + 已配置模型管理（三个输入框 + 删除）。无任何预设。 */
export function LLMSetupModal({ onClose }: LLMSetupModalProps) {
  const { models } = useAppState();
  const { addModel } = useAppApi();
  const [custom, setCustom] = useState({
    id: '',
    name: '',
    provider: '',
    api: 'openai-completions',
    baseUrl: '',
    contextWindow: 32768,
    maxTokens: 4096,
    reasoning: false,
  });
  const [err, setErr] = useState<string | null>(null);

  const submitCustom = async () => {
    setErr(null);
    if (!custom.id.trim()) {
      setErr('模型 id 必填');
      return;
    }
    if (!custom.baseUrl.trim()) {
      setErr('Base URL 必填（自定义模型需指定服务地址）');
      return;
    }
    if (!custom.provider.trim()) {
      setErr('provider 必填（用于对应 API Key 的保存名）');
      return;
    }
    await addModel(custom);
    setCustom({ ...custom, id: '', name: '' });
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>LLM 配置</h2>
        <div className="sub">
          模型完全由你自定义。添加模型后在下方「已配置模型」中为其指定模型 id / Base URL / API Key。
          Key 保存于本机 ~/.future/agent/auth.json（0600），不回显。
        </div>

        <div className="section-title">添加模型</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input className="input" placeholder="模型 id（如 gpt-4o / llama3）" value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value })} />
          <input className="input" placeholder="显示名（可选）" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          <input className="input" placeholder="provider（对应 API Key 名，如 openai）" value={custom.provider} onChange={(e) => setCustom({ ...custom, provider: e.target.value })} />
          <select className="select" value={custom.api} onChange={(e) => setCustom({ ...custom, api: e.target.value })}>
            {API_OPTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
          <input className="input" placeholder="Base URL（必填，如 https://api.openai.com/v1）" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              type="number"
              placeholder="上下文"
              title="contextWindow"
              value={custom.contextWindow}
              onChange={(e) => setCustom({ ...custom, contextWindow: Number(e.target.value) || 0 })}
            />
            <input
              className="input"
              type="number"
              placeholder="最大输出"
              title="maxTokens"
              value={custom.maxTokens}
              onChange={(e) => setCustom({ ...custom, maxTokens: Number(e.target.value) || 0 })}
            />
          </div>
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{err}</div>}
        <div className="btn-row">
          <button className="btn primary" onClick={() => void submitCustom()}>添加模型</button>
        </div>

        <div className="section-title">已配置模型（{models.length}）</div>
        {models.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '10px 0' }}>
            尚未添加模型，请在上方填写后添加。
          </div>
        ) : (
          models.map((m) => <ModelCard key={m.id} model={m} />)
        )}

        <div className="btn-row" style={{ marginTop: 20 }}>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
