/**
 * browser 内嵌浮窗 —— 实时显示 browser 工具正在操作的页面，可直接交互
 * （点击/滚动/键盘/文本 → 坐标与键事件转发回同一页面实例）。
 *
 * 触发：browser 工具被调用（open/run）时由 state 自动置 visible。
 * 交互模型：帧渲染 + 输入转发（网页内嵌真实浏览器页面的唯一可行方式）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppApi, useAppState } from '../state';

/** 浮窗尺寸：默认小窗（右下角）；⛶ 按钮在 小窗 ↔ 放大 之间切换。 */
const DEFAULT_W = 400;
const DEFAULT_H = 300;
const ZOOMED_W = 960;
const ZOOMED_H = 640;
const MARGIN = 16;

export function BrowserPreviewFloat() {
  const { browserPreview } = useAppState();
  const { refreshBrowserPreview, sendBrowserInput, closeBrowserPreview, openBrowserPreview } = useAppApi();

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null = 默认右下角
  const [zoomed, setZoomed] = useState(false);
  const [textInput, setTextInput] = useState('');
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // 关闭后留一个小胶囊入口：随时可重新打开浮窗（不依赖模型再次调用浏览器工具）
  if (!browserPreview.visible) {
    return (
      <button
        className="browser-preview-reopen"
        title="打开浏览器预览"
        onClick={() => openBrowserPreview()}
      >
        ⧉
      </button>
    );
  }

  const size = zoomed ? { w: ZOOMED_W, h: ZOOMED_H } : { w: DEFAULT_W, h: DEFAULT_H };

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { right: MARGIN, bottom: MARGIN };

  /** 容器内相对坐标 → 页面 CSS 像素坐标。 */
  const toPagePoint = (e: React.MouseEvent): { x: number; y: number } | null => {
    const el = frameRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const w = browserPreview.width ?? rect.width;
    const h = browserPreview.height ?? rect.height;
    const rx = (e.clientX - rect.left) / rect.width;
    const ry = (e.clientY - rect.top) / rect.height;
    return { x: Math.round(rx * w), y: Math.round(ry * h) };
  };

  const onFrameMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = toPagePoint(e);
    if (!p) return;
    void sendBrowserInput({ type: 'click', x: p.x, y: p.y });
  };

  const onFrameWheel = (e: React.WheelEvent) => {
    void sendBrowserInput({ type: 'scroll', dx: e.deltaX, dy: e.deltaY });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeBrowserPreview();
      return;
    }
    // 常用键直接转发；可打印字符走文本输入条
    const special = ['Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'];
    if (special.includes(e.key)) {
      e.preventDefault();
      void sendBrowserInput({ type: 'key', text: e.key });
    }
  };

  const submitText = () => {
    if (!textInput) return;
    void sendBrowserInput({ type: 'type', text: textInput });
    setTextInput('');
  };

  // 拖动标题栏
  const onTitleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = pos ?? { x: window.innerWidth - size.w - MARGIN, y: window.innerHeight - size.h - MARGIN };
    dragRef.current = { dx: startX - base.x, dy: startY - base.y };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - d.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - d.dy)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const host: React.CSSProperties = { width: size.w, height: size.h };

  return (
    <div className="browser-preview-float" style={{ ...style, width: size.w, height: size.h }}>
      <div className="browser-preview-title" onMouseDown={onTitleMouseDown}>
        <span className="browser-preview-dot" title="browser 内嵌预览" />
        <span className="browser-preview-url" title={browserPreview.url}>
          {browserPreview.url || 'browser 预览'}
        </span>
        {browserPreview.title ? <span className="browser-preview-page-title">{browserPreview.title}</span> : null}
        <button
          className="browser-preview-btn"
          onClick={() => void sendBrowserInput({ type: 'nav', dir: 'back' })}
          title="后退"
        >
          ←
        </button>
        <button
          className="browser-preview-btn"
          onClick={() => void sendBrowserInput({ type: 'nav', dir: 'forward' })}
          title="前进"
        >
          →
        </button>
        <button
          className="browser-preview-btn"
          onClick={() => void refreshBrowserPreview()}
          title="刷新"
        >
          ⟳
        </button>
        <button
          className="browser-preview-btn"
          onClick={() => setZoomed((v) => !v)}
          title={zoomed ? '还原小窗' : '放大窗口'}
        >
          {zoomed ? '⤡' : '⤢'}
        </button>
        <button className="browser-preview-btn" onClick={closeBrowserPreview} title="关闭">
          ✕
        </button>
      </div>
      <div
        className="browser-preview-frame"
        ref={frameRef}
        style={host}
        onMouseDown={onFrameMouseDown}
        onWheel={onFrameWheel}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {browserPreview.image ? (
          <img
            src={`data:image/png;base64,${browserPreview.image}`}
            alt="browser preview"
            draggable={false}
          />
        ) : (
          <div className="browser-preview-empty">
            {browserPreview.loading ? '加载中…' : '暂无浏览器标签页'}
          </div>
        )}
      </div>
      <div className="browser-preview-inputbar">
        <input
          className="browser-preview-text"
          placeholder="输入文本（先点击页面目标，再发送）"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitText();
            e.stopPropagation();
          }}
        />
        <button className="browser-preview-btn" onClick={submitText} title="发送文本">
          发送
        </button>
      </div>
    </div>
  );
}
