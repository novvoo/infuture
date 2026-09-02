/**
 * Skills — 技能发现与加载。对应 Rust `skills`。
 * 从 ~/.future/agent/skills/ 与仓库 skills/ 发现 SKILL.md 技能包。
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { defaultConfigDir } from '../utils/id.js';

export interface Skill {
  name: string;
  dir: string;
  description: string;
  path: string;
}

export const APP_SKILLS_DIR = 'skills';
export const AGENTS_SKILLS_DIR = '.agents/skills';

export function globalSkillDirs(): string[] {
  const home = process.env.HOME ?? '';
  return [
    path.join(defaultConfigDir(), APP_SKILLS_DIR),
    path.join(home, AGENTS_SKILLS_DIR),
  ];
}

export async function discoverSkills(extraDirs: string[] = []): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seen = new Set<string>();
  const dirs = [...globalSkillDirs(), ...extraDirs];

  for (const dir of dirs) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillDir = path.join(dir, e.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      try {
        const content = await fs.readFile(skillFile, 'utf-8');
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        skills.push({
          name: e.name,
          dir: skillDir,
          description: extractDescription(content),
          path: skillFile,
        });
      } catch {
        // 无 SKILL.md 的目录忽略
      }
    }
  }
  return skills;
}

function extractDescription(content: string): string {
  // 取 frontmatter description 或首个段落
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const desc = fm[1].match(/description\s*:\s*(.+)/);
    if (desc) return desc[1].trim();
  }
  const firstPara = content.split('\n\n').find((p) => p.trim().length > 0);
  return firstPara ? firstPara.trim().slice(0, 200) : '';
}
