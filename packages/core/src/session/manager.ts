/**
 * SessionManager — 会话管理：创建/列出/切换/fork/clone/删除，JSONL 持久化。
 * 对应 Rust `session::manager.rs`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentMessage } from '@infuture/types';
import { Session, type SessionMeta } from './session.js';
import { appendSessionEntry, loadSessionFile } from './persistence.js';
import { generateId } from '../utils/id.js';

export interface ManagerOptions {
  sessionDir?: string;
  defaultModel?: string;
  defaultCwd?: string;
}

export class SessionManager {
  private readonly dir: string;
  private readonly defaultModel: string;
  private defaultCwd: string;
  private sessions = new Map<string, Session>();
  private currentId: string | null = null;

  constructor(options: ManagerOptions = {}) {
    this.dir = options.sessionDir ?? path.join(process.env.HOME ?? '.', '.future', 'agent', 'sessions');
    this.defaultModel = options.defaultModel ?? 'default';
    this.defaultCwd = options.defaultCwd ?? process.cwd();
  }

  /** 更新新建会话的默认工作目录（Engine 解析工作区后调用）。 */
  setDefaultCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }

  private sessionFile(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  private metaFile(id: string): string {
    return path.join(this.dir, `${id}.meta.json`);
  }

  /** 写入会话元数据（name/cwd/model 等），重启后 listAll 仍可恢复名称。 */
  private async saveMeta(meta: SessionMeta): Promise<void> {
    await this.init();
    await fs.writeFile(this.metaFile(meta.id), JSON.stringify(meta, null, 2), 'utf-8');
  }

  private async readMeta(id: string): Promise<SessionMeta | null> {
    try {
      return JSON.parse(await fs.readFile(this.metaFile(id), 'utf-8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** 新建会话。options.id 可指定固定 id（如 IM 通道按用户映射），否则随机生成。 */
  async create(
    name?: string,
    options: { parentId?: string; kind?: 'root' | 'fork' | 'clone'; id?: string; setCurrent?: boolean } = {},
  ): Promise<Session> {
    await this.init();
    const id = options.id ?? generateId('s');
    const meta: SessionMeta = {
      id,
      name: name || 'New conversation',
      model: this.defaultModel,
      cwd: this.defaultCwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentId: options.parentId,
      kind: options.kind ?? 'root',
    };
    const session = new Session(meta);
    this.sessions.set(id, session);
    if (options.setCurrent !== false) this.currentId = id;
    void this.saveMeta(meta);
    return session;
  }

  /** 加载已有会话（惰性）。 */
  async load(id: string): Promise<Session | null> {
    const existing = this.sessions.get(id);
    if (existing) {
      this.currentId = id;
      return existing;
    }
    const entries = await loadSessionFile(this.sessionFile(id));
    if (entries.length === 0 && !(await this.exists(id))) return null;
    const diskMeta = await this.readMeta(id);
    const meta: SessionMeta = diskMeta ?? {
      id,
      name: id,
      model: this.defaultModel,
      cwd: this.defaultCwd,
      createdAt: entries[0]?.ts ?? Date.now(),
      updatedAt: Date.now(),
    };
    const session = new Session(meta);
    session.restoreMessages(entries.map((e) => e.message));
    this.sessions.set(id, session);
    this.currentId = id;
    return session;
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.sessionFile(id));
      return true;
    } catch {
      return false;
    }
  }

  /** 当前会话。 */
  current(): Session | null {
    if (!this.currentId) return null;
    return this.sessions.get(this.currentId) ?? null;
  }

  async setCurrent(id: string): Promise<Session | null> {
    return await this.load(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** 列出磁盘 + 内存会话（懒加载并缓存磁盘会话，供 UI 列表）。 */
  async listAll(): Promise<Session[]> {
    await this.init();
    const diskIds = await this.listDiskIds();
    for (const id of diskIds) {
      if (!this.sessions.has(id)) {
        await this.load(id);
      }
    }
    return [...this.sessions.values()];
  }

  /** 重命名会话并持久化 meta。返回更新后的会话；不存在返回 null。 */
  async rename(id: string, name: string): Promise<Session | null> {
    const session = await this.load(id);
    if (!session) return null;
    const trimmed = name.trim();
    if (!trimmed) return session;
    session.meta.name = trimmed;
    session.meta.updatedAt = Date.now();
    await this.saveMeta(session.meta);
    return session;
  }

  /** fork：复制消息历史到新会话。 */
  async fork(sourceId: string): Promise<Session> {
    const source = await this.load(sourceId);
    if (!source) throw new Error(`session \`${sourceId}\` not found`);
    const copy = await this.create(`${source.meta.name} (fork)`, { parentId: sourceId, kind: 'fork' });
    copy.restoreMessages(source.messages());
    return copy;
  }

  /** 追加消息并持久化。 */
  async appendMessage(session: Session, message: AgentMessage): Promise<void> {
    session.pushMessage(message);
    await appendSessionEntry(this.sessionFile(session.id), message);
  }

  /** 删除会话文件。 */
  async delete(id: string): Promise<boolean> {
    try {
      await fs.rm(this.sessionFile(id));
    } catch {
      // 无文件也继续
    }
    try {
      await fs.rm(this.metaFile(id));
    } catch {
      // 无 meta 也继续
    }
    this.sessions.delete(id);
    if (this.currentId === id) this.currentId = null;
    return true;
  }

  /** 列出磁盘上的会话文件。 */
  async listDiskIds(): Promise<string[]> {
    await this.init();
    const names = await fs.readdir(this.dir);
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.replace(/\.jsonl$/, ''));
  }
}
