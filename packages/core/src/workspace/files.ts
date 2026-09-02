/**
 * WorkspaceFiles — 工作台文件管理服务（面向 UI 的 RPC 层，非 agent 工具）。
 * 以会话 cwd（或服务器启动目录）为根，提供 list/read/write/mkdir/remove/rename。
 * 相对路径一律约束在根目录内，防止路径穿越。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface DirEntry {
  name: string;
  /** 相对根目录的路径（目录以 / 结尾），供前端定位。 */
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
}

/** 可安全读取的文本文件扩展名（read 失败时前端仍可降级为"二进制"提示）。 */
export const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'conf', 'sh', 'bash', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java',
  'sql', 'csv', 'log', 'env', 'lock', 'cfg', 'properties', 'vue', 'svelte', 'astro',
]);

export class WorkspaceFiles {
  /** 解析相对根目录的路径；拒绝空路径与越界路径。 */
  resolve(root: string, rel: string): string {
    const clean = (rel || '').trim();
    if (!clean || clean === '.') return path.resolve(root);
    const target = path.isAbsolute(clean) ? path.normalize(clean) : path.resolve(root, clean);
    const relCheck = path.relative(path.resolve(root), target);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`路径越界: ${clean}`);
    }
    return target;
  }

  /** 列出目录条目（不含 . ..）。 */
  async list(root: string, rel = '.'): Promise<DirEntry[]> {
    const dir = this.resolve(root, rel);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (d.name === '.DS_Store') continue;
      const abs = path.join(dir, d.name);
      const relPath = path.relative(path.resolve(root), abs) || d.name;
      let stat: { size?: number; mtime?: number } = {};
      try {
        const s = await fs.stat(abs);
        stat = { size: s.size, mtime: s.mtimeMs };
      } catch {
        // 无法 stat 也照常列出
      }
      entries.push({
        name: d.name,
        path: d.isDirectory() ? `${relPath}/` : relPath,
        isDir: d.isDirectory(),
        size: d.isDirectory() ? undefined : stat.size,
        mtime: stat.mtime,
      });
    }
    // 目录优先，再按名称排序
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return entries;
  }

  /**
   * 只读浏览任意目录（用于界面选择工作区/目录）。不做越界限制——只读无写风险，
   * 供用户主动浏览本机文件系统选择目标目录。返回子目录名列表（含绝对路径）。
   */
  async browse(absPath: string): Promise<{ path: string; dirs: string[] }> {
    const target = path.resolve(absPath || process.cwd());
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const dirs = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'Library' && d.name !== '.git')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    return { path: target, dirs };
  }

  /** 读取文本文件内容。二进制文件抛出错误。 */
  async read(root: string, rel: string): Promise<{ content: string; truncated: boolean; size: number }> {
    const abs = this.resolve(root, rel);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(`是目录而非文件: ${rel}`);
    // 超大文件截断保护（> 2MB 只读前 2MB）
    const MAX = 2 * 1024 * 1024;
    const data = await fs.readFile(abs, { encoding: 'utf-8' });
    const truncated = Buffer.byteLength(data, 'utf-8') > MAX;
    const content = truncated ? data.slice(0, MAX) : data;
    return { content, truncated, size: stat.size };
  }

  /** 写入（覆盖/新建）文件，自动创建父目录。 */
  async write(root: string, rel: string, content: string): Promise<{ bytes: number }> {
    const abs = this.resolve(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return { bytes: Buffer.byteLength(content, 'utf-8') };
  }

  /** 新建目录（含父目录）。 */
  async mkdir(root: string, rel: string): Promise<void> {
    const abs = this.resolve(root, rel);
    await fs.mkdir(abs, { recursive: true });
  }

  /** 删除文件或目录（递归）。 */
  async remove(root: string, rel: string): Promise<{ removed: boolean }> {
    const abs = this.resolve(root, rel);
    if (abs === path.resolve(root)) throw new Error('不能删除工作区根目录');
    await fs.rm(abs, { recursive: true, force: true });
    return { removed: true };
  }

  /** 重命名/移动（仅限根目录内）。 */
  async rename(root: string, from: string, to: string): Promise<void> {
    const absFrom = this.resolve(root, from);
    const absTo = this.resolve(root, to);
    await fs.rename(absFrom, absTo);
  }

  /** 是否为文本扩展名（供前端判断可编辑性）。 */
  isText(name: string): boolean {
    const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
    return TEXT_EXT.has(ext);
  }
}
