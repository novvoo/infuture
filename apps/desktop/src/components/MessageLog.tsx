import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useAppState } from '../state';

/** 工具结果消息识别：斜杠直调写回历史的格式为 `[工具名]\n<结果>`。 */
const TOOL_RESULT_RE = /^\[[a-z_][a-z0-9_]*\]\n/;

/**
 * 工具结果块：等宽 `<pre>` 渲染（保留 hashline diff 的 `+/-` 对齐与行号，避免被 Markdown 当列表/链接），
 * 超长输出默认折叠（可展开）。code_read 整文件行号、hashline diff 等在此保持原样可读。
 */
function ToolResultBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const nl = text.indexOf('\n');
  const head = nl === -1 ? text : text.slice(0, nl);
  const body = nl === -1 ? '' : text.slice(nl + 1);
  const lineCount = body ? body.split('\n').length : 0;
  const long = lineCount > 24 || body.length > 2400;
  const showAll = expanded || !long;
  return (
    <div className="tool-msg">
      <div className="tool-msg-head">{head}</div>
      {body && (
        <pre className="tool-msg-body" style={showAll ? {} : { maxHeight: 320, overflow: 'auto' }}>
          {body}
        </pre>
      )}
      {long && (
        <button className="btn ghost sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '收起' : `展开全部（${lineCount} 行）`}
        </button>
      )}
    </div>
  );
}

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
            {m.role === 'assistant' && TOOL_RESULT_RE.test(m.text ?? '') ? (
              <ToolResultBlock text={m.text ?? ''} />
            ) : m.role === 'assistant' && m.text ? (
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
