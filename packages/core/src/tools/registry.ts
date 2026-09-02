/**
 * ToolRegistry — 工具注册表。通用工具 + 编程工具在此合并。
 * 对应 Rust `tools::all_tools` / `tools::coding_tools`。
 */
import type { AgentTool, ToolCallResult } from '@infuture/types';

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.def.function.name, tool);
  }

  registerAll(tools: AgentTool[]): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  defs(): AgentTool['def'][] {
    return this.list().map((t) => t.def);
  }

  async execute(name: string, args: unknown, ctx?: import('@infuture/types').ToolExecutionContext): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { result: `unknown tool \`${name}\``, is_error: true };
    }
    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      return { result: err instanceof Error ? err.message : String(err), is_error: true };
    }
  }
}
