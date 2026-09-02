/**
 * Session 持久化 — JSONL 会话历史（对应 Rust `session/persistence.rs`）。
 * 每个会话一个 .jsonl 文件，每行一条 {entry_id, role, content} 消息。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentMessage } from '@infuture/types';
import { generateEntryId } from '../utils/id.js';

export interface StoredEntry {
  entry_id: string;
  message: AgentMessage;
  ts: number;
}

export async function loadSessionFile(filePath: string): Promise<StoredEntry[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const entries: StoredEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as StoredEntry);
      } catch {
        // 跳过损坏行
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export async function appendSessionEntry(filePath: string, message: AgentMessage): Promise<StoredEntry> {
  const entry: StoredEntry = {
    entry_id: generateEntryId(),
    message,
    ts: Date.now(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  return entry;
}

export async function saveSessionFile(filePath: string, entries: StoredEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(filePath, lines + (lines ? '\n' : ''), 'utf-8');
}
