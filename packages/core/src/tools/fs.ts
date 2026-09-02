/**
 * 通用文件工具 — read / write / edit。
 * 对应 Rust `tools::*`。审批门控在运行环层完成，工具本身只执行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentTool, ToolCallResult } from '@infuture/types';
import { toolDef } from '@infuture/types';

/** 路径解析：相对路径基于 cwd；拒绝空路径。 */
function resolvePath(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

export function readTool(cwd = process.cwd()): AgentTool {
  return {
    def: toolDef('read', 'Read a file from disk and return its contents.', {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or relative path' } },
      required: ['path'],
    }),
    guidelines: ['Prefer read over shell cat', 'Large files: read with offset/limit'],
    handler: async (args, ctx): Promise<ToolCallResult> => {
      const { path: p } = (args ?? {}) as { path?: string };
      if (!p) return { result: 'read: missing `path`', is_error: true };
      try {
        const data = await fs.readFile(resolvePath(p, ctx?.cwd ?? cwd), 'utf-8');
        return { result: data, is_error: false };
      } catch (err) {
        return { result: `read failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    },
  };
}

export function writeTool(cwd = process.cwd()): AgentTool {
  return {
    def: toolDef('write', 'Write content to a file, overwriting it.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    }),
    guidelines: ['Write overwrites the entire file'],
    handler: async (args, ctx): Promise<ToolCallResult> => {
      const { path: p, content } = (args ?? {}) as { path?: string; content?: string };
      if (!p || content === undefined) return { result: 'write: missing `path` or `content`', is_error: true };
      try {
        const target = resolvePath(p, ctx?.cwd ?? cwd);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
        return { result: `wrote ${Buffer.byteLength(content)} bytes to ${target}`, is_error: false };
      } catch (err) {
        return { result: `write failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    },
  };
}

export function editTool(cwd = process.cwd()): AgentTool {
  return {
    def: toolDef('edit', 'Apply a string replacement in a file (old_string → new_string).', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    }),
    guidelines: ['old_string must be unique unless replace_all=true'],
    handler: async (args, ctx): Promise<ToolCallResult> => {
      const { path: p, old_string, new_string, replace_all } = (args ?? {}) as {
        path?: string;
        old_string?: string;
        new_string?: string;
        replace_all?: boolean;
      };
      if (!p || old_string === undefined || new_string === undefined) {
        return { result: 'edit: missing `path` / `old_string` / `new_string`', is_error: true };
      }
      try {
        const target = resolvePath(p, ctx?.cwd ?? cwd);
        const data = await fs.readFile(target, 'utf-8');
        const count = data.split(old_string).length - 1;
        if (count === 0) return { result: `edit: \`old_string\` not found in ${target}`, is_error: true };
        if (count > 1 && !replace_all) {
          return { result: `edit: \`old_string\` matches ${count} times; use replace_all`, is_error: true };
        }
        const updated = replace_all ? data.split(old_string).join(new_string) : data.replace(old_string, new_string);
        await fs.writeFile(target, updated, 'utf-8');
        return { result: `edited ${target}: ${count} replacement(s)`, is_error: false };
      } catch (err) {
        return { result: `edit failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    },
  };
}

export function listTool(cwd = process.cwd()): AgentTool {
  return {
    def: toolDef('list', 'List entries of a directory.', {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }),
    guidelines: [],
    handler: async (args, ctx): Promise<ToolCallResult> => {
      const { path: p } = (args ?? {}) as { path?: string };
      try {
        const entries = await fs.readdir(resolvePath(p ?? '.', ctx?.cwd ?? cwd), { withFileTypes: true });
        const lines = entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`);
        return { result: lines.join('\n'), is_error: false };
      } catch (err) {
        return { result: `list failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    },
  };
}
