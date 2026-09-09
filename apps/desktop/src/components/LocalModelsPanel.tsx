/**
 * LocalModelsPanel — 本地模型页（侧栏「🧠 本地模型」）。
 * 三块功能：
 *  1. 下载本地模型：HuggingFace MLX 模型目录，点击下载（进度轮询）
 *  2. 启动本地模型服务：mlx_lm server（Apple Silicon 原生 OpenAI 兼容 API），
 *     启动后自动把托管模型注册进 LLM 模型菜单「已配置模型」
 *  3. 设置本地模型：模型根目录 / 服务端口 / 自动注册开关
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useAppApi, useAppState } from '../state';
import type { LocalModelStatus } from '../types';

export function LocalModelsPanel() {
  const { localStatus, localDownload, localStart, localStop, localRefresh, localSetSettings, localDeactivate, localTest } = useAppApi();
  const { localStatus: st, models } = useAppState();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [modelRoot, setModelRoot] = useState('');
  const [port, setPort] = useState(8288);
  const [autoRegister, setAutoRegister] = useState(true);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; costMs?: number; sample?: string } | null>(null);
  const [downloadLogs, setDownloadLogs] = useState<Record<string, string[]>>({});

  const status: LocalModelStatus | null = st;

  const refresh = useCallback(async () => {
    const s = await localStatus();
    if (s) {
      setModelRoot(s.modelRoot);
      setPort(s.port);
      setAutoRegister(s.autoRegister);
    }
  }, [localStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 下载中轮询（进度 + 下载日志）
  useEffect(() => {
    if (!status?.downloading?.length) return;
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [status?.downloading?.length, refresh]);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 6000);
  };

  const onDownload = async (repo: string, id: string) => {
    setBusy(`download-${id}`);
    try {
      const r = await localDownload(repo);
      flash(r.ok ? 'ok' : 'err', r.message ?? (r.ok ? '下载已开始' : '下载失败'));
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const onStart = async (modelDir?: string) => {
    setBusy('start');
    try {
      const r = await localStart(modelDir, port);
      flash(r.ok ? 'ok' : 'err', r.message);
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const onStop = async () => {
    setBusy('stop');
    try {
      const r = await localStop();
      flash(r.ok ? 'ok' : 'err', r.message);
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const onTest = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      const r = await localTest();
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, message: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const onDeactivate = async (id: string) => {
    setBusy(`deactivate-${id}`);
    try {
      const r = await localDeactivate(id);
      flash(r.ok ? 'ok' : 'err', r.message);
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const onRefresh = async () => {
    setBusy('refresh');
    try {
      const r = await localRefresh();
      flash('ok', r.registered.length ? `已同步注册模型: ${r.registered.join(', ')}` : '服务未运行或没有可同步的模型');
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const onSaveSettings = async () => {
    setBusy('settings');
    try {
      await localSetSettings({ modelRoot: modelRoot.trim() || undefined, port: Number(port) || undefined, autoRegister });
      flash('ok', '设置已保存');
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const registeredCount = (status?.models ?? []).filter((m) => m.registered).length;
  const localMenuModels = models.filter((m) => m.provider === 'local');

  return (
    <div className="panel-scroll" style={{ padding: 20, maxWidth: 920 }}>
      <h2 style={{ margin: '0 0 4px' }}>🧠 本地模型</h2>
      <div style={{ opacity: 0.7, fontSize: 13, marginBottom: 16 }}>
        Apple Silicon 原生推理（MLX）。下载 HuggingFace MLX 模型 → 启动本地 OpenAI 兼容服务 → 自动注册进
        LLM 模型菜单「已配置模型」。
      </div>

      {notice && (
        <div
          style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13,
            background: notice.kind === 'ok' ? 'var(--ok-bg, #132b1d)' : 'var(--danger-dim, #2b1315)',
            color: notice.kind === 'ok' ? '#7ee2a8' : '#ff8f8f',
          }}
        >
          {notice.text}
        </div>
      )}

      {/* ── 服务状态条 ── */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 18,
          borderRadius: 10, border: '1px solid var(--border, #223)', background: 'var(--panel, #10263f)',
        }}
      >
        <span
          style={{
            width: 10, height: 10, borderRadius: '50%',
            background: status?.running ? '#3ddc84' : '#ff5f56', display: 'inline-block',
          }}
        />
        <b>服务: {status?.running ? `运行中 (端口 ${status.port})` : '未运行'}</b>
        {status?.running && (
          <span style={{ opacity: 0.75, fontSize: 13 }}>
            托管模型: {status.serving.length ? status.serving.join(', ') : '（探测中…）'}
          </span>
        )}
        <span style={{ opacity: 0.75, fontSize: 13, marginLeft: 'auto' }}>
          模型菜单已注册: {localMenuModels.length} 个（provider=local）· 本地模型目录 {registeredCount} 个
        </span>
        {status?.running ? (
          <button className="btn sm danger" disabled={busy === 'stop'} onClick={() => void onStop()}>
            {busy === 'stop' ? '停止中…' : '停止并停用'}
          </button>
        ) : (
          <button className="btn sm primary" disabled={busy === 'start' || !status?.models.some((m) => m.installed)} onClick={() => void onStart()}>
            {busy === 'start' ? '启动中（加载权重可能需 1~2 分钟）…' : '启动服务'}
          </button>
        )}
        <button className="btn sm" disabled={busy === 'test' || !status?.running} onClick={() => void onTest()}>
          {busy === 'test' ? '测试中…' : '测试'}
        </button>
        <button className="btn sm" disabled={busy === 'refresh'} onClick={() => void onRefresh()}>
          同步注册
        </button>
      </div>

      {testResult && (
        <div
          style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13,
            background: testResult.ok ? 'var(--ok-bg, #132b1d)' : 'var(--danger-dim, #2b1315)',
            color: testResult.ok ? '#7ee2a8' : '#ff8f8f',
          }}
        >
          测试结果: {testResult.message}
          {testResult.costMs !== undefined && ` · ${testResult.costMs}ms`}
          {testResult.sample ? ` · 回复: “${testResult.sample}”` : ''}
        </div>
      )}

      {/* ── ① 下载本地模型 ── */}
      <section style={{ marginBottom: 22 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>① 下载本地模型</h3>
        <div style={{ display: 'grid', gap: 8 }}>
          {(status?.models ?? []).filter((m) => m.repo).map((m) => {
            const dl = status?.downloading.includes(m.id);
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  borderRadius: 10, border: '1px solid var(--border, #223)', background: 'var(--panel, #10263f)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{m.label ?? m.id}</div>
                  <div style={{ opacity: 0.6, fontSize: 12, fontFamily: 'monospace' }}>{m.repo}</div>
                </div>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{m.installed ? '已安装 ✓' : '未安装'}</span>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{m.registered ? '已注册 ✓' : ''}</span>
                {m.registered && (
                  <button
                    className="btn sm"
                    disabled={busy === `deactivate-${m.id}`}
                    onClick={() => void onDeactivate(m.id)}
                    title="从模型菜单移除该本地模型（服务不受影响）"
                  >
                    {busy === `deactivate-${m.id}` ? '停用中…' : '停用'}
                  </button>
                )}
                {m.installed ? (
                  <button className="btn sm" disabled={busy === 'start'} onClick={() => void onStart(m.dir)}>
                    以此启动
                  </button>
                ) : (
                  <button
                    className="btn sm primary"
                    disabled={busy === `download-${m.id}` || dl}
                    onClick={() => void onDownload(m.repo!, m.id)}
                  >
                    {dl ? '下载中…' : '下载'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {status?.models.some((m) => m.installed) && (
          <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
            手动放入 {status.modelRoot} 的模型：
            {status.models.filter((m) => !m.repo).map((m) => (
              <span key={m.id} style={{ marginLeft: 8 }}>
                {m.id} {m.registered ? '(已注册)' : ''}
                <button className="btn sm" style={{ marginLeft: 6 }} disabled={busy === 'start'} onClick={() => void onStart(m.dir)}>
                  以此启动
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── ② 启动本地模型服务 ── */}
      <section style={{ marginBottom: 22 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>② 启动本地模型服务</h3>
        <div style={{ opacity: 0.7, fontSize: 13, marginBottom: 8, lineHeight: 1.6 }}>
          <code>python -m mlx_lm server --model &lt;模型目录&gt; --port {port}</code>
          <br />
          服务进程独立运行（desktop 重启不停止）；启动成功后自动把 /v1/models 探测到的模型写进 LLM 模型菜单（provider=local），
          即可在会话的模型下拉里选用本地模型。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy === 'start' || !status?.models.some((m) => m.installed)} onClick={() => void onStart()}>
            {busy === 'start' ? '启动中…' : '启动服务（默认模型）'}
          </button>
          {busy === 'start' && <span style={{ opacity: 0.7, fontSize: 13, alignSelf: 'center' }}>首次加载权重较慢（30~120s），页面会自动探测就绪状态…</span>}
        </div>
        {status?.logTail && status.logTail.length > 0 && (
          <pre
            style={{
              marginTop: 10, padding: 10, borderRadius: 8, maxHeight: 160, overflow: 'auto',
              background: '#0b1424', border: '1px solid var(--border, #223)', fontSize: 11,
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.85,
            }}
          >
            {status.logTail.join('')}
          </pre>
        )}
      </section>

      {/* ── ③ 设置本地模型 ── */}
      <section>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>③ 设置本地模型</h3>
        <div style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            模型根目录
            <input
              className="input"
              placeholder="~/models"
              value={modelRoot}
              onChange={(e) => setModelRoot(e.target.value)}
            />
            <span style={{ opacity: 0.55, fontSize: 12 }}>下载的模型存放于此；手动放入的目录也会被识别为已安装模型。</span>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            服务端口
            <input
              className="input"
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={autoRegister} onChange={(e) => setAutoRegister(e.target.checked)} />
            服务启动后自动把模型注册进 LLM 模型菜单（已配置模型）
          </label>
          <div>
            <button className="btn sm" disabled={busy === 'settings'} onClick={() => void onSaveSettings()}>
              {busy === 'settings' ? '保存中…' : '保存设置'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
