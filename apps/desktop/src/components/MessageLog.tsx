import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useAppState } from '../state';

/** 用 markdown + GFM + 语法高亮渲染文本。默认不渲染 raw HTML（react-markdown 安全）。 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: ({ node, ...props }) => <pre {...props} />,
          code: ({ node, className, ...props }) =>
            className && className.includes('language-') ? (
              <code className={className} {...props} />
            ) : (
              <code {...props} style={{ background: 'rgba(127,127,127,.15)', padding: '1px 5px', borderRadius: 4, fontSize: '0.92em' }} />
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function MessageLog() {
  const { messages, busy } = useAppState();
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户上翻（不在底部附近）时停止自动跟随，避免流式输出把滚动条复位
  const stickToBottom = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  return (
    <div className="messages" ref={scrollRef} onScroll={onScroll}>
      {messages.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>∞</div>
          开始对话。infuture 既处理常规任务，也具备编程能力（LSP / DAP / 代码执行 / 子 agent）。
        </div>
      )}
      {messages.map((m, i) => (
        <div key={i} className={`msg ${m.role === 'user' ? 'user' : ''}`}>
          <div className="role">{m.role === 'user' ? '你' : 'infuture'}</div>
          <div className="body">
            {m.reasoning && (
              <details className="reasoning" open={busy}>
                <summary>思考中…</summary>
                <div className="reasoning-text">{m.reasoning}</div>
              </details>
            )}
            {m.role === 'assistant' && m.text ? (
              <Markdown text={m.text} />
            ) : (
              <span>{m.text || (m.reasoning ? '' : '…')}</span>
            )}
          </div>
        </div>
      ))}
      {busy && (
        <div className="msg">
          <div className="role">infuture</div>
          <div className="body" style={{ color: 'var(--text-dim)' }}>
            <span className="typing">●</span>
          </div>
        </div>
      )}
    </div>
  );
}
