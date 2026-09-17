import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  compareDateOnly,
  dayOfWeek,
  diffDays,
  todayDateOnly,
  validateDateRange,
} from "../../domain/dateOnly";
import type {
  BoardSnapshot,
  DateOnly,
  MotherTask,
  SubTask,
  ViewMode,
  ViewSettings,
} from "../../domain/models";
import { getMotherSpan } from "../../domain/schedule";
import type { StorageGateway } from "../../storage/gateway";
import {
  getDayColumnWidth,
  getViewRange,
  navigateAnchor,
  type ViewRange,
} from "./viewRange";

interface BoardPageProps {
  gateway: StorageGateway;
}

type BoardRow =
  | { kind: "mother"; mother: MotherTask }
  | { kind: "subTask"; mother: MotherTask; subTask: SubTask }
  | { kind: "empty"; mother: MotherTask };

type MotherDialogState =
  | { mode: "create" }
  | { mode: "rename"; mother: MotherTask };

type SubTaskDialogState =
  | { mode: "create"; mother: MotherTask }
  | { mode: "edit"; mother: MotherTask; subTask: SubTask };

type DeleteTarget =
  | { kind: "mother"; mother: MotherTask }
  | { kind: "subTask"; mother: MotherTask; subTask: SubTask };

interface ToastState {
  tone: "success" | "error";
  message: string;
}

const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const viewLabels: Record<ViewMode, string> = {
  week: "周",
  biweek: "双周",
  month: "月",
};

function buildRows(tasks: MotherTask[], search: string): BoardRow[] {
  const query = search.trim().toLocaleLowerCase();
  const rows: BoardRow[] = [];

  for (const mother of tasks) {
    const motherMatches = mother.name.toLocaleLowerCase().includes(query);
    const matchingSubTasks = query
      ? mother.subTasks.filter((subTask) =>
          subTask.name.toLocaleLowerCase().includes(query),
        )
      : mother.subTasks;

    if (query && !motherMatches && matchingSubTasks.length === 0) {
      continue;
    }

    rows.push({ kind: "mother", mother });
    const shouldShowChildren = query.length > 0 || mother.expanded;
    if (!shouldShowChildren) {
      continue;
    }

    const visibleSubTasks = motherMatches && query ? mother.subTasks : matchingSubTasks;
    for (const subTask of visibleSubTasks) {
      rows.push({ kind: "subTask", mother, subTask });
    }
    if (!query && mother.subTasks.length === 0) {
      rows.push({ kind: "empty", mother });
    }
  }

  return rows;
}

function formatRange(range: ViewRange): string {
  return `${range.startDate.replaceAll("-", "/")} – ${range.endDate.replaceAll("-", "/")}`;
}

function formatShortDate(value: DateOnly): string {
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}

function messageFromError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "操作失败，请重试。";
}

export function BoardPage({ gateway }: BoardPageProps) {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [motherDialog, setMotherDialog] = useState<MotherDialogState | null>(null);
  const [subTaskDialog, setSubTaskDialog] = useState<SubTaskDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const reloadBoard = async () => {
    setLoadError(null);
    try {
      setBoard(await gateway.loadBoard());
    } catch (error) {
      setLoadError(messageFromError(error));
    }
  };

  useEffect(() => {
    let active = true;
    void gateway.loadBoard().then(
      (snapshot) => {
        if (active) {
          setBoard(snapshot);
        }
      },
      (error: unknown) => {
        if (active) {
          setLoadError(messageFromError(error));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const rows = useMemo(
    () => buildRows(board?.tasks ?? [], search),
    [board?.tasks, search],
  );
  const range = useMemo(
    () =>
      board
        ? getViewRange(board.viewSettings.viewMode, board.viewSettings.anchorDate)
        : null,
    [board],
  );

  const runAction = async (
    action: () => Promise<void>,
    successMessage: string,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      setToast({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      setToast({ tone: "error", message: messageFromError(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveViewSettings = async (settings: ViewSettings) => {
    await runAction(async () => {
      await gateway.saveViewSettings(settings);
      setBoard((current) => (current ? { ...current, viewSettings: settings } : current));
    }, "视图设置已保存");
  };

  const handleCreateMother = async (name: string) => {
    const succeeded = await runAction(async () => {
      const mother = await gateway.createMotherTask({ name });
      setBoard((current) =>
        current ? { ...current, tasks: [...current.tasks, mother] } : current,
      );
    }, "已新建母任务");
    if (succeeded) {
      setMotherDialog(null);
    }
  };

  const handleRenameMother = async (mother: MotherTask, name: string) => {
    const succeeded = await runAction(async () => {
      await gateway.renameMotherTask({ id: mother.id, name });
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === mother.id ? { ...task, name: name.trim() } : task,
              ),
            }
          : current,
      );
    }, "母任务名称已更新");
    if (succeeded) {
      setMotherDialog(null);
    }
  };

  const handleToggleMother = async (mother: MotherTask) => {
    await runAction(async () => {
      await gateway.setMotherExpanded({ id: mother.id, expanded: !mother.expanded });
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === mother.id
                  ? { ...task, expanded: !mother.expanded }
                  : task,
              ),
            }
          : current,
      );
    }, mother.expanded ? "已收起母任务" : "已展开母任务");
  };

  const handleSetAllExpanded = async (expanded: boolean) => {
    if (!board) {
      return;
    }
    const targets = board.tasks.filter((task) => task.expanded !== expanded);
    if (targets.length === 0) {
      return;
    }
    await runAction(async () => {
      await Promise.all(
        targets.map((task) =>
          gateway.setMotherExpanded({ id: task.id, expanded }),
        ),
      );
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) => ({ ...task, expanded })),
            }
          : current,
      );
    }, expanded ? "已展开全部母任务" : "已收起全部母任务");
  };

  const handleCreateSubTask = async (
    mother: MotherTask,
    values: SubTaskFormValues,
  ) => {
    const succeeded = await runAction(async () => {
      const subTask = await gateway.createSubTask({
        motherTaskId: mother.id,
        ...values,
      });
      if (!mother.expanded) {
        await gateway.setMotherExpanded({ id: mother.id, expanded: true });
      }
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === mother.id
                  ? {
                      ...task,
                      expanded: true,
                      subTasks: [...task.subTasks, subTask],
                    }
                  : task,
              ),
            }
          : current,
      );
    }, "已添加子任务");
    if (succeeded) {
      setSubTaskDialog(null);
    }
  };

  const handleUpdateSubTask = async (
    mother: MotherTask,
    subTask: SubTask,
    values: SubTaskFormValues,
  ) => {
    const succeeded = await runAction(async () => {
      await gateway.updateSubTask({ id: subTask.id, ...values });
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === mother.id
                  ? {
                      ...task,
                      subTasks: task.subTasks.map((item) =>
                        item.id === subTask.id ? { ...item, ...values } : item,
                      ),
                    }
                  : task,
              ),
            }
          : current,
      );
    }, "子任务已更新");
    if (succeeded) {
      setSubTaskDialog(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    if (deleteTarget.kind === "mother") {
      const { mother } = deleteTarget;
      const succeeded = await runAction(async () => {
        await gateway.deleteMotherTask(mother.id);
        setBoard((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks
                  .filter((task) => task.id !== mother.id)
                  .map((task) => ({
                    ...task,
                    dependsOn: task.dependsOn.filter((id) => id !== mother.id),
                  })),
              }
            : current,
        );
      }, "母任务及相关数据已删除");
      if (succeeded) {
        setDeleteTarget(null);
      }
      return;
    }

    const { mother, subTask } = deleteTarget;
    const succeeded = await runAction(async () => {
      await gateway.deleteSubTask(subTask.id);
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === mother.id
                  ? {
                      ...task,
                      subTasks: task.subTasks.filter((item) => item.id !== subTask.id),
                    }
                  : task,
              ),
            }
          : current,
      );
    }, "子任务已删除");
    if (succeeded) {
      setDeleteTarget(null);
      setSubTaskDialog(null);
    }
  };

  if (loadError) {
    return (
      <main className="state-screen">
        <div className="state-card" role="alert">
          <span className="state-card__icon">!</span>
          <h1>无法打开本地规划</h1>
          <p>{loadError}</p>
          <button className="button button--primary" onClick={() => void reloadBoard()}>
            重试
          </button>
        </div>
      </main>
    );
  }

  if (!board || !range) {
    return (
      <main className="state-screen" aria-busy="true">
        <div className="loading-indicator" />
        <p>正在打开本地规划…</p>
      </main>
    );
  }

  const allExpanded = board.tasks.every((task) => task.expanded);

  return (
    <main className="planner-shell">
      <PlannerHeader />
      <section className="planner-toolbar" aria-label="时间板工具栏">
        <div className="period-controls">
          <button
            aria-label="上一周期"
            className="icon-button"
            disabled={busy}
            onClick={() =>
              void saveViewSettings({
                ...board.viewSettings,
                anchorDate: navigateAnchor(
                  board.viewSettings.viewMode,
                  board.viewSettings.anchorDate,
                  -1,
                ),
              })
            }
          >
            ←
          </button>
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() =>
              void saveViewSettings({
                ...board.viewSettings,
                anchorDate: todayDateOnly(),
              })
            }
          >
            今天
          </button>
          <button
            aria-label="下一周期"
            className="icon-button"
            disabled={busy}
            onClick={() =>
              void saveViewSettings({
                ...board.viewSettings,
                anchorDate: navigateAnchor(
                  board.viewSettings.viewMode,
                  board.viewSettings.anchorDate,
                  1,
                ),
              })
            }
          >
            →
          </button>
          <strong className="period-label">{formatRange(range)}</strong>
        </div>

        <div className="toolbar-actions">
          <div className="segmented-control" aria-label="视图模式">
            {(Object.keys(viewLabels) as ViewMode[]).map((viewMode) => (
              <button
                aria-pressed={board.viewSettings.viewMode === viewMode}
                className={
                  board.viewSettings.viewMode === viewMode
                    ? "segmented-control__item is-active"
                    : "segmented-control__item"
                }
                disabled={busy}
                key={viewMode}
                onClick={() =>
                  void saveViewSettings({
                    ...board.viewSettings,
                    viewMode,
                  })
                }
              >
                {viewLabels[viewMode]}
              </button>
            ))}
          </div>
          <label className="search-field">
            <span aria-hidden="true">⌕</span>
            <span className="sr-only">搜索母任务或子任务</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索任务"
              type="search"
              value={search}
            />
          </label>
          {board.tasks.length > 0 ? (
            <button
              className="button button--quiet"
              disabled={busy}
              onClick={() => void handleSetAllExpanded(!allExpanded)}
            >
              {allExpanded ? "全部收起" : "全部展开"}
            </button>
          ) : null}
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => setMotherDialog({ mode: "create" })}
          >
            ＋ 新建母任务
          </button>
        </div>
      </section>

      {board.tasks.length === 0 ? (
        <EmptyBoard onCreate={() => setMotherDialog({ mode: "create" })} />
      ) : rows.length === 0 ? (
        <div className="no-results">
          <span>没有找到“{search}”</span>
          <button className="text-button" onClick={() => setSearch("")}>
            清除搜索
          </button>
        </div>
      ) : (
        <TimelineBoard
          busy={busy}
          onAddSubTask={(mother) => setSubTaskDialog({ mode: "create", mother })}
          onEditMother={(mother) => setMotherDialog({ mode: "rename", mother })}
          onEditSubTask={(mother, subTask) =>
            setSubTaskDialog({ mode: "edit", mother, subTask })
          }
          onRequestDeleteMother={(mother) =>
            setDeleteTarget({ kind: "mother", mother })
          }
          onToggleMother={(mother) => void handleToggleMother(mother)}
          range={range}
          rows={rows}
          viewMode={board.viewSettings.viewMode}
        />
      )}

      {motherDialog ? (
        <MotherTaskDialog
          busy={busy}
          initialName={motherDialog.mode === "rename" ? motherDialog.mother.name : ""}
          mode={motherDialog.mode}
          onCancel={() => setMotherDialog(null)}
          onDelete={
            motherDialog.mode === "rename"
              ? () => {
                  setDeleteTarget({ kind: "mother", mother: motherDialog.mother });
                  setMotherDialog(null);
                }
              : undefined
          }
          onSubmit={(name) =>
            motherDialog.mode === "create"
              ? handleCreateMother(name)
              : handleRenameMother(motherDialog.mother, name)
          }
        />
      ) : null}

      {subTaskDialog ? (
        <SubTaskDialog
          busy={busy}
          initial={
            subTaskDialog.mode === "edit" ? subTaskDialog.subTask : undefined
          }
          mode={subTaskDialog.mode}
          motherName={subTaskDialog.mother.name}
          onCancel={() => setSubTaskDialog(null)}
          onDelete={
            subTaskDialog.mode === "edit"
              ? () => {
                  setDeleteTarget({
                    kind: "subTask",
                    mother: subTaskDialog.mother,
                    subTask: subTaskDialog.subTask,
                  });
                  setSubTaskDialog(null);
                }
              : undefined
          }
          onSubmit={(values) =>
            subTaskDialog.mode === "create"
              ? handleCreateSubTask(subTaskDialog.mother, values)
              : handleUpdateSubTask(
                  subTaskDialog.mother,
                  subTaskDialog.subTask,
                  values,
                )
          }
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          busy={busy}
          description={
            deleteTarget.kind === "mother"
              ? `将同时删除“${deleteTarget.mother.name}”下的全部子任务及相关依赖，此操作无法撤销。`
              : `确定删除子任务“${deleteTarget.subTask.name}”吗？此操作无法撤销。`
          }
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleConfirmDelete()}
          title={deleteTarget.kind === "mother" ? "删除母任务" : "删除子任务"}
        />
      ) : null}

      {toast ? (
        <div className={`toast toast--${toast.tone}`} role="status">
          {toast.message}
        </div>
      ) : null}
    </main>
  );
}

function PlannerHeader() {
  return (
    <header className="planner-header">
      <div className="brand-lockup">
        <span className="brand-lockup__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M5 6h14M5 12h9M5 18h14" stroke="currentColor" strokeWidth="2" />
            <circle cx="16.5" cy="12" r="2.5" fill="currentColor" />
          </svg>
        </span>
        <span>
          <strong>工作规划时间板</strong>
          <small>LOCAL PLANNER</small>
        </span>
      </div>
      <span className="local-status">
        <i aria-hidden="true" />
        本地自动保存
      </span>
    </header>
  );
}

interface TimelineBoardProps {
  rows: BoardRow[];
  range: ViewRange;
  viewMode: ViewMode;
  busy: boolean;
  onToggleMother: (mother: MotherTask) => void;
  onEditMother: (mother: MotherTask) => void;
  onRequestDeleteMother: (mother: MotherTask) => void;
  onAddSubTask: (mother: MotherTask) => void;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
}

function TimelineBoard({
  rows,
  range,
  viewMode,
  busy,
  onToggleMother,
  onEditMother,
  onRequestDeleteMother,
  onAddSubTask,
  onEditSubTask,
}: TimelineBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const baseColumnWidth = getDayColumnWidth(viewMode);
  const rootStyles = window.getComputedStyle(document.documentElement);
  const taskColumnWidth = Number.parseFloat(
    rootStyles.getPropertyValue("--task-column-width"),
  ) || 348;
  const availableTimelineWidth = Math.max(0, viewportWidth - taskColumnWidth - 2);
  const columnWidth = Math.max(
    baseColumnWidth,
    availableTimelineWidth / range.dates.length,
  );
  const timelineWidth = range.dates.length * columnWidth;
  const today = todayDateOnly();
  const todayIndex = range.dates.indexOf(today);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setViewportWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="board-frame" aria-label="工作规划时间板">
      <div className="board-scroll" ref={scrollRef}>
        <div
          className="board-grid"
          style={{ "--timeline-width": `${timelineWidth}px` } as React.CSSProperties}
        >
          <div className="task-column">
            <div className="task-column__header">母任务 / 子任务</div>
            {rows.map((row) => (
              <TaskTreeRow
                busy={busy}
                key={row.kind === "subTask" ? row.subTask.id : `${row.kind}-${row.mother.id}`}
                onAddSubTask={onAddSubTask}
                onEditMother={onEditMother}
                onEditSubTask={onEditSubTask}
                onRequestDeleteMother={onRequestDeleteMother}
                onToggleMother={onToggleMother}
                row={row}
              />
            ))}
          </div>

          <div className="timeline-column" style={{ width: timelineWidth }}>
            <div
              className="date-header"
              style={{ gridTemplateColumns: `repeat(${range.dates.length}, ${columnWidth}px)` }}
            >
              {range.dates.map((date) => {
                const weekday = dayOfWeek(date);
                return (
                  <div
                    className={`date-cell ${weekday === 0 || weekday === 6 ? "is-weekend" : ""} ${date === today ? "is-today" : ""}`}
                    key={date}
                  >
                    <strong>{formatShortDate(date)}</strong>
                    <span>{weekdayLabels[weekday]}</span>
                  </div>
                );
              })}
            </div>
            <div className="timeline-rows">
              {todayIndex >= 0 ? (
                <div
                  aria-hidden="true"
                  className="today-line"
                  style={{ left: todayIndex * columnWidth + columnWidth / 2 }}
                />
              ) : null}
              {rows.map((row) => (
                <TimelineRow
                  columnWidth={columnWidth}
                  key={row.kind === "subTask" ? row.subTask.id : `${row.kind}-${row.mother.id}`}
                  onEditSubTask={onEditSubTask}
                  range={range}
                  row={row}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface TaskTreeRowProps {
  row: BoardRow;
  busy: boolean;
  onToggleMother: (mother: MotherTask) => void;
  onEditMother: (mother: MotherTask) => void;
  onRequestDeleteMother: (mother: MotherTask) => void;
  onAddSubTask: (mother: MotherTask) => void;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
}

function TaskTreeRow({
  row,
  busy,
  onToggleMother,
  onEditMother,
  onRequestDeleteMother,
  onAddSubTask,
  onEditSubTask,
}: TaskTreeRowProps) {
  if (row.kind === "mother") {
    return (
      <div className="task-row task-row--mother">
        <button
          aria-label={row.mother.expanded ? "收起母任务" : "展开母任务"}
          className="tree-toggle"
          disabled={busy}
          onClick={() => onToggleMother(row.mother)}
        >
          {row.mother.expanded ? "⌄" : "›"}
        </button>
        <button
          className="task-name task-name--mother"
          disabled={busy}
          onClick={() => onEditMother(row.mother)}
          title="编辑母任务"
        >
          {row.mother.name}
        </button>
        <span className="task-count">{row.mother.subTasks.length}</span>
        <div className="row-actions">
          <button
            aria-label={`为“${row.mother.name}”添加子任务`}
            className="row-action"
            disabled={busy}
            onClick={() => onAddSubTask(row.mother)}
          >
            ＋ 子任务
          </button>
          <button
            aria-label={`删除母任务“${row.mother.name}”`}
            className="row-action row-action--danger"
            disabled={busy}
            onClick={() => onRequestDeleteMother(row.mother)}
            title="删除母任务"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  if (row.kind === "empty") {
    return (
      <div className="task-row task-row--empty">
        <button
          className="empty-row-action"
          disabled={busy}
          onClick={() => onAddSubTask(row.mother)}
        >
          ＋ 添加第一个子任务
        </button>
      </div>
    );
  }

  return (
    <div className="task-row task-row--subtask">
      <span className="tree-branch" aria-hidden="true" />
      <button
        className="task-name"
        disabled={busy}
        onClick={() => onEditSubTask(row.mother, row.subTask)}
        title="编辑子任务"
      >
        {row.subTask.name}
      </button>
      <span className="subtask-dates">
        {formatShortDate(row.subTask.startDate)}
        {row.subTask.endDate ? `–${formatShortDate(row.subTask.endDate)}` : ""}
      </span>
    </div>
  );
}

interface TimelineRowProps {
  row: BoardRow;
  range: ViewRange;
  columnWidth: number;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
}

function TimelineRow({ row, range, columnWidth, onEditSubTask }: TimelineRowProps) {
  const rowClass = `timeline-row timeline-row--${row.kind}`;
  const background = (
    <div
      aria-hidden="true"
      className="timeline-row__grid"
      style={{ gridTemplateColumns: `repeat(${range.dates.length}, ${columnWidth}px)` }}
    >
      {range.dates.map((date) => {
        const weekday = dayOfWeek(date);
        return (
          <span
            className={weekday === 0 || weekday === 6 ? "is-weekend" : ""}
            key={date}
          />
        );
      })}
    </div>
  );

  if (row.kind === "empty") {
    return <div className={rowClass}>{background}</div>;
  }

  if (row.kind === "mother") {
    const span = getMotherSpan(row.mother);
    const geometry = span
      ? getBarGeometry(span.startDate, span.endDate, range, columnWidth)
      : null;
    return (
      <div className={rowClass}>
        {background}
        {geometry ? (
          <div
            className="timeline-bar timeline-bar--mother"
            style={{ left: geometry.left, width: geometry.width }}
            title={`${row.mother.name}：${span?.startDate} 至 ${span?.endDate}`}
          />
        ) : null}
      </div>
    );
  }

  const geometry = getBarGeometry(
    row.subTask.startDate,
    row.subTask.endDate ?? row.subTask.startDate,
    range,
    columnWidth,
  );
  return (
    <div className={rowClass}>
      {background}
      {geometry ? (
        <button
          aria-label={`编辑子任务“${row.subTask.name}”`}
          className="timeline-bar timeline-bar--subtask"
          onClick={() => onEditSubTask(row.mother, row.subTask)}
          style={{ left: geometry.left, width: geometry.width }}
          title={`${row.subTask.name}：${row.subTask.startDate} 至 ${row.subTask.endDate ?? row.subTask.startDate}`}
        >
          <span>{row.subTask.name}</span>
        </button>
      ) : null}
    </div>
  );
}

function getBarGeometry(
  startDate: DateOnly,
  endDate: DateOnly,
  range: ViewRange,
  columnWidth: number,
): { left: number; width: number } | null {
  if (
    compareDateOnly(endDate, range.startDate) < 0 ||
    compareDateOnly(startDate, range.endDate) > 0
  ) {
    return null;
  }
  const visibleStart = compareDateOnly(startDate, range.startDate) < 0
    ? range.startDate
    : startDate;
  const visibleEnd = compareDateOnly(endDate, range.endDate) > 0
    ? range.endDate
    : endDate;
  return {
    left: diffDays(range.startDate, visibleStart) * columnWidth + 4,
    width: (diffDays(visibleStart, visibleEnd) + 1) * columnWidth - 8,
  };
}

function EmptyBoard({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty-board">
      <div className="empty-board__illustration" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="eyebrow">从第一项计划开始</p>
      <h1>画板还是空的</h1>
      <p>新建一个母任务并拆分工作，或者稍后通过 JSON 恢复已有规划。</p>
      <div className="empty-board__actions">
        <button
          aria-label="从空白画板新建母任务"
          className="button button--primary"
          onClick={onCreate}
        >
          ＋ 新建母任务
        </button>
        <button className="button button--quiet" disabled title="将在 M6 开放">
          导入 JSON（稍后开放）
        </button>
      </div>
    </section>
  );
}

interface DialogShellProps {
  title: string;
  children: ReactNode;
  onCancel: () => void;
}

function DialogShell({ title, children, onCancel }: DialogShellProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        aria-labelledby="dialog-title"
        aria-modal="true"
        className="modal-card"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-card__header">
          <h2 id="dialog-title">{title}</h2>
          <button aria-label="关闭" className="icon-button" onClick={onCancel}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

interface MotherTaskDialogProps {
  mode: "create" | "rename";
  initialName: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
  onDelete?: () => void;
}

function MotherTaskDialog({
  mode,
  initialName,
  busy,
  onCancel,
  onSubmit,
  onDelete,
}: MotherTaskDialogProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("请输入母任务名称。");
      return;
    }
    setError(null);
    void onSubmit(name);
  };

  return (
    <DialogShell title={mode === "create" ? "新建母任务" : "编辑母任务"} onCancel={onCancel}>
      <form className="form-stack" onSubmit={handleSubmit}>
        <label className="field-label">
          <span>母任务名称</span>
          <input
            autoFocus
            disabled={busy}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        {error ? <p className="field-error">{error}</p> : null}
        <footer className="modal-actions">
          {onDelete ? (
            <button className="button button--danger-quiet" disabled={busy} onClick={onDelete} type="button">
              删除
            </button>
          ) : (
            <span />
          )}
          <div>
            <button className="button button--quiet" disabled={busy} onClick={onCancel} type="button">
              取消
            </button>
            <button className="button button--primary" disabled={busy} type="submit">
              {mode === "create" ? "创建" : "保存"}
            </button>
          </div>
        </footer>
      </form>
    </DialogShell>
  );
}

interface SubTaskFormValues {
  name: string;
  startDate: DateOnly;
  endDate: DateOnly | null;
}

interface SubTaskDialogProps {
  mode: "create" | "edit";
  motherName: string;
  initial?: SubTask;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: SubTaskFormValues) => Promise<void>;
  onDelete?: () => void;
}

function SubTaskDialog({
  mode,
  motherName,
  initial,
  busy,
  onCancel,
  onSubmit,
  onDelete,
}: SubTaskDialogProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [startDate, setStartDate] = useState(initial?.startDate ?? todayDateOnly());
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    try {
      if (!name.trim()) {
        throw new Error("请输入子任务名称。");
      }
      validateDateRange(startDate, endDate || null);
      setError(null);
      void onSubmit({
        name: name.trim(),
        startDate,
        endDate: endDate || null,
      });
    } catch (validationError) {
      setError(messageFromError(validationError));
    }
  };

  return (
    <DialogShell title={mode === "create" ? "添加子任务" : "编辑子任务"} onCancel={onCancel}>
      <form className="form-stack" onSubmit={handleSubmit}>
        <p className="form-context">归属：{motherName}</p>
        <label className="field-label">
          <span>子任务名称</span>
          <input autoFocus disabled={busy} maxLength={200} onChange={(event) => setName(event.target.value)} value={name} />
        </label>
        <div className="date-fields">
          <label className="field-label">
            <span>开始日期</span>
            <input disabled={busy} onChange={(event) => setStartDate(event.target.value)} required type="date" value={startDate} />
          </label>
          <label className="field-label">
            <span>结束日期（可不填）</span>
            <input disabled={busy} min={startDate} onChange={(event) => setEndDate(event.target.value)} type="date" value={endDate} />
          </label>
        </div>
        <p className="field-hint">结束日期不填时按一天处理。</p>
        {error ? <p className="field-error">{error}</p> : null}
        <footer className="modal-actions">
          {onDelete ? (
            <button className="button button--danger-quiet" disabled={busy} onClick={onDelete} type="button">
              删除
            </button>
          ) : (
            <span />
          )}
          <div>
            <button className="button button--quiet" disabled={busy} onClick={onCancel} type="button">
              取消
            </button>
            <button className="button button--primary" disabled={busy} type="submit">
              {mode === "create" ? "添加" : "保存"}
            </button>
          </div>
        </footer>
      </form>
    </DialogShell>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({
  title,
  description,
  busy,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <DialogShell title={title} onCancel={onCancel}>
      <p className="confirm-copy">{description}</p>
      <footer className="modal-actions modal-actions--end">
        <button className="button button--quiet" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="button button--danger" disabled={busy} onClick={onConfirm}>
          确认删除
        </button>
      </footer>
    </DialogShell>
  );
}
