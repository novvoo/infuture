/**
 * LSP / DAP 操作枚举 — 以 @oh-my-pi/pi-coding-agent 的真实工具参数面为准。
 *
 * 这些是与内置 `lsp` / `debug` 工具 schema 中 `action` 枚举一一对应的直调操作：
 *  - lsp 14 操作（语言服务器协议：诊断、引用、重命名、符号等）
 *  - debug 28 操作（DAP：launch/attach/断点/步进/栈/变量等，支持 lldb/dlv/debugpy）
 *
 * 与旧版"自造枚举 + prompt 委派"不同：现在 inloop 直接用这些 action
 * 精确调用编程工具（结构化参数 + 结构化 JSON 返回），而非让外部 agent 重新理解。
 */

export const LSP_OPERATIONS = [
  'diagnostics',
  'definition',
  'references',
  'hover',
  'symbols',
  'rename',
  'rename_file',
  'code_actions',
  'type_definition',
  'implementation',
  'status',
  'reload',
  'capabilities',
  'request',
] as const;
export type LspOperation = (typeof LSP_OPERATIONS)[number];

export const DAP_OPERATIONS = [
  'launch',
  'attach',
  'set_breakpoint',
  'remove_breakpoint',
  'set_instruction_breakpoint',
  'remove_instruction_breakpoint',
  'data_breakpoint_info',
  'set_data_breakpoint',
  'remove_data_breakpoint',
  'continue',
  'step_over',
  'step_in',
  'step_out',
  'pause',
  'evaluate',
  'stack_trace',
  'threads',
  'scopes',
  'variables',
  'disassemble',
  'read_memory',
  'write_memory',
  'modules',
  'loaded_sources',
  'custom_request',
  'output',
  'terminate',
  'sessions',
] as const;
export type DapOperation = (typeof DAP_OPERATIONS)[number];

/** 编程引擎原生工具名（BUILTIN_TOOLS 白名单，inloop 可直调）。 */
export const OMP_BUILTIN_TOOLS = [
  'read', 'write', 'edit', 'bash', 'grep', 'glob',
  'lsp', 'debug', 'eval', 'ast_grep', 'ast_edit',
  'task', 'github', 'checkpoint',
] as const;
