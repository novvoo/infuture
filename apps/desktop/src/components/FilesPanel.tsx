import React, { useEffect, useRef, useState } from 'react';
import { useAppState, useAppApi } from '../state';
import type { DirEntry } from '../types';
import { WorkspaceDirPicker } from './WorkspaceDirPicker';
import { CodeFileEditor } from './CodeFileEditor';

function formatSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 文件管理面板：浏览 / 新建 / 删除 / 重命名 / 上传 / 查看编辑 / 切换工作区目录。 */
export function FilesPanel() {
  const { files, fsPath, fileView, fsRoot, settings } = useAppState();
  const { openDir, openFile, saveFile, createFile, createDir, deleteEntry, renameEntry, closeFile, refreshFiles, updateSettings } = useAppApi();
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 切换工作区目录：选择后立即生效（后端 setWorkspace），并回到新工作区根浏览。 */
  const handleSwitchWorkspace = async (abs: string) => {
    setPickerOpen(false);
    await updateSettings({ workspaceDir: abs });
    await openDir('.');
  };

  // 打开文件时同步草稿
  useEffect(() => {
    setDraft(fileView?.content ?? '');
    setSaved(false);
  }, [fileView]);

  const crumbs = fsPath.split('/').filter(Boolean);

  const handleCreateFile = () => {
    const name = window.prompt('新文件名：', 'untitled.txt');
    if (!name?.trim()) return;
    void createFile(joinPath(fsPath, name.trim()));
  };
  const handleCreateDir = () => {
    const name = window.prompt('新文件夹名：', 'new-folder');
    if (!name?.trim()) return;
    void createDir(joinPath(fsPath, name.trim()));
  };
  const handleRename = (e: DirEntry) => {
    const next = window.prompt('重命名为：', e.name);
    if (!next?.trim() || next.trim() === e.name) return;
    const to = e.isDir ? `${joinPath(fsPath, next.trim())}/` : joinPath(fsPath, next.trim());
    void renameEntry(e.path, to);
  };
  const handleDelete = (e: DirEntry) => {
    const msg = `确定删除「${e.name}」？${e.isDir ? '目录将递归删除，' : ''}不可恢复。`;
    if (window.confirm(msg)) void deleteEntry(e.path);
  };
  const handleUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => void createFile(joinPath(fsPath, file.name), String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const save = async () => {
    if (!fileView) return;
    await saveFile(fileView.path, draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <div className="breadcrumb" title={fileView ? undefined : `工作区根：${fsRoot || ''}`}>
          <span className="crumb root" onClick={() => void openDir('.')}>
            工作区
          </span>
          {crumbs.map((c, i) => {
            const rel = crumbs.slice(0, i + 1).join('/');
            return (
              <span key={rel} className="crumb" onClick={() => void openDir(rel)}>
                / {c}
              </span>
            );
          })}
        </div>
        <div className="files-actions">
          <button className="btn sm" title="切换工作区目录" onClick={() => setPickerOpen(true)}>
            切换目录
          </button>
          <button className="btn sm" title="刷新" onClick={() => void refreshFiles()}>
            ⟳
          </button>
          <button className="btn sm" title="上传文件（以文本方式写入）" onClick={() => fileInputRef.current?.click()}>
            ↑ 上传
          </button>
          <button className="btn sm" title="新建文件" onClick={handleCreateFile}>
            ＋ 文件
          </button>
          <button className="btn sm" title="新建文件夹" onClick={handleCreateDir}>
            ＋ 文件夹
          </button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {fileView ? (
        <div className="file-view">
          <div className="file-view-head">
            <button className="btn sm" onClick={closeFile}>
              ← 返回
            </button>
            <span className="path" title={fileView.path}>
              {fileView.path}
            </span>
            <span className="meta">
              {formatSize(fileView.size)}
              {fileView.truncated ? '（已截断）' : ''}
            </span>
            <button className="btn sm primary" onClick={() => void save()} disabled={!fileView.isText}>
              {saved ? '已保存 ✓' : '保存'}
            </button>
          </div>
          {fileView.isText ? (
            <CodeFileEditor value={draft} path={fileView.path} onChange={setDraft} />
          ) : (
            <pre className="file-readonly">{fileView.content}</pre>
          )}
        </div>
      ) : (
        <div className="file-list">
          {files.length === 0 && <div className="empty">空目录</div>}
          {files.map((e) => (
            <div
              key={e.path}
              className={`file-row ${e.isDir ? 'dir' : 'file'}`}
              onClick={() => (e.isDir ? void openDir(e.path.replace(/\/$/, '') || '.') : void openFile(e.path))}
            >
              <span className="icon">{e.isDir ? '📁' : '📄'}</span>
              <span className="name" title={e.path}>
                {e.name}
              </span>
              <span className="meta">{e.isDir ? '' : formatSize(e.size)}</span>
              <span className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                <button className="act" title="重命名" onClick={() => handleRename(e)}>
                  ✎
                </button>
                <button className="act danger" title="删除" onClick={() => handleDelete(e)}>
                  🗑
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {pickerOpen && (
        <WorkspaceDirPicker
          initial={settings?.workspaceDir}
          onSelect={(abs) => void handleSwitchWorkspace(abs)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
