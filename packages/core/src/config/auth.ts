/**
 * AuthStore — 认证存储。对应 Rust `auth::AuthStore`。
 * 读写 ~/.future/agent/auth.json：provider → { type, key, baseUrl? }。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultConfigDir } from '../utils/id.js';

export interface AuthEntry {
  type: 'api_key' | 'device';
  key?: string;
  baseUrl?: string;
}

export interface AuthStoreOptions {
  configDir?: string;
}

export class AuthStore {
  private readonly file: string;

  constructor(options: AuthStoreOptions = {}) {
    this.file = path.join(options.configDir ?? defaultConfigDir(), 'auth.json');
  }

  async load(): Promise<Record<string, AuthEntry>> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      return JSON.parse(raw) as Record<string, AuthEntry>;
    } catch {
      return {};
    }
  }

  async save(entries: Record<string, AuthEntry>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(entries, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  async set(provider: string, entry: AuthEntry): Promise<void> {
    const all = await this.load();
    all[provider] = entry;
    await this.save(all);
  }

  async keyFor(provider: string): Promise<string | undefined> {
    const all = await this.load();
    return all[provider]?.key;
  }
}
