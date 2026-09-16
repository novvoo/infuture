/**
 * browser-human-demo — 像人一样操作内嵌浏览器（可视化演示脚本）
 *
 * 演示 computer_use 网页分支的底层能力：打开维基百科 → 鼠标滚轮滚动 →
 * 随机点一个站内链接 → 继续漫游。因为底层是无头浏览器（page.mouse 事件
 * 不渲染系统光标），脚本注入一个虚拟光标 overlay（带移动动画），每步
 * 截图保存，肉眼可见鼠标轨迹。
 *
 * 运行：npx tsx scripts/browser-human-demo.mts [步数=6]
 * 截图目录：/tmp/infuture-human-demo/（结束后自动 open 打开）
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec as childExec } from 'node:child_process';
import { CodingToolsClient } from '../packages/coding/src/service/client.ts';

const STEPS = Number(process.argv[2]) || 6;
const OUT_DIR = '/tmp/infuture-human-demo';

const client = new CodingToolsClient({
  onLog: (line) => {
    if (/error|fail/i.test(line)) console.error(line);
  },
});

/** 执行一段浏览器 run 代码（上下文里有 tab / page），返回文本输出。 */
async function run(code: string, timeoutMs = 20000): Promise<string> {
  const res = (await client.call('browser', { action: 'run', name: 'main', code }, timeoutMs)) as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const text = (res?.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (res?.isError) throw new Error(`browser run 失败: ${text}`);
  return text;
}

/** 截图到 OUT_DIR。 */
async function shot(name: string): Promise<string> {
  const dest = path.join(OUT_DIR, `${name}.png`);
  await run(`await tab.screenshot({ silent: true, save: ${JSON.stringify(dest)} }); "ok"`);
  return dest;
}

/** 注入/复位虚拟光标 overlay（导航后页面上下文会重置，每次操作前调用）。 */
const INJECT_CURSOR = `
await tab.evaluate(() => {
  let c = document.getElementById('__infu_cursor__');
  if (c) return;
  c = document.createElement('div');
  c.id = '__infu_cursor__';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.25,.8,.35,1);will-change:transform;';
  c.innerHTML = '<svg width="20" height="26" viewBox="0 0 20 26"><path d="M2 1 L2 20 L7 15 L11 24 L14.5 22.5 L10.5 14 L18 14 Z" fill="#111" stroke="#fff" stroke-width="1.4"/></svg>';
  document.documentElement.appendChild(c);
});
"ok"`;

/** 把虚拟光标移动到页面坐标并同步真实指针（page.mouse.move，产生 hover）。 */
async function moveCursor(x: number, y: number): Promise<void> {
  await run([
    INJECT_CURSOR,
    `await tab.evaluate((x, y) => { document.getElementById('__infu_cursor__').style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, ${x}, ${y});`,
    `await page.mouse.move(${x}, ${y}, { steps: 12 });`,
    `await new Promise(r => setTimeout(r, 500));`,
    `"ok"`,
  ].join('\n'));
}

/** 可见站内链接候选（视口内、非特殊页），返回 [{i, href, text, x, y}]。 */
interface LinkCandidate { i: number; href: string; text: string; x: number; y: number }
async function visibleWikiLinks(): Promise<LinkCandidate[]> {
  const out = await run(
    `const links = await tab.evaluate(() => [...document.querySelectorAll('a[href*="/wiki/"]')]
      .map((el, i) => {
        const r = el.getBoundingClientRect();
        return { i, href: el.href || '', text: (el.textContent || '').trim().slice(0, 40),
                 x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })
      .filter(l => l.w > 8 && l.h > 8 && l.x > 0 && l.x < innerWidth && l.y > 0 && l.y < innerHeight
        && !/\\/wiki\\/[^/]*:/.test(l.href) && l.text));
    JSON.stringify(links)`,
  );
  try {
    return JSON.parse(out) as LinkCandidate[];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await client.start();

  console.log(`▶ 打开维基百科…`);
  await client.call('browser', { action: 'open', url: 'https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5', timeout: 20 });
  await run(`await new Promise(r => setTimeout(r, 2000)); "ok"`);
  let n = 0;
  console.log('  ' + (await shot(`00-open`)));

  for (let step = 1; step <= STEPS; step++) {
    // 1) 像人一样滚两屏
    await moveCursor(680, 380);
    for (const dy of [400, 500, 350]) {
      await run(`await page.mouse.wheel({ deltaY: ${dy} }); await new Promise(r => setTimeout(r, 600)); "ok"`);
      n++;
      await shot(String(n).padStart(2, '0') + '-scroll');
    }
    console.log(`▶ [${step}/${STEPS}] 滚动 3 屏 ✓`);

    // 2) 随机挑一个可见站内链接
    const links = await visibleWikiLinks();
    if (!links.length) { console.log('  没找到可见链接，跳过'); continue; }
    const pick = links[Math.floor(Math.random() * links.length)];
    console.log(`▶ [${step}/${STEPS}] 点击「${pick.text}」`);

    // 3) 光标移动过去 → 真实鼠标点击（坐标级 page.mouse.click）
    await moveCursor(Math.round(pick.x), Math.round(pick.y));
    n++;
    await shot(String(n).padStart(2, '0') + '-hover');
    await run(`try { await page.mouse.click(${Math.round(pick.x)}, ${Math.round(pick.y)}); } catch (e) {} await new Promise(r => setTimeout(r, 2000)); "ok"`, 25000);
    n++;
    console.log('  ' + (await shot(String(n).padStart(2, '0') + '-clicked')));
  }

  const url = await run(`tab.url()`);
  console.log(`\n✓ 漫游结束，当前页面：${url.trim()}`);
  console.log(`✓ 共 ${n + 1} 张截图 → ${OUT_DIR}`);
  childExec(`open ${OUT_DIR}`, () => {});
  client.dispose?.();
  process.exit(0);
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
