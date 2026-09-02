import React, { useState } from 'react';
import { useAppState, useAppApi } from '../state';

/** web_search 支持的凭据型 provider（供配置菜单）。 */
const SEARCH_PROVIDERS: { id: string; label: string; note: string; free?: boolean }[] = [
  { id: 'tinyfish', label: 'TinyFish', note: '免费 · 推荐 · 30 req/min', free: true },
  { id: 'exa', label: 'Exa', note: '$7 / 1K 次' },
  { id: 'jina', label: 'Jina', note: '需 key' },
  { id: 'kagi', label: 'Kagi', note: '需 key' },
  { id: 'tavily', label: 'Tavily', note: '~$8 / 1K 次' },
  { id: 'perplexity', label: 'Perplexity', note: '需 key' },
  { id: 'xai', label: 'xAI', note: '需 key' },
  { id: 'codex', label: 'OpenAI', note: '调用参数有 bug，不推荐' },
  { id: 'gemini', label: 'Gemini', note: '需 OAuth' },
  { id: 'anthropic', label: 'Anthropic', note: '需 OAuth' },
];

/** 搜索配置菜单：默认搜索引擎 + 各 provider 的 API key。免费项自动启用说明。 */
export function SearchConfigModal({ onClose }: { onClose: () => void }) {
  const { settings, auth, busy } = useAppState();
  const { updateSettings, saveAuth, verifySearch } = useAppApi();
  const [defaultProvider, setDefaultProvider] = useState(settings?.searchProvider ?? 'auto');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; costMs?: number; sample?: string; error?: string } | null>(null);

  const hasKey = (id: string) => auth?.[id]?.hasKey ?? false;

  const save = async () => {
    for (const p of SEARCH_PROVIDERS) {
      const k = (keys[p.id] ?? '').trim();
      if (k) await saveAuth(p.id, k);
    }
    await updateSettings({ searchProvider: defaultProvider });
    setSaved(true);
    setTimeout(onClose, 800);
  };

  const verify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const r = await verifySearch();
      setVerifyResult(r);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <h2>搜索配置</h2>
        <div className="sub">web_search 内置多 provider 搜索。默认 auto 会自动启用已配置 key 的可用搜索引擎；免 key 的匿名搜索引擎（DuckDuckGo/Startpage）也自动参与，但数据中心 IP 常被反爬。推荐配置免费的 <b style={{ color: 'var(--green, #6ee7b7)' }}>TinyFish</b>。</div>

        <div className="setting-row">
          <div>
            <div className="l">默认搜索引擎</div>
            <div className="d">auto 自动按可用链 fallback，或锁定某一家</div>
          </div>
          <select className="select" style={{ width: 170 }} value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)}>
            <option value="auto">auto（自动）</option>
            {SEARCH_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}{p.free ? '（免费）' : ''}</option>
            ))}
          </select>
        </div>

        <div style={{ fontWeight: 700, margin: '12px 0 6px' }}>API Key（可选，按 provider）</div>
        {SEARCH_PROVIDERS.map((p) => (
          <div key={p.id} className="setting-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="l">
                {p.label} {hasKey(p.id) && <span className="badge ok" style={{ fontSize: 9 }}>已配置</span>}
              </div>
              <div className="d">{p.note}</div>
            </div>
            <input
              className="input"
              style={{ width: 150 }}
              type="password"
              placeholder={hasKey(p.id) ? '已保存，留空不变' : 'API key'}
              value={keys[p.id] ?? ''}
              onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
            />
          </div>
        ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14, alignItems: 'center' }}>
          <button className="btn ghost" disabled={verifying} onClick={() => void verify()} style={{ marginRight: 'auto' }}>
            {verifying ? '验证中…' : '验证配置'}
          </button>
          {verifyResult && (
            <div
              style={{
                fontSize: 11, flex: 1, textAlign: 'left', marginRight: 8,
                color: verifyResult.ok ? 'var(--green, #6ee7b7)' : 'var(--red, #f87171)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              title={verifyResult.error ?? verifyResult.sample}
            >
              {verifyResult.ok
                ? `✓ 验证通过（${verifyResult.costMs ?? '-'}ms）${verifyResult.sample ? ' · ' + verifyResult.sample.slice(0, 60) : ''}`
                : `✗ ${verifyResult.error ?? '验证失败'}`}
            </div>
          )}
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={() => void save()}>
            {saved ? '✓ 已保存' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
