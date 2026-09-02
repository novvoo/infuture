import React, { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle, type LanguageSupport } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { java } from '@codemirror/lang-java';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';

/** 按文件扩展名路由 CodeMirror 语言支持。未识别 → undefined（纯文本）。 */
function fileLanguage(path: string): LanguageSupport | undefined {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true });
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true, jsx: true });
    case 'py':
    case 'pyw':
      return python();
    case 'json':
    case 'jsonc':
      return json();
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown();
    case 'java':
      return java();
    case 'go':
      return go();
    case 'rs':
      return rust();
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'hpp':
    case 'cxx':
      return cpp();
    case 'xml':
    case 'svg':
    case 'plist':
      return xml();
    case 'yml':
    case 'yaml':
      return yaml();
    case 'sql':
      return sql();
    default:
      return undefined;
  }
}

/**
 * 可编辑代码文件查看器（CodeMirror 6）：
 * 按文件扩展名启用语法高亮；编辑即回调 onChange；外部 value 变化时同步。
 */
export function CodeFileEditor({
  value,
  path,
  onChange,
  readOnly = false,
}: {
  value: string;
  path: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  // 初始化 / 语言随 path 变化时重建
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lang = fileLanguage(path);
    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          EditorView.lineWrapping,
          indentUnit.of('  '),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          ...(lang ? [lang] : []),
          EditorView.theme({
            '&': { height: '100%', fontSize: '12.5px' },
            '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
            '&.cm-focused': { outline: 'none' },
            '.cm-content': { padding: '14px 16px' },
            '.cm-gutters': { borderRight: '1px solid rgba(255,255,255,0.06)' },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path, readOnly]);

  // 外部 value 变化（切换文件 / 清空）时同步到编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  return <div className="code-editor" ref={hostRef} />;
}
