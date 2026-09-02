/**
 * Model Registry — 模型目录。对应 Rust `models::Registry`。
 * 模型全部由用户自行配置（`models.json`），不内置任何官方模型：
 * 用户通过 LLM 配置界面 / `auth login` + 自定义模型添加写入。
 */
import fs from 'node:fs/promises';
import type { Model } from '@infuture/types';

export class Registry {
  private models: Map<string, Model> = new Map();

  constructor(custom: Model[] = []) {
    for (const m of custom) {
      this.models.set(m.id, m);
    }
  }

  get(id: string): Model | undefined {
    return this.models.get(id);
  }

  /** 注册（或覆盖）一个模型。 */
  add(model: Model): void {
    this.models.set(model.id, model);
  }

  /** 移除一个模型；返回是否实际删除。 */
  remove(id: string): boolean {
    return this.models.delete(id);
  }

  /** 全部模型（含 hide 标记，供合并自定义模型）。 */
  listAll(): Model[] {
    return [...this.models.values()];
  }

  list(hideHidden = true): Model[] {
    return [...this.models.values()].filter((m) => !hideHidden || !m.hide);
  }

  /** 从 models.json 加载用户配置的模型。 */
  static async fromFile(filePath: string): Promise<Registry> {
    let custom: Model[] = [];
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as { providers?: Record<string, unknown> };
      if (json.providers) {
        for (const [provider, cfg] of Object.entries(json.providers)) {
          const c = cfg as { baseUrl?: string; apiKey?: string; models?: Model[] };
          for (const m of c.models ?? []) {
            custom.push({
              ...m,
              provider,
              baseUrl: m.baseUrl || c.baseUrl || '',
              apiKey: m.apiKey || c.apiKey,
            });
          }
        }
      }
    } catch {
      // 无自定义文件
    }
    return new Registry(custom);
  }
}

/** 取默认模型：优先指定 id；否则取目录第一个；无任何配置返回 undefined。 */
export function getDefaultModel(registry: Registry, id = ''): Model | undefined {
  if (id && registry.get(id)) return registry.get(id);
  return registry.list()[0];
}
