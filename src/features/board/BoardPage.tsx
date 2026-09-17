import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  compareDateOnly,
  dayOfWeek,
  diffDays,
  todayDateOnly,
  validateDateRange,
} from "../../domain/dateOnly";
import { validateDependencyChange } from "../../domain/dependencies";
import type {
  BoardSnapshot,
  DateOnly,
  MotherTask,
  SubTask,
  ViewMode,
  ViewSettings,
} from "../../domain/models";
import {
  evaluateDependencyConflicts,
  getMotherSpan,
  type DependencyConflict,
} from "../../domain/schedule";
import type { StorageGateway } from "../../storage/gateway";
import {
  moveSubTask,
  pixelsToDayOffset,
  resizeSubTaskEnd,
  resizeSubTaskStart,
  type DateRangeUpdate,
} from "./directManipulation";
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
  | { mode: "create"; mother: MotherTask; initialDate?: DateOnly }
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
  const [dependencyDialog, setDependencyDialog] = useState<MotherTask | null>(null);
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
  const dependencyConflicts = useMemo(
    () => evaluateDependencyConflicts(board?.tasks ?? []),
    [board?.tasks],
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

  const handleDirectUpdate = async (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => {
    if (
      update.startDate === subTask.startDate &&
      update.endDate === subTask.endDate
    ) {
      return;
    }

    const applyDates = (current: BoardSnapshot | null, dates: DateRangeUpdate) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((task) =>
              task.id === mother.id
                ? {
                    ...task,
                    subTasks: task.subTasks.map((item) =>
                      item.id === subTask.id ? { ...item, ...dates } : item,
                    ),
                  }
                : task,
            ),
          }
        : current;

    setBoard((current) => applyDates(current, update));
    setBusy(true);
    try {
      await gateway.updateSubTask({
        id: subTask.id,
        name: subTask.name,
        ...update,
      });
      setToast({
        tone: "success",
        message: `已将“${subTask.name}”调整为 ${update.startDate} – ${update.endDate ?? update.startDate}`,
      });
    } catch (error) {
      setBoard((current) =>
        applyDates(current, {
          startDate: subTask.startDate,
          endDate: subTask.endDate,
        }),
      );
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
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

  const handleSetDependencies = async (
    mother: MotherTask,
    dependsOn: string[],
  ) => {
    if (!board) {
      return;
    }
    const succeeded = await runAction(async () => {
      validateDependencyChange(board.tasks, mother.id, dependsOn);
      const savedDependencies = await gateway.setDependencies({
        taskId: mother.id,
        dependsOn,
      });
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === mother.id
                  ? { ...task, dependsOn: savedDependencies }
                  : task,
              ),
            }
          : current,
      );
    }, "需求依赖已保存");
    if (succeeded) {
      setDependencyDialog(null);
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
          <label className="dependency-toggle">
            <input
              checked={board.viewSettings.showDependencies}
              disabled={busy}
              onChange={(event) =>
                void saveViewSettings({
                  ...board.viewSettings,
                  showDependencies: event.target.checked,
                })
              }
              type="checkbox"
            />
            显示依赖
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
          onDirectUpdate={(mother, subTask, update) =>
            void handleDirectUpdate(mother, subTask, update)
          }
          onEditMother={(mother) => setMotherDialog({ mode: "rename", mother })}
          onEditSubTask={(mother, subTask) =>
            setSubTaskDialog({ mode: "edit", mother, subTask })
          }
          onRequestDeleteMother={(mother) =>
            setDeleteTarget({ kind: "mother", mother })
          }
          onSetDependencies={setDependencyDialog}
          onQuickAdd={(mother, initialDate) =>
            setSubTaskDialog({ mode: "create", mother, initialDate })
          }
          onToggleMother={(mother) => void handleToggleMother(mother)}
          range={range}
          rows={rows}
          tasks={board.tasks}
          viewMode={board.viewSettings.viewMode}
          conflicts={dependencyConflicts}
          showDependencies={board.viewSettings.showDependencies}
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
          initialDate={
            subTaskDialog.mode === "create"
              ? subTaskDialog.initialDate
              : undefined
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

      {dependencyDialog ? (
        <DependencyDialog
          busy={busy}
          mother={dependencyDialog}
          onCancel={() => setDependencyDialog(null)}
          onSubmit={(dependsOn) =>
            handleSetDependencies(dependencyDialog, dependsOn)
          }
          tasks={board.tasks}
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
  tasks: MotherTask[];
  range: ViewRange;
  viewMode: ViewMode;
  busy: boolean;
  conflicts: DependencyConflict[];
  showDependencies: boolean;
  onToggleMother: (mother: MotherTask) => void;
  onEditMother: (mother: MotherTask) => void;
  onRequestDeleteMother: (mother: MotherTask) => void;
  onSetDependencies: (mother: MotherTask) => void;
  onAddSubTask: (mother: MotherTask) => void;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
  onQuickAdd: (mother: MotherTask, initialDate: DateOnly) => void;
  onDirectUpdate: (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => void;
}

function TimelineBoard({
  rows,
  tasks,
  range,
  viewMode,
  busy,
  conflicts,
  showDependencies,
  onToggleMother,
  onEditMother,
  onRequestDeleteMother,
  onSetDependencies,
  onAddSubTask,
  onEditSubTask,
  onQuickAdd,
  onDirectUpdate,
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
  const [focusedMotherId, setFocusedMotherId] = useState<string | null>(null);
  const conflictMotherIds = useMemo(
    () => new Set(conflicts.map((conflict) => conflict.taskId)),
    [conflicts],
  );
  const relatedMotherIds = useMemo(() => {
    if (!focusedMotherId) {
      return new Set<string>();
    }
    const related = new Set([focusedMotherId]);
    const focused = tasks.find((task) => task.id === focusedMotherId);
    for (const dependencyId of focused?.dependsOn ?? []) {
      related.add(dependencyId);
    }
    for (const task of tasks) {
      if (task.dependsOn.includes(focusedMotherId)) {
        related.add(task.id);
      }
    }
    return related;
  }, [focusedMotherId, tasks]);

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
          style={{ "--timeline-width": `${timelineWidth}px` } as CSSProperties}
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
                onSetDependencies={onSetDependencies}
                onToggleMother={onToggleMother}
                conflict={conflictMotherIds.has(row.mother.id)}
                focusedMotherId={focusedMotherId}
                relatedMotherIds={relatedMotherIds}
                onFocusMother={setFocusedMotherId}
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
                  busy={busy}
                  key={row.kind === "subTask" ? row.subTask.id : `${row.kind}-${row.mother.id}`}
                  onDirectUpdate={onDirectUpdate}
                  onEditSubTask={onEditSubTask}
                  onFocusMother={setFocusedMotherId}
                  onQuickAdd={onQuickAdd}
                  focusedMotherId={focusedMotherId}
                  relatedMotherIds={relatedMotherIds}
                  range={range}
                  row={row}
                />
              ))}
              {showDependencies ? (
                <DependencyLayer
                  columnWidth={columnWidth}
                  conflicts={conflicts}
                  focusedMotherId={focusedMotherId}
                  range={range}
                  rows={rows}
                  tasks={tasks}
                />
              ) : null}
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
  onSetDependencies: (mother: MotherTask) => void;
  onAddSubTask: (mother: MotherTask) => void;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
  conflict: boolean;
  focusedMotherId: string | null;
  relatedMotherIds: Set<string>;
  onFocusMother: (motherId: string | null) => void;
}

function TaskTreeRow({
  row,
  busy,
  onToggleMother,
  onEditMother,
  onRequestDeleteMother,
  onSetDependencies,
  onAddSubTask,
  onEditSubTask,
  conflict,
  focusedMotherId,
  relatedMotherIds,
  onFocusMother,
}: TaskTreeRowProps) {
  const focusClass = focusedMotherId
    ? relatedMotherIds.has(row.mother.id)
      ? "is-related"
      : "is-dimmed"
    : "";
  if (row.kind === "mother") {
    return (
      <div
        className={`task-row task-row--mother ${conflict ? "has-conflict" : ""} ${focusClass}`}
        onMouseEnter={() => onFocusMother(row.mother.id)}
        onMouseLeave={() => onFocusMother(null)}
      >
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
        {row.mother.dependsOn.length > 0 ? (
          <button
            className="dependency-badge"
            disabled={busy}
            onClick={() => onSetDependencies(row.mother)}
          >
            依赖 {row.mother.dependsOn.length}
          </button>
        ) : null}
        {conflict ? (
          <span className="conflict-indicator" title="当前排期与前置需求存在冲突">
            ⚠
          </span>
        ) : null}
        <div className="row-actions">
          <button
            aria-label={`设置“${row.mother.name}”的依赖`}
            className="row-action"
            disabled={busy}
            onClick={() => onSetDependencies(row.mother)}
          >
            依赖
          </button>
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
      <div className={`task-row task-row--empty ${focusClass}`}>
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
    <div className={`task-row task-row--subtask ${focusClass}`}>
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
  busy: boolean;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
  onQuickAdd: (mother: MotherTask, initialDate: DateOnly) => void;
  onDirectUpdate: (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => void;
  focusedMotherId: string | null;
  relatedMotherIds: Set<string>;
  onFocusMother: (motherId: string | null) => void;
}

function TimelineRow({
  row,
  range,
  columnWidth,
  busy,
  onEditSubTask,
  onQuickAdd,
  onDirectUpdate,
  focusedMotherId,
  relatedMotherIds,
  onFocusMother,
}: TimelineRowProps) {
  const focusClass = focusedMotherId
    ? relatedMotherIds.has(row.mother.id)
      ? "is-related"
      : "is-dimmed"
    : "";
  const rowClass = `timeline-row timeline-row--${row.kind} ${focusClass}`;
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
    return (
      <div
        className={rowClass}
        onMouseEnter={() => onFocusMother(row.mother.id)}
        onMouseLeave={() => onFocusMother(null)}
      >
        {background}
      </div>
    );
  }

  if (row.kind === "mother") {
    const span = getMotherSpan(row.mother);
    const geometry = span
      ? getBarGeometry(span.startDate, span.endDate, range, columnWidth)
      : null;
    return (
      <div
        className={`${rowClass} timeline-row--quick-add`}
        data-testid={`mother-timeline-${row.mother.id}`}
        onMouseEnter={() => onFocusMother(row.mother.id)}
        onMouseLeave={() => onFocusMother(null)}
        onDoubleClick={(event) => {
          if (busy) {
            return;
          }
          const rectangle = event.currentTarget.getBoundingClientRect();
          const rawIndex = Math.floor(
            (event.clientX - rectangle.left) / columnWidth,
          );
          const dayIndex = Math.max(0, Math.min(range.dates.length - 1, rawIndex));
          onQuickAdd(row.mother, range.dates[dayIndex]);
        }}
        title="双击日期快速添加子任务"
      >
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
    <div
      className={rowClass}
      onMouseEnter={() => onFocusMother(row.mother.id)}
      onMouseLeave={() => onFocusMother(null)}
    >
      {background}
      {geometry ? (
        <InteractiveTaskBar
          busy={busy}
          columnWidth={columnWidth}
          geometry={geometry}
          mother={row.mother}
          onCommit={onDirectUpdate}
          onEdit={onEditSubTask}
          subTask={row.subTask}
        />
      ) : null}
    </div>
  );
}

interface DependencyLayerProps {
  rows: BoardRow[];
  tasks: MotherTask[];
  range: ViewRange;
  columnWidth: number;
  conflicts: DependencyConflict[];
  focusedMotherId: string | null;
}

function DependencyLayer({
  rows,
  tasks,
  range,
  columnWidth,
  conflicts,
  focusedMotherId,
}: DependencyLayerProps) {
  const rowCenters = new Map<string, number>();
  let totalHeight = 0;
  for (const row of rows) {
    const rowHeight = row.kind === "mother" ? 48 : 44;
    if (row.kind === "mother") {
      rowCenters.set(row.mother.id, totalHeight + rowHeight / 2);
    }
    totalHeight += rowHeight;
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const conflictKeys = new Set(
    conflicts.map(
      (conflict) => `${conflict.dependsOnTaskId}->${conflict.taskId}`,
    ),
  );
  const paths: Array<{
    key: string;
    d: string;
    conflict: boolean;
    related: boolean;
  }> = [];

  for (const target of tasks) {
    const targetY = rowCenters.get(target.id);
    const targetSpan = getMotherSpan(target);
    if (targetY === undefined || !targetSpan) {
      continue;
    }
    const targetGeometry = getBarGeometry(
      targetSpan.startDate,
      targetSpan.endDate,
      range,
      columnWidth,
    );
    if (!targetGeometry) {
      continue;
    }

    for (const sourceId of target.dependsOn) {
      const source = tasksById.get(sourceId);
      const sourceY = rowCenters.get(sourceId);
      const sourceSpan = source ? getMotherSpan(source) : null;
      if (!source || sourceY === undefined || !sourceSpan) {
        continue;
      }
      const sourceGeometry = getBarGeometry(
        sourceSpan.startDate,
        sourceSpan.endDate,
        range,
        columnWidth,
      );
      if (!sourceGeometry) {
        continue;
      }

      const startX = sourceGeometry.left + sourceGeometry.width;
      const endX = targetGeometry.left;
      const controlX =
        endX >= startX ? (startX + endX) / 2 : Math.max(startX, endX) + 34;
      paths.push({
        key: `${sourceId}->${target.id}`,
        d: `M ${startX} ${sourceY} C ${controlX} ${sourceY}, ${controlX} ${targetY}, ${endX} ${targetY}`,
        conflict: conflictKeys.has(`${sourceId}->${target.id}`),
        related:
          focusedMotherId === null ||
          focusedMotherId === sourceId ||
          focusedMotherId === target.id,
      });
    }
  }

  if (paths.length === 0) {
    return null;
  }

  return (
    <svg
      aria-hidden="true"
      className="dependency-layer"
      height={totalHeight}
      width={range.dates.length * columnWidth}
    >
      <defs>
        <marker
          id="dependency-arrow"
          markerHeight="7"
          markerWidth="7"
          orient="auto"
          refX="6"
          refY="3.5"
        >
          <path d="M 0 0 L 7 3.5 L 0 7 z" fill="#5372ad" />
        </marker>
        <marker
          id="dependency-arrow-conflict"
          markerHeight="7"
          markerWidth="7"
          orient="auto"
          refX="6"
          refY="3.5"
        >
          <path d="M 0 0 L 7 3.5 L 0 7 z" fill="#c23b45" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          className={`dependency-path ${path.conflict ? "is-conflict" : ""} ${path.related ? "is-related" : "is-dimmed"}`}
          d={path.d}
          key={path.key}
          markerEnd={`url(#${path.conflict ? "dependency-arrow-conflict" : "dependency-arrow"})`}
        />
      ))}
    </svg>
  );
}

type InteractionMode = "move" | "resizeStart" | "resizeEnd";

interface ActiveInteraction {
  pointerId: number;
  mode: InteractionMode;
  startX: number;
  dayOffset: number;
  moved: boolean;
}

interface InteractiveTaskBarProps {
  mother: MotherTask;
  subTask: SubTask;
  geometry: { left: number; width: number };
  columnWidth: number;
  busy: boolean;
  onEdit: (mother: MotherTask, subTask: SubTask) => void;
  onCommit: (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => void;
}

function InteractiveTaskBar({
  mother,
  subTask,
  geometry,
  columnWidth,
  busy,
  onEdit,
  onCommit,
}: InteractiveTaskBarProps) {
  const interactionRef = useRef<ActiveInteraction | null>(null);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<{
    update: DateRangeUpdate;
    mode: InteractionMode;
    dayOffset: number;
  } | null>(null);

  const beginInteraction = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (busy || event.button !== 0) {
      return;
    }
    const edge = (event.target as HTMLElement).dataset.edge;
    const mode: InteractionMode =
      edge === "start"
        ? "resizeStart"
        : edge === "end"
          ? "resizeEnd"
          : "move";
    interactionRef.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      dayOffset: 0,
      moved: false,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const updateInteraction = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = interactionRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    const requestedOffset = pixelsToDayOffset(
      event.clientX - active.startX,
      columnWidth,
    );
    const update =
      active.mode === "move"
        ? moveSubTask(subTask, requestedOffset)
        : active.mode === "resizeStart"
          ? resizeSubTaskStart(subTask, requestedOffset)
          : resizeSubTaskEnd(subTask, requestedOffset);
    const effectiveEnd = subTask.endDate ?? subTask.startDate;
    const updatedEnd = update.endDate ?? update.startDate;
    const dayOffset =
      active.mode === "move"
        ? diffDays(subTask.startDate, update.startDate)
        : active.mode === "resizeStart"
          ? diffDays(subTask.startDate, update.startDate)
          : diffDays(effectiveEnd, updatedEnd);

    active.dayOffset = dayOffset;
    active.moved = active.moved || Math.abs(event.clientX - active.startX) >= 4;
    setPreview({ update, mode: active.mode, dayOffset });
  };

  const finishInteraction = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = interactionRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    interactionRef.current = null;
    const update = preview?.update;
    setPreview(null);
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    suppressClickRef.current = active.moved;
    if (active.moved && update && active.dayOffset !== 0) {
      onCommit(mother, subTask, update);
    }
  };

  const cancelInteraction = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = interactionRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    interactionRef.current = null;
    setPreview(null);
  };

  const style = { left: geometry.left, width: geometry.width };
  if (preview) {
    const pixelOffset = preview.dayOffset * columnWidth;
    if (preview.mode === "move") {
      style.left += pixelOffset;
    } else if (preview.mode === "resizeStart") {
      style.left += pixelOffset;
      style.width -= pixelOffset;
    } else {
      style.width += pixelOffset;
    }
  }

  return (
    <button
      aria-label={`编辑子任务“${subTask.name}”`}
      className={`timeline-bar timeline-bar--subtask ${preview ? "is-interacting" : ""}`}
      disabled={busy}
      onClick={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          event.preventDefault();
          return;
        }
        onEdit(mother, subTask);
      }}
      onPointerCancel={cancelInteraction}
      onPointerDown={beginInteraction}
      onPointerMove={updateInteraction}
      onPointerUp={finishInteraction}
      style={style}
      title={`${subTask.name}：${subTask.startDate} 至 ${subTask.endDate ?? subTask.startDate}；拖动调整日期`}
    >
      <span className="resize-handle resize-handle--start" data-edge="start" />
      <span className="timeline-bar__label">{subTask.name}</span>
      <span className="resize-handle resize-handle--end" data-edge="end" />
      {preview ? (
        <span className="drag-preview" role="status">
          {preview.update.startDate} → {preview.update.endDate ?? preview.update.startDate}
        </span>
      ) : null}
    </button>
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
  initialDate?: DateOnly;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: SubTaskFormValues) => Promise<void>;
  onDelete?: () => void;
}

function SubTaskDialog({
  mode,
  motherName,
  initial,
  initialDate,
  busy,
  onCancel,
  onSubmit,
  onDelete,
}: SubTaskDialogProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [startDate, setStartDate] = useState(
    initial?.startDate ?? initialDate ?? todayDateOnly(),
  );
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

interface DependencyDialogProps {
  mother: MotherTask;
  tasks: MotherTask[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (dependsOn: string[]) => Promise<void>;
}

function DependencyDialog({
  mother,
  tasks,
  busy,
  onCancel,
  onSubmit,
}: DependencyDialogProps) {
  const [selected, setSelected] = useState(() => new Set(mother.dependsOn));
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const candidates = tasks.filter(
    (task) =>
      task.id !== mother.id &&
      task.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const dependsOn = tasks
      .filter((task) => selected.has(task.id))
      .map((task) => task.id);
    try {
      validateDependencyChange(tasks, mother.id, dependsOn);
      setError(null);
      void onSubmit(dependsOn);
    } catch (validationError) {
      setError(messageFromError(validationError));
    }
  };

  return (
    <DialogShell title="设置需求依赖" onCancel={onCancel}>
      <form className="form-stack" onSubmit={handleSubmit}>
        <p className="form-context">
          当前母任务：<strong>{mother.name}</strong>
        </p>
        <label className="field-label">
          <span>搜索前置母任务</span>
          <input
            autoFocus
            disabled={busy}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="输入母任务名称"
            type="search"
            value={search}
          />
        </label>
        <div className="dependency-options">
          {candidates.length > 0 ? (
            candidates.map((candidate) => (
              <label className="dependency-option" key={candidate.id}>
                <input
                  checked={selected.has(candidate.id)}
                  disabled={busy}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) {
                        next.add(candidate.id);
                      } else {
                        next.delete(candidate.id);
                      }
                      return next;
                    });
                    setError(null);
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>{candidate.name}</strong>
                  <small>{candidate.subTasks.length} 个子任务</small>
                </span>
              </label>
            ))
          ) : (
            <p className="dependency-options__empty">
              {tasks.length <= 1 ? "暂无其他母任务可选" : "没有匹配的母任务"}
            </p>
          )}
        </div>
        <p className="field-hint">已选择 {selected.size} 个前置母任务。</p>
        {error ? <p className="field-error">{error}</p> : null}
        <footer className="modal-actions modal-actions--end">
          <button className="button button--quiet" disabled={busy} onClick={onCancel} type="button">
            取消
          </button>
          <button className="button button--primary" disabled={busy} type="submit">
            保存依赖
          </button>
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
