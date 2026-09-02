import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppApi } from '../state';
import type { LoopWorker, LoopGoalStatus, WorkerLogEntry } from '../types';

const STATUS_CLASS: Record<string, string> = {
  idle: 'ok',
  running: 'warn',
  done: 'ok',
  stopped: 'err',
  error: 'err',
};

const STATUS_LABEL: Record<string, string> = {
  idle: '待命',
  running: '运行中',
  done: '完成',
  stopped: '已停止',
  error: '出错',
};

const GOAL_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'warn' },
  paused: { label: '暂停', cls: 'accent' },
  done: { label: '完成', cls: 'ok' },
  cancelled: { label: '已取消', cls: 'err' },
};

const TODO_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待办', cls: 'accent' },
  in_progress: { label: '进行中', cls: 'warn' },
  blocked: { label: '受阻', cls: 'err' },
  done: { label: '完成', cls: 'ok' },
  skipped: { label: '跳过', cls: 'dim' },
};

/** 单条 worker 日志的显示类名。 */
function logClass(e: WorkerLogEntry): string {
  switch (e.kind) {
    case 'tool':
      return 'wlog-tool';
    case 'result':
      return 'wlog-result';
    case 'reasoning':
      return 'wlog-reasoning';
    case 'usage':
      return 'wlog-usage';
    case 'status':
      return 'wlog-status';
    case 'error':
      return 'wlog-error';
    default:
      return 'wlog-text';
  }
}

/** worker 运行日志流（只滚动日志容器自身；用户上翻时停止自动跟随，避免被 SSE 流事件复位滚动条）。 */
function WorkerLogs({ logs }: { logs: WorkerLogEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户是否仍在底部附近（上翻阅读时停止跟随）
  const stickToBottom = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs]);
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="worker-log"
      style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6 }}
    >
      {logs.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>暂无日志 — worker 运行后实时显示思考/正文/工具调用</div>
      )}
      {logs.map((e, i) => {
        if (e.kind === 'tool') {
          return (
            <div key={i} className="wlog-line">
              <span className={logClass(e)}>🔧 {e.name}</span>
              {e.detail ? <span style={{ color: 'var(--text-dim)' }}> {e.detail}</span> : null}
            </div>
          );
        }
        if (e.kind === 'result') {
          return (
            <div key={i} className="wlog-line">
              <span className={logClass(e)}>↳ {e.name}:</span>{' '}
              <span style={{ fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.detail}</span>
            </div>
          );
        }
        if (e.kind === 'usage' || e.kind === 'status') {
          return (
            <div key={i} className="wlog-line">
              <span className={logClass(e)}>{e.detail ?? e.text}</span>
            </div>
          );
        }
        return (
          <div key={i} className="wlog-line">
            <span className={logClass(e)}>{e.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function WorkerCard({ w, logs }: { w: LoopWorker; logs: WorkerLogEntry[] }) {
  const { stopWorker, steerWorker, removeWorker } = useAppApi();
  const [steerText, setSteerText] = useState('');

  return (
    <div className="worker-card" style={{ borderColor: 'var(--border)', boxShadow: 'none', marginBottom: 8 }}>
      <div className="worker-head">
        <span className={`badge ${STATUS_CLASS[w.status] ?? 'accent'}`}>{STATUS_LABEL[w.status] ?? w.status}</span>
        <span className="worker-title" style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
          {w.title}
        </span>
        <span className="worker-id" style={{ color: 'var(--text-dim)', fontSize: 10 }}>
          {w.id.slice(0, 12)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0' }}>{w.cwd}</div>
      {w.lastSteer && (
        <div style={{ fontSize: 11, color: 'var(--yellow)' }}>
          指引: {w.lastSteer.instruction}
        </div>
      )}
      <WorkerLogs logs={logs} />
      {w.result && (
        <div className="tool-result" style={{ marginTop: 4 }}>
          {w.result.slice(0, 300)}
        </div>
      )}
      {w.error && <div className="tool-result" style={{ marginTop: 4, color: 'var(--red)' }}>{w.error}</div>}

      <div className="worker-actions" style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
        <input
          className="inp"
          style={{ flex: 1, fontSize: 11, padding: '4px 6px' }}
          placeholder="给 worker 下指令…"
          value={steerText}
          onChange={(e) => setSteerText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && steerText.trim()) {
              void steerWorker(w.id, steerText.trim());
              setSteerText('');
            }
          }}
        />
        <button
          className="btn sm"
          onClick={() => {
            if (steerText.trim()) {
              void steerWorker(w.id, steerText.trim());
              setSteerText('');
            }
          }}
        >
          指引
        </button>
        {(w.status === 'running' || w.status === 'idle') && (
          <button className="btn sm danger" onClick={() => void stopWorker(w.id)}>
            停止
          </button>
        )}
        <button
          className="btn sm ghost"
          title="删除此 worker 记录（运行中的会先停止）"
          onClick={() => void removeWorker(w.id)}
        >
          删除
        </button>
      </div>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div style={{ height: 6, background: 'var(--bg-1, #0f1117)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${value}%`, height: '100%', background: 'var(--accent, #6366f1)', borderRadius: 3 }} />
    </div>
  );
}

/** 目标详情（展开后）：具体事项 + worker + 运行历史 + 日志 + 操作。 */
function GoalDetail({ g }: { g: LoopGoalStatus }) {
  const { workers, workerLogs, goalTodos, goalEvents, loopRuns } = useAppState();
  const { deleteGoal, clearGoalHistory, removeGoalRun } = useAppApi();
  const goalId = g.goalId;
  const goalWorkers = workers.filter((w) => w.goalId === goalId);
  const todos = goalTodos[goalId] ?? [];
  const events = goalEvents[goalId] ?? [];
  const runs = loopRuns.filter((r) => r.goalId === goalId);

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
      {/* 具体事项 */}
      <h4 style={{ margin: '8px 0 4px', fontSize: 12, color: 'var(--text-dim)' }}>具体事项</h4>
      {todos.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '2px 0' }}>暂无事项 — 由 planner 生成或等待推进</div>
      ) : (
        todos.map((t) => (
          <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '2px 0' }}>
            <span className={`badge ${TODO_STATUS[t.status]?.cls ?? 'accent'}`} style={{ fontSize: 10 }}>
              {TODO_STATUS[t.status]?.label ?? t.status}
            </span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{t.title}</span>
            {t.blocker && <span style={{ color: 'var(--red)', fontSize: 11 }}>⚠ {t.blocker}</span>}
            {t.evidence.length > 0 && (
              <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>· 证据 {t.evidence.length}</span>
            )}
          </div>
        ))
      )}

      {/* workers */}
      <h4 style={{ margin: '8px 0 4px', fontSize: 12, color: 'var(--text-dim)' }}>workers（{goalWorkers.length}）</h4>
      {goalWorkers.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '2px 0' }}>暂无 worker</div>
      ) : (
        goalWorkers.map((w) => <WorkerCard key={w.id} w={w} logs={workerLogs[w.id] ?? []} />)
      )}

      {/* 运行历史 */}
      <h4 style={{ margin: '8px 0 4px', fontSize: 12, color: 'var(--text-dim)' }}>运行历史</h4>
      {runs.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '2px 0' }}>暂无运行记录</div>
      ) : (
        runs.map((r, i) => (
          <div key={r.workerId ?? i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, padding: '2px 0', fontFamily: 'var(--mono)' }}>
            <span className={`badge ${STATUS_CLASS[r.status] ?? 'accent'}`} style={{ fontSize: 10 }}>
              {STATUS_LABEL[r.status] ?? r.status}
            </span>
            <span style={{ color: 'var(--text)' }}>{r.title}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 10 }}>{new Date(r.at).toLocaleString()}</span>
            <button
              className="btn sm ghost"
              title="删除此运行记录（停止对应 worker 并清除其历史）"
              onClick={() => {
                if (!r.workerId) return;
                if (window.confirm(`确认删除运行记录「${r.title}」？对应 worker 会停止并从历史移除。`)) {
                  void removeGoalRun(goalId, r.workerId!);
                }
              }}
            >
              删除
            </button>
          </div>
        ))
      )}

      {/* 日志 */}
      <h4 style={{ margin: '8px 0 4px', fontSize: 12, color: 'var(--text-dim)' }}>日志（{events.length}）</h4>
      <div className="worker-log" style={{ maxHeight: 160, overflowY: 'auto' }}>
        {events.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '2px 0' }}>暂无事件日志</div>
        ) : (
          events.map((e, i) => (
            <div key={i} className="wlog-line" style={{ fontSize: 11 }}>
              <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                {e.ts ? new Date(e.ts).toLocaleTimeString() : ''}
              </span>{' '}
              <span className="wlog-status">{e.text}</span>
            </div>
          ))
        )}
      </div>

      {/* 操作 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          className="btn sm ghost"
          title="清理此目标的运行历史：清空 worker/运行/事件历史，但保留目标与其事项（可继续推进）"
          onClick={() => {
            if (window.confirm(`确认清理目标「${g.title}」的运行历史？会清空 worker 记录、运行历史与事件日志，但保留目标本身。`)) {
              void clearGoalHistory(goalId);
            }
          }}
        >
          清理历史
        </button>
        <button
          className="btn sm danger"
          title="彻底清理此目标：停止 worker、删除会话与隔离目录、清除目标全部状态"
          onClick={() => {
            if (window.confirm(`确认彻底清理目标「${g.title}」的全部状态？此操作不可恢复。`)) {
              void deleteGoal(goalId);
            }
          }}
        >
          清理目标
        </button>
      </div>
    </div>
  );
}

/** 单个目标卡片：头部即“状态总览”，点击展开/收起联动到详情（事项/worker/历史/日志）。 */
function GoalCard({ g, expanded, runsCount, onToggle, innerRef }: { g: LoopGoalStatus; expanded: boolean; runsCount?: number; onToggle: () => void; innerRef?: (el: HTMLDivElement | null) => void }) {
  return (
    <div className="worker-card" style={{ marginBottom: 12 }} ref={innerRef}>
      <div className="worker-head" onClick={onToggle} style={{ cursor: 'pointer' }}>
        <span className={`badge ${GOAL_STATUS[g.status]?.cls ?? 'accent'}`}>{GOAL_STATUS[g.status]?.label ?? g.status}</span>
        <span className="worker-title" style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{g.title}</span>
        <span className="worker-id" style={{ color: 'var(--text-dim)', fontSize: 10 }}>{g.goalId.slice(0, 14)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>{g.progress}%</span>
        <span className={`goal-caret ${expanded ? 'open' : ''}`} aria-hidden>▸</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '6px 0' }}>{g.objective.slice(0, 140)}</div>
      <ProgressBar value={g.progress} />
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
        <span>事项 <b style={{ color: 'var(--text)' }}>{g.todos.done}/{g.todos.total}</b>（受阻 {g.todos.blocked}）</span>
        <span>门禁 <b style={{ color: 'var(--text)' }}>{g.gates.passed}/{g.gates.total}</b></span>
        <span>worker <b style={{ color: 'var(--text)' }}>{g.workers.total}</b>（运行 {g.workers.running}）</span>
        <span>历史 <b style={{ color: 'var(--text)' }}>{runsCount ?? 0}</b> 次</span>
        {g.lease && <span>租约 <b style={{ color: 'var(--yellow)' }}>{g.lease.holder}</b></span>}
      </div>
      {g.nextAction && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--green, #6ee7b7)' }}>
          ▶ 下一步: {g.nextAction}
        </div>
      )}
      {expanded && <GoalDetail g={g} />}
    </div>
  );
}

/** 目标菜单（合并原“目标状态”+“目标”）：状态总览条 + 可展开目标详情，一页内联动展示。 */
export function GoalsPanel() {
  const { workers, workerLogs, loopStatus, loopRuns, loopFrontier } = useAppState();
  const { spawnWorkers, loadWorkers, clearAllGoals, refreshLoop, loadGoalTodos, loadGoalEvents } = useAppApi();
  const [goal, setGoal] = useState('');
  const [count, setCount] = useState(3);
  const [isolate, setIsolate] = useState(false);
  // 展开/收起状态（goalId → 是否展开）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // 目标集合 = loopStatus 中的 goal ∪ workers 所属 goal（兼容历史遗留的 worker-only goal）
  const goalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of loopStatus) ids.add(g.goalId);
    for (const w of workers) ids.add(w.goalId);
    return [...ids];
  }, [loopStatus, workers]);

  useEffect(() => {
    void loadWorkers();
    void refreshLoop();
  }, [loadWorkers, refreshLoop]);

  // 加载每个目标的事项与事件日志
  useEffect(() => {
    for (const gid of goalIds) {
      void loadGoalTodos(gid);
      void loadGoalEvents(gid);
    }
  }, [goalIds, loadGoalTodos, loadGoalEvents]);

  // 渲染节：loopStatus 中的 goal + 历史遗留的 worker-only goal（无 goal 对象也展示 worker）
  const sections = useMemo(() => {
    const list: LoopGoalStatus[] = [...loopStatus];
    const known = new Set(loopStatus.map((g) => g.goalId));
    for (const gid of goalIds) {
      if (known.has(gid)) continue;
      const gw = workers.filter((w) => w.goalId === gid);
      const total = gw.length;
      const running = gw.filter((w) => w.status === 'running' || w.status === 'idle').length;
      const done = gw.filter((w) => w.status === 'done').length;
      const stopped = gw.filter((w) => w.status === 'stopped').length;
      const error = gw.filter((w) => w.status === 'error').length;
      // 由 worker 实际状态推导展示状态：有在跑 → 进行中；全部完成 → 完成；其余（全停止/出错）→ 已取消
      const status: LoopGoalStatus['status'] =
        running > 0 ? 'active' : total > 0 && done === total ? 'done' : 'cancelled';
      list.push({
        goalId: gid,
        title: gw[0]?.title ?? gid,
        status,
        objective: gw[0]?.cwd ?? '',
        todos: { total: 0, done: 0, inProgress: 0, pending: 0, blocked: 0, skipped: 0 },
        gates: { total: 0, passed: 0 },
        progress: total === 0 ? 0 : Math.round((done / total) * 100),
        workers: { total, running, done, stopped, error },
      });
    }
    return list;
  }, [loopStatus, workers, goalIds]);

  // 状态总览聚合：全部目标 / 运行中 worker / 完成目标 / 受阻事项
  const stats = useMemo(() => {
    let running = 0;
    let done = 0;
    let blocked = 0;
    let todosTotal = 0;
    for (const g of sections) {
      running += g.workers.running;
      if (g.status === 'done') done += 1;
      blocked += g.todos.blocked;
      todosTotal += g.todos.total;
    }
    return { goals: sections.length, running, done, blocked, todosTotal };
  }, [sections]);

  const toggle = (gid: string) =>
    setExpanded((prev) => ({ ...prev, [gid]: !prev[gid] }));

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    for (const gid of goalIds) next[gid] = true;
    setExpanded(next);
  };
  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const gid of goalIds) next[gid] = false;
    setExpanded(next);
  };

  // 从状态总览条点选某个目标：展开并滚动到其卡片
  const focusGoal = (gid: string) => {
    setExpanded((prev) => ({ ...prev, [gid]: true }));
    requestAnimationFrame(() => {
      cardRefs.current[gid]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const runCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of loopRuns) m[r.goalId] = (m[r.goalId] ?? 0) + 1;
    return m;
  }, [loopRuns]);

  return (
    <div className="worker-panel">
      {/* 标题行：菜单名 + 汇总统计 + 操作 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>目标</h3>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
          {stats.goals} goal · {stats.running} worker 运行中 · {stats.done} 完成 · {stats.blocked} 事项受阻
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn sm" onClick={() => { void refreshLoop(); void loadWorkers(); for (const gid of goalIds) { void loadGoalTodos(gid); void loadGoalEvents(gid); } }} title="刷新">⟳ 刷新</button>
          <button className="btn sm" onClick={expandAll} title="展开全部目标详情">全部展开</button>
          <button className="btn sm" onClick={collapseAll} title="收起全部目标详情">全部收起</button>
          <button
            className="btn sm danger"
            disabled={workers.length === 0 && loopStatus.length === 0}
            title="清空全部目标（goal）的状态：停止所有 worker、删除会话与隔离目录、清除事件历史"
            onClick={() => {
              if (window.confirm('确认清空全部目标状态？将停止所有 worker、删除会话与隔离目录、清除事件历史。此操作不可恢复。')) {
                void clearAllGoals();
              }
            }}
          >
            清空全部目标
          </button>
        </span>
      </div>

      {/* 启动工具栏 */}
      <div className="worker-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="inp"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="目标 / goal 描述…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <input
          className="inp"
          type="number"
          min={1}
          max={10}
          style={{ width: 60 }}
          value={count}
          onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
          title="并行 worker 数"
        />
        <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
          worktree 隔离
        </label>
        <button
          className="btn"
          disabled={!goal.trim()}
          onClick={() => {
            const tasks = Array.from({ length: count }, (_, i) => ({
              title: `探索 ${i + 1}/${count}`,
              prompt: `${goal.trim()}\n\n你是 goal 下的并行探索 worker ${i + 1}/${count}。请独立探索这个目标（可从可行性、风险、实现路径、证据等角度分别切入），用工具收集证据，最后简明汇报你的发现。不要等待其他 worker。`,
            }));
            void spawnWorkers('manual-goal', tasks, isolate);
            setGoal('');
          }}
        >
          启动 {count} 个 worker
        </button>
      </div>

      {goalIds.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: '16px 0' }}>
          暂无目标 — 输入目标并启动并行探索，或用 <span style={{ fontFamily: 'var(--mono)' }}>infuture loop start "目标"</span> 创建
        </div>
      ) : (
        <>
          {/* 状态总览条：全部目标的速览，点选联动到下方详情 */}
          {sections.length > 0 && (
            <div className="goal-overview" style={{ margin: '12px 0' }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>目标状态总览 — 点击跳转到对应目标详情</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {sections.map((g) => (
                  <button
                    key={g.goalId}
                    className="goal-chip"
                    onClick={() => focusGoal(g.goalId)}
                    title={g.title}
                  >
                    <span className={`goal-dot ${GOAL_STATUS[g.status]?.cls ?? 'accent'}`} />
                    <span className="goal-chip-title">{g.title || g.goalId.slice(0, 8)}</span>
                    <span className="goal-chip-meta">{g.progress}% · {runCounts[g.goalId] ?? 0} 次</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 目标详情（手风琴） */}
          <div>
            {sections.map((g) => (
              <GoalCard
                key={g.goalId}
                g={g}
                expanded={!!expanded[g.goalId]}
                runsCount={runCounts[g.goalId] ?? 0}
                onToggle={() => toggle(g.goalId)}
                innerRef={(el) => { cardRefs.current[g.goalId] = el; }}
              />
            ))}
          </div>

          {/* 可推进前沿 */}
          {loopFrontier.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>可推进前沿</h3>
              {loopFrontier.map((t) => (
                <div key={t.id} style={{ fontSize: 12, padding: '4px 0', fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                  ▸ {t.title} <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>({t.goalId.slice(0, 10)})</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
