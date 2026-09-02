import React, { useCallback, useEffect, useState } from 'react';
import { useAppApi } from '../state';

/**
 * 工作区目录选择器：只读浏览后端文件系统，选择任意目录作为工作区根。
 * 浏览器无法直接获取本地绝对路径，故由后端 fs.browse 提供目录浏览。
 */
export function WorkspaceDirPicker({ initial, onSelect, onClose }: { initial?: string; onSelect: (absPath: string) => void; onClose: () => void }) {
  const { browseDir } = useAppApi();
  const [cur, setCur] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(
    async (abs: string) => {
      setErr('');
      try {
        const r = await browseDir(abs);
        if (!r) {
          setErr('无法读取该目录');
          return;
        }
        setCur(r.path);
        setDirs(r.dirs);
      } catch (e) {
        setErr(`读取失败：${String(e)}`);
      }
    },
    [browseDir],
  );

  useEffect(() => {
    void load(initial || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parent = (p: string) => {
    const idx = p.lastIndexOf('/');
    return idx > 0 ? p.slice(0, idx) : '/';
  };

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span style={{ fontSize: 14, fontWeight: 700 }}>选择工作区目录</span>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="picker-path" title={cur}>
          {cur || '…'}
        </div>
        <div className="picker-body">
          {cur && (
            <button className="picker-row" onClick={() => void load(parent(cur))}>
              ..（上级目录）
            </button>
          )}
          {dirs.length === 0 && <div className="picker-empty">（无子目录）</div>}
          {dirs.map((d) => (
            <button key={d} className="picker-row" onClick={() => void load(`${cur}/${d}`)}>
              📁 {d}
            </button>
          ))}
        </div>
        {err && <div className="picker-err">{err}</div>}
        <div className="picker-foot">
          <button className="btn sm primary" onClick={() => onSelect(cur)} disabled={!cur}>
            选择此目录
          </button>
          <button className="btn ghost sm" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
