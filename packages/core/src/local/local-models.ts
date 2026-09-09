/**
 * LocalModelManager — 本地模型服务管理。
 *
 * 三块能力：
 *  1. 下载本地模型：HuggingFace `snapshot_download`（MLX 量化模型，参考 workspace/minicpmv-web），
 *     后台子进程逐段产出进度，前端轮询 status 获取 downloading 状态。
 *  2. 启动本地模型服务：`python -m mlx_lm server --model <dir> --port <port>`
 *     （Apple Silicon 原生，OpenAI 兼容 API），作为 infuture 服务的子进程（非 detached、
 *     同进程组），服务退出时随父进程一并停止（engine.dispose() → stop() 清理，
 *     终端 Ctrl+C / 进程组 SIGTERM 也会连带终止）。
 *     端口健康探测后**自动注册**：把 /v1/models 探测到的模型逐个写进 engine 模型目录
 *     （registry + models.json，provider='local'）→ LLM 模型菜单"已配置模型"自动出现。
 *  3. 设置：模型根目录、服务端口、自动注册开关，持久化到 <configDir>/local-models.json。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Model } from '@infuture/types';

export const DEFAULT_MODEL_ROOT = path.join(os.homedir(), 'models');
/** MLX 环境 Python（与 workspace/minicpmv-web 一致）。可用 MLX_PYTHON 覆盖。 */
export const MLX_PYTHON =
  process.env.MLX_PYTHON || '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3';
export const DEFAULT_PORT = 8288;

/** 可点击下载的 MLX 模型目录（HuggingFace repo id → 展示名）。 */
export const LOCAL_MODEL_CATALOG: Array<{ repo: string; label: string }> = [
  { repo: 'mlx-community/MiniCPM-V-4.6-4bit', label: 'MiniCPM-V 4.6 (多模态, 4bit, ~5GB)' },
  { repo: 'mlx-community/Qwen3-8B-4bit', label: 'Qwen3 8B (4bit, ~5GB)' },
  { repo: 'mlx-community/Llama-3.1-8B-Instruct-4bit', label: 'Llama 3.1 8B Instruct (4bit, ~5GB)' },
  { repo: 'mlx-community/DeepSeek-R1-Distill-Qwen-7B-4bit', label: 'DeepSeek-R1-Distill Qwen 7B (4bit)' },
  { repo: 'mlx-community/gpt-oss-20b-tq3', label: 'gpt-oss-20b (TQ3, ~10GB)' },
];

export interface LocalModelSettings {
  modelRoot: string;
  port: number;
  /** 服务启动后是否自动把模型注册进 LLM 模型菜单。 */
  autoRegister: boolean;
}

export interface LocalModelEntry {
  /** 目录名（模型 id）。 */
  id: string;
  dir: string;
  installed: boolean;
  repo?: string;
  label?: string;
  /** 该模型是否已注册进模型菜单（provider=local）。 */
  registered: boolean;
}

export interface LocalModelStatus {
  running: boolean;
  port: number;
  modelRoot: string;
  autoRegister: boolean;
  models: LocalModelEntry[];
  /** 正在下载的 repo（dir 名）。 */
  downloading: string[];
  /** 服务当前托管的模型（探测 /v1/models）。 */
  serving: string[];
  /** 已注册进模型菜单的本地模型 id。 */
  registeredIds: string[];
  /** 最近一次服务日志（启动/下载输出的尾部，便于排错）。 */
  logTail: string[];
}

const HF_DOWNLOAD_PY = `
import sys
from huggingface_hub import snapshot_download
p = snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])
print("DONE " + p, flush=True)
`;

export class LocalModelManager {
  private readonly configFile: string;
  private settings: LocalModelSettings = { modelRoot: DEFAULT_MODEL_ROOT, port: DEFAULT_PORT, autoRegister: true };
  private downloading = new Set<string>();
  private downloadLog = new Map<string, string[]>();
  /** 本地模型服务进程 pid（作为 infuture 服务的子进程，随父进程生命周期停止）。 */
  private serverPid: number | null = null;
  private serverLog: string[] = [];

  /**
   * @param configDir 配置目录（放 local-models.json）
   * @param registerModel 自动注册回调：把模型写进 engine.models + models.json（rpc server 注入）
   * @param unregisterModel 停用回调：从 engine.models + models.json 移除指定 id 的本地模型
   */
  constructor(
    private readonly configDir: string,
    private readonly registerModel: (m: Model) => Promise<void>,
    private readonly unregisterModel?: (id: string) => Promise<void>,
  ) {
    this.configFile = path.join(configDir, 'local-models.json');
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configFile, 'utf-8');
      const j = JSON.parse(raw) as Partial<LocalModelSettings>;
      this.settings = {
        modelRoot: j.modelRoot || DEFAULT_MODEL_ROOT,
        port: j.port && Number.isFinite(j.port) ? j.port : DEFAULT_PORT,
        autoRegister: j.autoRegister ?? true,
      };
    } catch {
      // 首次运行：默认设置
    }
    // 若服务进程仍存活（desktop server 重启），恢复 pid 追踪
    try {
      const pidRaw = await fs.readFile(path.join(this.configDir, 'local-server.pid'), 'utf-8');
      const pid = Number(pidRaw.trim());
      if (pid > 0 && process.kill(pid, 0)) this.serverPid = pid;
    } catch {
      // 无 pid 文件
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.writeFile(this.configFile, JSON.stringify(this.settings, null, 2), 'utf-8');
  }

  async setSettings(patch: Partial<LocalModelSettings>): Promise<LocalModelSettings> {
    this.settings = { ...this.settings, ...patch };
    await this.save();
    return this.settings;
  }

  /** 目录名 → 模型 id。 */
  private idOfDir(dir: string): string {
    return path.basename(dir.replace(/\/$/, ''));
  }

  /** 扫描模型根目录下的已安装模型（含手动放入的目录）。 */
  private async installedDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.settings.modelRoot, { withFileTypes: true });
      return entries
        .filter((d) => d.isDirectory())
        .map((d) => path.join(this.settings.modelRoot, d.name));
    } catch {
      return [];
    }
  }

  async status(): Promise<LocalModelStatus> {
    const [installed, registeredIds, rawServing] = await Promise.all([
      this.installedDirs(),
      this.registeredLocalIds(),
      this.probeServing(),
    ]);
    // mlx server 返回的 id 是模型路径，展示时归一化为目录名
    const serving = rawServing.map((m) => (m.startsWith('/') || m.startsWith('~') ? this.idOfDir(m) : m)).filter(Boolean);
    const installedSet = new Set(installed);
    const models: LocalModelEntry[] = [];
    // 注册 id 可能是绝对路径（VLM server 需按 model 字段加载）也可能是目录名，两种都算已注册
    const isRegistered = (dir: string, id: string) => registeredIds.includes(dir) || registeredIds.includes(id);
    for (const c of LOCAL_MODEL_CATALOG) {
      const dir = path.join(this.settings.modelRoot, this.idOfDir(c.repo));
      models.push({
        id: this.idOfDir(c.repo),
        dir,
        installed: installedSet.has(dir),
        repo: c.repo,
        label: c.label,
        registered: isRegistered(dir, this.idOfDir(c.repo)),
      });
    }
    // 额外列出不在目录里的手动放入模型
    for (const dir of installed) {
      if (!models.some((m) => m.dir === dir)) {
        models.push({ id: this.idOfDir(dir), dir, installed: true, registered: isRegistered(dir, this.idOfDir(dir)) });
      }
    }
    const running = this.isAlive(this.serverPid) || serving.length > 0;
    return {
      running,
      port: this.settings.port,
      modelRoot: this.settings.modelRoot,
      autoRegister: this.settings.autoRegister,
      models,
      downloading: [...this.downloading],
      serving,
      registeredIds,
      logTail: [...this.serverLog.slice(-20)],
    };
  }

  /** 探测本地服务（/v1/models），空数组 = 未运行。 */
  private async probeServing(): Promise<string[]> {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(`http://127.0.0.1:${this.settings.port}/v1/models`, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      const j = (await res.json()) as { data?: Array<{ id?: string }> };
      return (j.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 已注册进模型菜单的本地模型（provider=local）。 */
  private async registeredLocalIds(): Promise<string[]> {
    try {
      const raw = await fs.readFile(path.join(this.configDir, 'models.json'), 'utf-8');
      const j = JSON.parse(raw) as { providers?: Record<string, { models?: Array<{ id: string }> }> };
      return (j.providers?.local?.models ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  private isAlive(pid: number | null): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** 启动下载（后台任务，进度经 status().downloading 轮询）。 */
  async download(repo: string): Promise<{ ok: boolean; id: string; message?: string }> {
    const id = this.idOfDir(repo);
    if (this.downloading.has(id)) return { ok: false, id, message: '已在下载中' };
    const dest = path.join(this.settings.modelRoot, id);
    await fs.mkdir(this.settings.modelRoot, { recursive: true });
    this.downloading.add(id);
    this.downloadLog.set(id, []);
    const proc = spawn(MLX_PYTHON, ['-c', HF_DOWNLOAD_PY, repo, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => this.appendDownloadLog(id, String(d)));
    proc.stderr.on('data', (d) => this.appendDownloadLog(id, String(d)));
    proc.on('error', (err) => {
      this.appendDownloadLog(id, `ERROR: ${err.message}`);
      this.downloading.delete(id);
    });
    proc.on('close', (code) => {
      this.appendDownloadLog(id, `exit ${code}`);
      this.downloading.delete(id);
    });
    return { ok: true, id };
  }

  private appendDownloadLog(id: string, text: string): void {
    const arr = this.downloadLog.get(id) ?? [];
    arr.push(text);
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    this.downloadLog.set(id, arr);
  }

  getDownloadLog(id: string): string[] {
    return this.downloadLog.get(id) ?? [];
  }

  /**
   * 判断模型是 VLM（多模态，mlx_vlm server）还是 LLM（mlx_lm server）。
   * 依据 config.json：存在 vision_config / model_type 含 vlm 系特征即视为 VLM。
   */
  private async detectServerKind(dir: string): Promise<'vlm' | 'llm'> {
    try {
      const raw = await fs.readFile(path.join(dir, 'config.json'), 'utf-8');
      const j = JSON.parse(raw) as {
        model_type?: string;
        vision_config?: unknown;
        architectures?: string[];
      };
      if (j.vision_config) return 'vlm';
      const t = (j.model_type ?? '').toLowerCase();
      if (/vlm|minicpmv|llava|qwen2.*vl|phi4.*vision|internvl/.test(t)) return 'vlm';
      if ((j.architectures ?? []).some((a) => /vision|vlm/i.test(a))) return 'vlm';
    } catch {
      // 读不到 config 视为 LLM
    }
    return 'llm';
  }

  /**
   * 启动本地模型服务（作为 infuture 服务的子进程：非 detached、同进程组；
   * 停止 infuture（dispose → stop()）时随之停止，终端 Ctrl+C / 进程组 SIGTERM 也会连带退出）。
   * 等待健康后按 autoRegister 设置自动注册模型到 LLM 模型菜单。
   */
  async start(modelDir?: string, port?: number): Promise<{ ok: boolean; message: string }> {
    const targetPort = port ?? this.settings.port;
    const dir = modelDir ?? (await this.pickModelDir());
    if (!dir) return { ok: false, message: '没有可启动的模型：请先下载或把模型目录放入 ' + this.settings.modelRoot };
    // 若已有服务在跑（同端口），直接复用
    if ((await this.probeServing()).length > 0) {
      if (this.settings.autoRegister) await this.registerServingModels();
      return { ok: true, message: '本地模型服务已在运行，已同步注册模型' };
    }
    const kind = await this.detectServerKind(dir);
    const module = kind === 'vlm' ? 'mlx_vlm' : 'mlx_lm';
    this.serverLog = [];
    this.log(`启动服务(${kind === 'vlm' ? 'VLM' : 'LLM'}): ${MLX_PYTHON} -m ${module} server --model ${dir} --port ${targetPort}`);
    // 非 detached：模型进程成为 infuture 服务的直接子进程（同进程组），
    // 停止 infuture 时（engine.dispose → stop() 或终端/进程组信号）会随之终止。
    const proc = spawn(
      MLX_PYTHON,
      ['-m', module, 'server', '--model', dir, '--port', String(targetPort), '--host', '127.0.0.1'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.serverPid = proc.pid ?? null;
    proc.stderr.on('data', (d: Buffer | string) => this.log(String(d)));
    proc.on('exit', (code) => {
      this.log(`服务退出 exit=${code}`);
      if (this.serverPid === proc.pid) this.serverPid = null;
    });
    if (this.serverPid) {
      await fs.mkdir(this.configDir, { recursive: true });
      await fs.writeFile(path.join(this.configDir, 'local-server.pid'), String(this.serverPid), 'utf-8');
    }
    this.settings.port = targetPort;
    await this.save();

    // 等待健康（MLX 首次加载权重可能 30~120s）
    const deadline = Date.now() + 180_000;
    let serving: string[] = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      serving = await this.probeServing();
      if (serving.length > 0) break;
    }
    if (serving.length === 0) {
      return { ok: false, message: '服务进程已启动但健康检查超时（180s），请查看日志排错' };
    }
    if (this.settings.autoRegister) await this.registerServingModels();
    return { ok: true, message: `本地模型服务已启动（${kind === 'vlm' ? 'VLM' : 'LLM'}），托管模型: ${serving.join(', ')}` };
  }

  /**
   * 停止服务，并**同时停用**所有已注册的本地模型
   * （从 LLM 模型菜单移除，避免留下不可用的模型条目）。
   */
  async stop(): Promise<{ ok: boolean; message: string }> {
    const wasRunning = this.isAlive(this.serverPid) || (await this.probeServing()).length > 0;
    if (this.serverPid && this.isAlive(this.serverPid)) {
      try {
        process.kill(this.serverPid, 'SIGTERM');
      } catch {
        // 已退出
      }
    }
    // 兜底：按端口找进程（兼容 mlx_lm / mlx_vlm 两种服务）
    try {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve) => {
        execFile('/usr/bin/pkill', ['-f', `(mlx_lm|mlx_vlm) server --model .*--port ${this.settings.port}`], () => resolve());
      });
    } catch {
      // pkill 不可用则忽略
    }
    this.serverPid = null;
    await fs.rm(path.join(this.configDir, 'local-server.pid'), { force: true });

    // 停止的同时停用本地模型（模型菜单不再显示不可用的本地模型）
    const registered = await this.registeredLocalIds();
    let deactivated = 0;
    if (this.unregisterModel) {
      for (const id of registered) {
        try {
          await this.unregisterModel(id);
          deactivated += 1;
        } catch {
          // 单个失败不阻断
        }
      }
    }
    return {
      ok: true,
      message: wasRunning
        ? `本地模型服务已停止，并停用 ${deactivated} 个本地模型`
        : `本地模型服务未在运行${deactivated ? `，已清理 ${deactivated} 个失效注册` : ''}`,
    };
  }

  /** 停用单个本地模型（从模型菜单移除其注册，服务仍可继续运行其他模型）。 */
  async deactivate(id: string): Promise<{ ok: boolean; message: string }> {
    if (!this.unregisterModel) return { ok: false, message: 'unregister 回调未注入' };
    // 兼容目录名/路径两种 id：精确匹配，或按目录名匹配注册的路径 id
    const registered = await this.registeredLocalIds();
    const target = registered.find((r) => r === id || path.basename(r) === id);
    if (!target) return { ok: false, message: `本地模型 ${id} 未注册` };
    await this.unregisterModel(target);
    return { ok: true, message: `已停用本地模型 ${id}` };
  }

  /** 测试本地服务：健康探测 + 最小 chat completion 请求。 */
  async test(): Promise<{ ok: boolean; message: string; costMs?: number; sample?: string }> {
    const startedAt = Date.now();
    const serving = await this.probeServing();
    if (serving.length === 0) {
      return { ok: false, message: '本地模型服务未运行（或尚未就绪）' };
    }
    const modelId = serving[0]!;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60_000);
      const res = await fetch(`http://127.0.0.1:${this.settings.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 8,
          temperature: 0,
        }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, message: `服务响应异常: HTTP ${res.status}`, costMs: Date.now() - startedAt };
      }
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = j.choices?.[0]?.message?.content ?? '';
      return {
        ok: true,
        message: `服务正常（${modelId}）`,
        costMs: Date.now() - startedAt,
        sample: content.slice(0, 80),
      };
    } catch (e) {
      return { ok: false, message: `测试请求失败: ${String(e).slice(0, 120)}`, costMs: Date.now() - startedAt };
    }
  }

  /** 重新探测服务模型并同步注册（模型菜单刷新）。 */
  async refresh(): Promise<{ ok: boolean; registered: string[] }> {
    const serving = await this.probeServing();
    if (serving.length === 0) return { ok: true, registered: [] };
    if (this.settings.autoRegister) await this.registerServingModels();
    return { ok: true, registered: await this.registeredLocalIds() };
  }

  private log(text: string): void {
    this.serverLog.push(text);
    if (this.serverLog.length > 500) this.serverLog.splice(0, this.serverLog.length - 500);
  }

  /** 选一个已安装模型目录启动（优先 catalog 第一个已装，否则手动放入的第一个）。 */
  private async pickModelDir(): Promise<string | null> {
    const installed = await this.installedDirs();
    if (installed.length === 0) return null;
    for (const c of LOCAL_MODEL_CATALOG) {
      const dir = path.join(this.settings.modelRoot, this.idOfDir(c.repo));
      if (installed.includes(dir)) return dir;
    }
    return installed[0]!;
  }

  /** 把服务托管的模型注册进 LLM 模型菜单（registry + models.json）。 */
  private async registerServingModels(): Promise<void> {
    const serving = await this.probeServing();
    for (const rawId of serving) {
      const baseUrl = `http://127.0.0.1:${this.settings.port}/v1`;
      // 注册 id 必须能被 server 加载：
      //  - mlx_vlm 是多模型 server，会按请求 model 字段重新加载 → 必须用本地路径
      //  - mlx_lm 是单模型 server，忽略 model 字段 → 路径或目录名均可
      // 统一用原始 serving id（路径），显示名用目录名。
      const mid = rawId || '';
      if (!mid) continue;
      const displayId = mid.startsWith('/') || mid.startsWith('~') ? path.basename(mid) : mid;
      const inputTypes = (await this.detectServerKind(mid)) === 'vlm' ? ['text', 'image'] : ['text'];
      try {
        await this.registerModel({
          id: mid,
          name: `${displayId} (本地)`,
          provider: 'local',
          api: 'openai-completions',
          baseUrl,
          contextWindow: 32768,
          maxTokens: 4096,
          reasoning: false,
          hide: false,
          input_types: inputTypes,
        } as Model);
      } catch {
        // 单个模型注册失败不阻断整体
      }
    }
  }
}
