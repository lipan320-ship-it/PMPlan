import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  compareDateOnly,
  dayOfWeek,
  diffDays,
  todayDateOnly,
  validateDateRange,
} from "../../domain/dateOnly";
import { validateDependencyChange } from "../../domain/dependencies";
import {
  clampTaskColumnWidth,
  MAX_TASK_COLUMN_WIDTH,
  MIN_TASK_COLUMN_WIDTH,
  MOTHER_TAG_MAX_LENGTH,
  normalizeMotherTag,
  type BoardSnapshot,
  type DateOnly,
  type MotherSortMode,
  type MotherTask,
  type SubTask,
  type ViewMode,
  type ViewSettings,
} from "../../domain/models";
import {
  evaluateDependencyConflicts,
  getMotherSpan,
  type DependencyConflict,
} from "../../domain/schedule";
import type { StorageGateway } from "../../storage/gateway";
import type {
  ProjectSaveStatus,
  ProjectState,
  RecentProject,
} from "../../storage/projectTypes";
import type {
  ImportMode,
  ImportPreview,
  ImportSource,
} from "../../transfer/types";
import {
  moveSubTask,
  pixelsToDayOffset,
  resizeSubTaskEnd,
  resizeSubTaskStart,
  type DateRangeUpdate,
} from "./directManipulation";
import {
  getAnchorForFocusDate,
  getDayColumnWidth,
  getPanStepDays,
  getViewRange,
  getVisibleDayCount,
  shiftAnchor,
  type ViewRange,
} from "./viewRange";
import {
  QUARTER_MAX_DAYS,
  getQuarterOverviewRange,
} from "./quarterOverview";
import {
  QuarterTimelineHeader,
  QuarterTimelineRows,
} from "./QuarterTimeline";
import { useDismissibleMenu } from "./useDismissibleMenu";

interface BoardPageProps {
  gateway: StorageGateway;
}

export type BoardRow =
  | {
      kind: "mother";
      mother: MotherTask;
      tagGroup?: { tag: string | null; count: number };
    }
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

type MotherDropPosition = "before" | "after";

interface MotherDropTarget {
  id: string;
  position: MotherDropPosition;
}

interface ActiveMotherDrag {
  pointerId: number;
  motherId: string;
  startY: number;
  moved: boolean;
  suppressClick: boolean;
}

type SubTaskDropPosition = "before" | "after";

interface SubTaskDropTarget {
  id: string;
  position: SubTaskDropPosition;
}

interface ActiveSubTaskDrag {
  pointerId: number;
  motherId: string;
  subTaskId: string;
  startY: number;
  moved: boolean;
}

interface ActiveTaskColumnResize {
  pointerId: number;
  startX: number;
  startWidth: number;
}

interface ActiveTimelinePan {
  pointerId: number;
  startX: number;
  baseAnchor: DateOnly;
  currentAnchor: DateOnly;
  moved: boolean;
  committedDays: number;
}

interface ToastState {
  tone: "success" | "error";
  message: string;
}

interface ImportState {
  source: ImportSource;
  mode: ImportMode;
  preview: ImportPreview;
}

const IMPORT_TEMPLATE = `{
  "version": "1.0",
  "tasks": [
    {
      "id": "task-001",
      "name": "需求分析",
      "tag": "产品",
      "expanded": true,
      "dependsOn": [],
      "subTasks": [
        {
          "id": "subtask-001",
          "name": "梳理目标与范围",
          "startDate": "2026-10-01",
          "endDate": "2026-10-02"
        },
        {
          "id": "subtask-002",
          "name": "确认验收标准",
          "startDate": "2026-10-03",
          "endDate": null
        }
      ]
    },
    {
      "id": "task-002",
      "name": "方案实施",
      "tag": "交付",
      "expanded": true,
      "dependsOn": ["task-001"],
      "subTasks": [
        {
          "id": "subtask-003",
          "name": "完成第一版交付",
          "startDate": "2026-10-05",
          "endDate": "2026-10-09"
        }
      ]
    }
  ]
}`;

const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const viewLabels: Record<ViewMode, string> = {
  week: "周",
  biweek: "双周",
  month: "月",
};

const motherTagCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

function getMotherTag(mother: MotherTask): string | null {
  return normalizeMotherTag(mother.tag);
}

function getMotherTagTone(tag: string | null): "coral" | "green" | "none" | undefined {
  if (!tag) {
    return "none";
  }
  if (tag === "内容") {
    return "coral";
  }
  if (tag === "研究") {
    return "green";
  }
  return undefined;
}

function sortMotherTasks(tasks: MotherTask[], mode: MotherSortMode): MotherTask[] {
  if (mode === "manual") {
    return tasks;
  }
  return [...tasks].sort((left, right) => {
    const leftTag = getMotherTag(left);
    const rightTag = getMotherTag(right);
    if (!leftTag && rightTag) {
      return 1;
    }
    if (leftTag && !rightTag) {
      return -1;
    }
    if (leftTag && rightTag) {
      const tagOrder = motherTagCollator.compare(leftTag, rightTag);
      if (tagOrder !== 0) {
        return tagOrder;
      }
    }
    return left.sortOrder - right.sortOrder;
  });
}

function buildRows(
  tasks: MotherTask[],
  search: string,
  sortMode: MotherSortMode = "manual",
): BoardRow[] {
  const query = search.trim().toLocaleLowerCase();
  const rows: BoardRow[] = [];
  const visibleMothers = tasks.filter((mother) => {
    const motherMatches =
      mother.name.toLocaleLowerCase().includes(query) ||
      (getMotherTag(mother)?.toLocaleLowerCase().includes(query) ?? false);
    const matchingSubTasks = query
      ? mother.subTasks.filter((subTask) =>
          subTask.name.toLocaleLowerCase().includes(query),
        )
      : mother.subTasks;
    return !query || motherMatches || matchingSubTasks.length > 0;
  });
  const orderedTasks = sortMotherTasks(visibleMothers, sortMode);
  const groupCounts = new Map<string, number>();
  if (sortMode === "tag") {
    for (const mother of orderedTasks) {
      const key = getMotherTag(mother) ?? "";
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    }
  }
  let previousTag: string | null | undefined;

  for (const mother of orderedTasks) {
    const motherTag = getMotherTag(mother);
    const motherMatches =
      mother.name.toLocaleLowerCase().includes(query) ||
      (motherTag?.toLocaleLowerCase().includes(query) ?? false);
    const matchingSubTasks = query
      ? mother.subTasks.filter((subTask) =>
          subTask.name.toLocaleLowerCase().includes(query),
        )
      : mother.subTasks;

    const tagGroup =
      sortMode === "tag" && motherTag !== previousTag
        ? { tag: motherTag, count: groupCounts.get(motherTag ?? "") ?? 0 }
        : undefined;
    rows.push({ kind: "mother", mother, tagGroup });
    previousTag = motherTag;
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

function reorderMotherTasks(
  tasks: MotherTask[],
  draggedId: string,
  targetId: string,
  position: MotherDropPosition,
): MotherTask[] {
  if (draggedId === targetId) {
    return tasks;
  }

  const draggedTask = tasks.find((task) => task.id === draggedId);
  if (!draggedTask) {
    return tasks;
  }

  const remaining = tasks.filter((task) => task.id !== draggedId);
  const targetIndex = remaining.findIndex((task) => task.id === targetId);
  if (targetIndex < 0) {
    return tasks;
  }

  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  const reordered = [...remaining];
  reordered.splice(insertionIndex, 0, draggedTask);
  return reordered.map((task, sortOrder) => ({ ...task, sortOrder }));
}

function reorderSubTasksWithinMother(
  tasks: MotherTask[],
  motherId: string,
  draggedId: string,
  targetId: string,
  position: SubTaskDropPosition,
): MotherTask[] {
  if (draggedId === targetId) {
    return tasks;
  }

  const mother = tasks.find((task) => task.id === motherId);
  if (!mother) {
    return tasks;
  }

  const draggedSubTask = mother.subTasks.find((subTask) => subTask.id === draggedId);
  if (!draggedSubTask) {
    return tasks;
  }

  const remaining = mother.subTasks.filter((subTask) => subTask.id !== draggedId);
  const targetIndex = remaining.findIndex((subTask) => subTask.id === targetId);
  if (targetIndex < 0) {
    return tasks;
  }

  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  const reorderedSubTasks = [...remaining];
  reorderedSubTasks.splice(insertionIndex, 0, draggedSubTask);
  const nextSubTasks = reorderedSubTasks.map((subTask, sortOrder) => ({
    ...subTask,
    sortOrder,
  }));
  return tasks.map((task) =>
    task.id === motherId ? { ...task, subTasks: nextSubTasks } : task,
  );
}

function formatRange(range: ViewRange): string {
  return `${range.startDate.replaceAll("-", "/")} – ${range.endDate.replaceAll("-", "/")}`;
}

function formatShortDate(value: DateOnly): string {
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}

function formatMonthLabel(value: DateOnly): string {
  return `${value.slice(0, 4)} 年 ${Number(value.slice(5, 7))} 月`;
}

function buildMonthGroups(
  dates: DateOnly[],
): { key: string; label: string; span: number }[] {
  const groups: { key: string; label: string; span: number }[] = [];
  for (const date of dates) {
    const key = date.slice(0, 7);
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.span += 1;
    } else {
      groups.push({ key, label: formatMonthLabel(date), span: 1 });
    }
  }
  return groups;
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

function getEarliestStartDate(tasks: MotherTask[]): DateOnly | null {
  const dates = tasks.flatMap((task) =>
    task.subTasks.map((subTask) => subTask.startDate),
  );
  if (dates.length === 0) {
    return null;
  }
  return dates.reduce((earliest, value) =>
    compareDateOnly(value, earliest) < 0 ? value : earliest,
  );
}

export function BoardPage({ gateway }: BoardPageProps) {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const projectMenuRef = useDismissibleMenu<HTMLElement>(projectMenuOpen, setProjectMenuOpen);
  const viewMenuRef = useDismissibleMenu<HTMLDivElement>(viewMenuOpen, setViewMenuOpen);
  const moreMenuRef = useDismissibleMenu<HTMLDivElement>(moreMenuOpen, setMoreMenuOpen);
  const [showWeekends, setShowWeekends] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [motherDialog, setMotherDialog] = useState<MotherDialogState | null>(null);
  const [subTaskDialog, setSubTaskDialog] = useState<SubTaskDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [dependencyDialog, setDependencyDialog] = useState<MotherTask | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [quarterOverview, setQuarterOverview] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const viewSettingsRef = useRef<ViewSettings | null>(null);

  const handleTaskColumnWidthChange = (width: number) => {
    const nextWidth = clampTaskColumnWidth(width);
    setBoard((current) =>
      current
        ? { ...current, viewSettings: { ...current.viewSettings, taskColumnWidth: nextWidth } }
        : current,
    );
  };

  const commitTaskColumnWidth = (width: number) => {
    if (!board) {
      return;
    }
    void saveViewSettings({
      ...board.viewSettings,
      taskColumnWidth: clampTaskColumnWidth(width),
    });
  };

  const reloadBoard = async () => {
    setLoadError(null);
    try {
      setBoard(await gateway.loadBoard());
    } catch (error) {
      setLoadError(messageFromError(error));
    }
  };

  const reloadProjectState = async () => {
    try {
      setProjectState(await gateway.getProjectState());
    } catch (error) {
      setToast({ tone: "error", message: messageFromError(error) });
    }
  };

  useEffect(() => {
    let active = true;
    void Promise.all([gateway.loadBoard(), gateway.getProjectState()]).then(
      ([snapshot, state]) => {
        if (active) {
          setBoard(snapshot);
          setProjectState(state);
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
    viewSettingsRef.current = board?.viewSettings ?? null;
  }, [board?.viewSettings]);

  // 滚动容器要等看板数据加载完成后才渲染，因此依赖 board 出现后再挂载观察器；
  // 否则 effect 只在空态时跑一次，viewportWidth 恒为 0，宽屏下时间轴不会铺满。
  useEffect(() => {
    if (resizeObserverRef.current) {
      return;
    }
    const element = scrollContainerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setViewportWidth(entry.contentRect.width);
    });
    observer.observe(element);
    resizeObserverRef.current = observer;
  }, [board]);

  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const motherSortMode: MotherSortMode = board?.viewSettings.motherSortMode ?? "manual";
  const rows = useMemo(
    () => buildRows(board?.tasks ?? [], search, motherSortMode),
    [board?.tasks, search, motherSortMode],
  );
  const activeViewMode: ViewMode = board?.viewSettings.viewMode ?? "biweek";
  const anchorDate = board?.viewSettings.anchorDate;
  const taskColumnWidth = board
    ? clampTaskColumnWidth(board.viewSettings.taskColumnWidth)
    : MIN_TASK_COLUMN_WIDTH;
  const availableTimelineWidth = Math.max(
    0,
    viewportWidth - taskColumnWidth - 2,
  );
  const dayCount = getVisibleDayCount(availableTimelineWidth, activeViewMode);
  const baseColumnWidth = getDayColumnWidth(activeViewMode);
  const detailColumnWidth =
    availableTimelineWidth > 0 ? availableTimelineWidth / dayCount : baseColumnWidth;
  const quarterRange = useMemo(
    () => (anchorDate ? getQuarterOverviewRange(anchorDate) : null),
    [anchorDate],
  );
  const detailRange = useMemo(
    () => (anchorDate ? getViewRange(anchorDate, dayCount) : null),
    [anchorDate, dayCount],
  );
  const activeDayCount = quarterOverview
    ? quarterRange?.dates.length ?? QUARTER_MAX_DAYS
    : dayCount;
  const range = quarterOverview ? quarterRange : detailRange;
  const columnWidth = quarterOverview
    ? availableTimelineWidth > 0
      ? availableTimelineWidth / activeDayCount
      : 12
    : detailColumnWidth;
  const timelineWidth = (range?.dates.length ?? 0) * columnWidth;
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
      await reloadBoard();
      await reloadProjectState();
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

  // 平移与翻页是高频操作：立即更新本地状态，但不置 busy、不弹成功提示。
  const persistViewSettingsSilently = async (settings: ViewSettings) => {
    try {
      await gateway.saveViewSettings(settings);
    } catch (error) {
      console.warn("保存视图设置失败", error);
      setToast({ tone: "error", message: messageFromError(error) });
    }
  };

  const applyAnchor = (anchorDate: DateOnly, persist: boolean) => {
    const current = viewSettingsRef.current;
    if (!current) {
      return;
    }
    const next = { ...current, anchorDate };
    viewSettingsRef.current = next;
    setBoard((currentBoard) =>
      currentBoard ? { ...currentBoard, viewSettings: next } : currentBoard,
    );
    if (persist) {
      void persistViewSettingsSilently(next);
    }
  };

  const commitPan = () => {
    const current = viewSettingsRef.current;
    if (current) {
      void persistViewSettingsSilently(current);
    }
  };

  const pageAnchor = (direction: -1 | 1) => {
    const current = viewSettingsRef.current;
    if (!current) {
      return;
    }
    applyAnchor(
      shiftAnchor(current.anchorDate, direction * getPanStepDays(activeDayCount)),
      true,
    );
  };

  const focusToday = () => {
    applyAnchor(getAnchorForFocusDate(todayDateOnly(), activeDayCount), true);
  };

  const handleCreateMother = async (name: string, tag: string) => {
    const succeeded = await runAction(async () => {
      const mother = await gateway.createMotherTask({ name, tag: normalizeMotherTag(tag) });
      setBoard((current) =>
        current ? { ...current, tasks: [...current.tasks, mother] } : current,
      );
    }, "已新建母任务");
    if (succeeded) {
      setMotherDialog(null);
    }
  };

  const handleRenameMother = async (mother: MotherTask, name: string, tag: string) => {
    const succeeded = await runAction(async () => {
      const normalizedTag = normalizeMotherTag(tag);
      await gateway.renameMotherTask({ id: mother.id, name, tag: normalizedTag });
      setBoard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === mother.id
                  ? { ...task, name: name.trim(), tag: normalizedTag }
                  : task,
              ),
            }
          : current,
      );
    }, "母任务已更新");
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

  const handleReorderMother = async (
    draggedId: string,
    targetId: string,
    position: MotherDropPosition,
  ) => {
    if (!board) {
      return;
    }

    const originalTasks = board.tasks;
    const reorderedTasks = reorderMotherTasks(
      originalTasks,
      draggedId,
      targetId,
      position,
    );
    if (reorderedTasks === originalTasks) {
      return;
    }
    if (reorderedTasks.every((task, index) => task.id === originalTasks[index]?.id)) {
      return;
    }

    setBoard((current) =>
      current ? { ...current, tasks: reorderedTasks } : current,
    );
    setBusy(true);
    try {
      await gateway.reorderMotherTasks({
        orderedIds: reorderedTasks.map((task) => task.id),
      });
      setToast({ tone: "success", message: "母任务排序已更新" });
    } catch (error) {
      await reloadBoard();
      await reloadProjectState();
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleReorderSubTask = async (
    motherId: string,
    draggedId: string,
    targetId: string,
    position: SubTaskDropPosition,
  ) => {
    if (!board) {
      return;
    }

    const originalTasks = board.tasks;
    const reorderedTasks = reorderSubTasksWithinMother(
      originalTasks,
      motherId,
      draggedId,
      targetId,
      position,
    );
    const mother = originalTasks.find((task) => task.id === motherId);
    const reorderedMother = reorderedTasks.find((task) => task.id === motherId);
    if (
      !mother ||
      !reorderedMother ||
      reorderedTasks === originalTasks ||
      reorderedMother.subTasks.every(
        (subTask, index) => subTask.id === mother.subTasks[index]?.id,
      )
    ) {
      return;
    }

    setBoard((current) =>
      current ? { ...current, tasks: reorderedTasks } : current,
    );
    setBusy(true);
    try {
      await gateway.reorderSubTasks({
        motherId,
        orderedIds: reorderedMother.subTasks.map((subTask) => subTask.id),
      });
      setToast({ tone: "success", message: "子任务排序已更新" });
    } catch (error) {
      await reloadBoard();
      await reloadProjectState();
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
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
      await reloadBoard();
      await reloadProjectState();
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

  const reloadAfterProjectAction = async (state: ProjectState) => {
    setProjectState(state);
    setBoard(await gateway.loadBoard());
    setQuarterOverview(false);
    setProjectMenuOpen(false);
  };

  const openProjectPath = async (path: string) => {
    setBusy(true);
    try {
      const state = await gateway.openProject(path);
      await reloadAfterProjectAction(state);
      setToast({ tone: "success", message: `已打开项目：${state.activeName ?? path}` });
    } catch (error) {
      await reloadProjectState();
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleOpenProject = async () => {
    if (!isTauri()) {
      setToast({ tone: "error", message: "浏览器预览模式请先用项目菜单创建或选择内存项目" });
      return;
    }
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "JSON 项目文件", extensions: ["json"] }],
    });
    if (typeof selected === "string") {
      await openProjectPath(selected);
    }
  };

  const handleCreateProject = async () => {
    if (!isTauri()) {
      setToast({ tone: "error", message: "浏览器预览模式不支持选择项目文件路径" });
      return;
    }
    const selected = await save({
      defaultPath: `工作规划时间板_${todayDateOnly()}.json`,
      filters: [{ name: "JSON 项目文件", extensions: ["json"] }],
    });
    if (!selected) {
      return;
    }
    setBusy(true);
    try {
      const state = await gateway.createProject(selected);
      await reloadAfterProjectAction(state);
      setToast({ tone: "success", message: `已新建项目：${state.activeName ?? selected}` });
    } catch (error) {
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAsProject = async () => {
    if (!isTauri()) {
      setToast({ tone: "error", message: "浏览器预览模式不支持选择项目文件路径" });
      return;
    }
    const selected = await save({
      defaultPath: `工作规划时间板_${todayDateOnly()}.json`,
      filters: [{ name: "JSON 项目文件", extensions: ["json"] }],
    });
    if (!selected) {
      return;
    }
    setBusy(true);
    try {
      const state = await gateway.saveAsProject(selected);
      await reloadAfterProjectAction(state);
      setToast({ tone: "success", message: `项目已另存为：${state.activeName ?? selected}` });
    } catch (error) {
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleRetryProjectSave = async () => {
    setBusy(true);
    try {
      const state = await gateway.saveActiveProject();
      await reloadAfterProjectAction(state);
      setToast({ tone: "success", message: "项目文件已保存" });
    } catch (error) {
      await reloadProjectState();
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleReloadExternalProject = async () => {
    if (projectState?.activePath) {
      if (
        projectState.saveStatus === "conflict" &&
        !window.confirm("重新加载会放弃当前尚未写入项目文件的修改，是否继续？")
      ) {
        return;
      }
      await openProjectPath(projectState.activePath);
    }
  };

  const handleRemoveRecentProject = async (recent: RecentProject) => {
    try {
      await gateway.removeRecentProject(recent.path);
      await reloadProjectState();
    } catch (error) {
      setToast({ tone: "error", message: messageFromError(error) });
    }
  };

  const analyzeImport = async (source: ImportSource, mode: ImportMode) => {
    setBusy(true);
    try {
      const preview = await gateway.analyzeImport(source, mode);
      setImportState({ source, mode, preview });
    } catch (error) {
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleImportRequest = async () => {
    if (isTauri()) {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "JSON 规划文件", extensions: ["json"] }],
      });
      if (typeof selected === "string") {
        await analyzeImport(
          {
            kind: "path",
            value: selected,
            fileName: selected.split(/[\\/]/).at(-1) ?? selected,
          },
          "overwrite",
        );
      }
      return;
    }
    fileInputRef.current?.click();
  };

  const analyzeBrowserFile = async (file: File) => {
    if (!file.name.toLocaleLowerCase().endsWith(".json")) {
      setToast({ tone: "error", message: "请选择 .json 格式文件。" });
      return;
    }
    await analyzeImport(
      { kind: "content", value: await file.text(), fileName: file.name },
      "overwrite",
    );
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      void analyzeBrowserFile(file);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      void analyzeBrowserFile(file);
    }
  };

  const handlePlannerPointerDownCapture = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".row-actions")) {
      return;
    }

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement.closest(".task-row--mother .row-actions")
    ) {
      activeElement.blur();
    }
  };

  const executeImport = async () => {
    if (!importState) {
      return;
    }
    setBusy(true);
    try {
      const result = await gateway.applyImport(importState.source, importState.mode);
      let loaded = await gateway.loadBoard();
      const earliestDate = getEarliestStartDate(loaded.tasks);
      if (earliestDate) {
        const settings = { ...loaded.viewSettings, anchorDate: earliestDate };
        await gateway.saveViewSettings(settings);
        loaded = { ...loaded, viewSettings: settings };
      }
      setBoard(loaded);
      await reloadProjectState();
      setImportState(null);
      setConfirmOverwrite(false);
      setToast({
        tone: "success",
        message: `已导入 ${result.motherTaskCount} 个母任务 / ${result.subTaskCount} 个子任务`,
      });
    } catch (error) {
      setConfirmOverwrite(false);
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      const filename = `工作规划时间板_${todayDateOnly()}.json`;
      if (isTauri()) {
        const destination = await save({
          defaultPath: filename,
          filters: [{ name: "JSON 规划文件", extensions: ["json"] }],
        });
        if (!destination) {
          return;
        }
        const response = await gateway.exportJson(destination);
        setToast({
          tone: "success",
          message: `已导出 ${response.result.motherTaskCount} 个母任务 / ${response.result.subTaskCount} 个子任务`,
        });
        return;
      }

      const response = await gateway.exportJson();
      if (!response.content) {
        throw new Error("导出内容为空。");
      }
      const blob = new Blob(["\uFEFF", response.content], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setToast({
        tone: "success",
        message: `已导出 ${response.result.motherTaskCount} 个母任务 / ${response.result.subTaskCount} 个子任务`,
      });
    } catch (error) {
      setToast({ tone: "error", message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleCopyTemplate = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(IMPORT_TEMPLATE);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = IMPORT_TEMPLATE;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) {
          throw new Error("浏览器未允许复制");
        }
      }
      setToast({ tone: "success", message: "导入模板已复制" });
    } catch {
      setToast({ tone: "error", message: "复制失败，请在模板文本中手动复制。" });
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

  return (
    <main
      className="planner-shell"
      onPointerDownCapture={handlePlannerPointerDownCapture}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) {
          return;
        }
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setDragActive(false);
        }
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={handleDrop}
    >
      <PlannerHeader
        busy={busy}
        onCreateMother={() => setMotherDialog({ mode: "create" })}
        projectSelector={
          <ProjectSelector
            busy={busy}
            menuRef={projectMenuRef}
            onCreate={handleCreateProject}
            onOpen={handleOpenProject}
            onRemoveRecent={handleRemoveRecentProject}
            onReloadExternal={handleReloadExternalProject}
            onRetrySave={handleRetryProjectSave}
            onSaveAs={handleSaveAsProject}
            onSelectRecent={(recent) => void openProjectPath(recent.path)}
            onToggle={() => {
              setProjectMenuOpen((current) => !current);
              setViewMenuOpen(false);
              setMoreMenuOpen(false);
            }}
            open={projectMenuOpen}
            state={projectState}
          />
        }
        saveStatus={projectState?.saveStatus ?? "saved"}
      />
      <section className="planner-toolbar" aria-label="时间板工具栏">
        <div className="period-controls">
          <button
            aria-label="上一周期"
            className="icon-button"
            disabled={busy}
            onClick={() => pageAnchor(-1)}
          >
            ←
          </button>
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() => focusToday()}
          >
            今天
          </button>
          <button
            aria-label="下一周期"
            className="icon-button"
            disabled={busy}
            onClick={() => pageAnchor(1)}
          >
            →
          </button>
          <strong className="period-label">{formatRange(range)}</strong>
        </div>

        <div className="toolbar-actions">
          <div className="segmented-control" aria-label="视图模式">
            {(Object.keys(viewLabels) as ViewMode[]).map((viewMode) => (
              <button
                aria-pressed={!quarterOverview && board.viewSettings.viewMode === viewMode}
                className={
                  !quarterOverview && board.viewSettings.viewMode === viewMode
                    ? "segmented-control__item is-active"
                    : "segmented-control__item"
                }
                disabled={busy}
                key={viewMode}
                onClick={() => {
                  setQuarterOverview(false);
                  void saveViewSettings({ ...board.viewSettings, viewMode });
                }}
              >
                {viewLabels[viewMode]}
              </button>
            ))}
          </div>
          <button
            aria-pressed={quarterOverview}
            className={
              quarterOverview
                ? "segmented-control__item is-active quarter-overview-toggle"
                : "segmented-control__item quarter-overview-toggle"
            }
            disabled={busy}
            onClick={() => setQuarterOverview((current) => !current)}
            title="连续 90–92 天总览；拖动主体或边缘调整日期，点击任务条进入精确编辑"
            type="button"
          >
            季度总览
          </button>
          <div className="segmented-control mother-sort-control" aria-label="母任务排序">
            {(["manual", "tag"] as MotherSortMode[]).map((sortMode) => (
              <button
                aria-pressed={motherSortMode === sortMode}
                className={
                  motherSortMode === sortMode
                    ? "segmented-control__item is-active"
                    : "segmented-control__item"
                }
                disabled={busy}
                key={sortMode}
                onClick={() =>
                  void saveViewSettings({
                    ...board.viewSettings,
                    motherSortMode: sortMode,
                  })
                }
                type="button"
              >
                {sortMode === "manual" ? "手动顺序" : "按标签分组"}
              </button>
            ))}
          </div>
          {motherSortMode === "tag" ? (
            <span className="tag-sort-readonly">
              <i aria-hidden="true" /> 标签视图只读
            </span>
          ) : null}
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
          <label className="sr-only">
            <input
              aria-label="显示依赖"
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
          </label>
          <div className="toolbar-menu-anchor" ref={viewMenuRef}>
            <button
              aria-expanded={viewMenuOpen}
              aria-haspopup="menu"
              className="button button--quiet button--with-icon"
              disabled={busy}
              onClick={() => {
                setViewMenuOpen((current) => !current);
                setMoreMenuOpen(false);
                setProjectMenuOpen(false);
              }}
              type="button"
            >
              <span aria-hidden="true">☷</span>
              查看
            </button>
            {viewMenuOpen ? (
              <div className="toolbar-popover toolbar-popover--view" role="menu">
                <label className="toolbar-checkrow">
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
                  显示依赖关系
                </label>
                <label className="toolbar-checkrow">
                  <input
                    checked={showWeekends}
                    onChange={(event) => setShowWeekends(event.target.checked)}
                    type="checkbox"
                  />
                  标记周末
                </label>
                {board.tasks.length > 0 ? (
                  <button
                    className="toolbar-menu-item"
                    disabled={busy}
                    onClick={() => {
                      setViewMenuOpen(false);
                      void handleSetAllExpanded(true);
                    }}
                    type="button"
                  >
                    全部展开
                  </button>
                ) : null}
                {board.tasks.length > 0 ? (
                  <button
                    className="toolbar-menu-item"
                    disabled={busy}
                    onClick={() => {
                      setViewMenuOpen(false);
                      void handleSetAllExpanded(false);
                    }}
                    type="button"
                  >
                    全部收起
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="toolbar-menu-anchor" ref={moreMenuRef}>
            <button
              aria-expanded={moreMenuOpen}
              aria-label="更多数据操作"
              aria-haspopup="menu"
              className="icon-button toolbar-more-button"
              disabled={busy}
              onClick={() => {
                setMoreMenuOpen((current) => !current);
                setViewMenuOpen(false);
                setProjectMenuOpen(false);
              }}
              type="button"
            >
              …
            </button>
            {moreMenuOpen ? (
              <div className="toolbar-popover toolbar-popover--more" role="menu">
                <button
                  className="toolbar-menu-item"
                  disabled={busy}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setTemplateOpen(true);
                  }}
                  type="button"
                >
                  导入模板
                </button>
                <button
                  className="toolbar-menu-item"
                  disabled={busy}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    void handleImportRequest();
                  }}
                  type="button"
                >
                  导入 JSON
                </button>
                <button
                  className="toolbar-menu-item"
                  disabled={busy}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    void handleExport();
                  }}
                  type="button"
                >
                  导出 JSON
                </button>
              </div>
            ) : null}
            <button
              className="sr-only"
              disabled={busy}
              onClick={() => {
                setMoreMenuOpen(false);
                setTemplateOpen(true);
              }}
              type="button"
            >
              导入模板
            </button>
          </div>
        </div>
      </section>

      {board.tasks.length === 0 ? (
        <EmptyBoard
          onCreate={() => setMotherDialog({ mode: "create" })}
          onImport={() => void handleImportRequest()}
        />
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
          onReorderMother={(draggedId, targetId, position) =>
            void handleReorderMother(draggedId, targetId, position)
          }
          onReorderSubTask={(motherId, draggedId, targetId, position) =>
            void handleReorderSubTask(motherId, draggedId, targetId, position)
          }
          onSetDependencies={setDependencyDialog}
          onQuickAdd={(mother, initialDate) =>
            setSubTaskDialog({ mode: "create", mother, initialDate })
          }
          onToggleMother={(mother) => void handleToggleMother(mother)}
          motherSortMode={motherSortMode}
          quarterOverview={quarterOverview}
          range={range}
          rows={rows}
          tasks={board.tasks}
          conflicts={dependencyConflicts}
          showDependencies={board.viewSettings.showDependencies}
          showWeekends={showWeekends}
          taskColumnWidth={taskColumnWidth}
          onTaskColumnWidthChange={handleTaskColumnWidthChange}
          onTaskColumnWidthCommit={commitTaskColumnWidth}
          columnWidth={columnWidth}
          timelineWidth={timelineWidth}
          anchorDate={board.viewSettings.anchorDate}
          scrollContainerRef={scrollContainerRef}
          onAnchorChange={applyAnchor}
          onCommitPan={commitPan}
        />
      )}

      {motherDialog ? (
        <MotherTaskDialog
          busy={busy}
          initialName={motherDialog.mode === "rename" ? motherDialog.mother.name : ""}
          initialTag={motherDialog.mode === "rename" ? motherDialog.mother.tag ?? "" : ""}
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
          onSubmit={(name, tag) =>
            motherDialog.mode === "create"
              ? handleCreateMother(name, tag)
              : handleRenameMother(motherDialog.mother, name, tag)
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

      {importState && !confirmOverwrite ? (
        <ImportDialog
          busy={busy}
          state={importState}
          onCancel={() => setImportState(null)}
          onModeChange={(mode) => void analyzeImport(importState.source, mode)}
          onSubmit={() => {
            if (importState.mode === "overwrite") {
              setConfirmOverwrite(true);
            } else {
              void executeImport();
            }
          }}
        />
      ) : null}

      {templateOpen ? (
        <ImportTemplateDialog
          onCancel={() => setTemplateOpen(false)}
          onCopy={() => void handleCopyTemplate()}
        />
      ) : null}

      {confirmOverwrite && importState ? (
        <ConfirmDialog
          busy={busy}
          description="覆盖导入将替换当前全部规划数据。此操作不可撤销，是否继续？"
          onCancel={() => setConfirmOverwrite(false)}
          onConfirm={() => void executeImport()}
          title="确认覆盖当前规划"
          confirmLabel="确认覆盖"
        />
      ) : null}

      {dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div>松开以导入 JSON 规划文件</div>
        </div>
      ) : null}

      <input
        accept=".json,application/json"
        className="sr-only"
        onChange={handleFileInput}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      {toast ? (
        <div className={`toast toast--${toast.tone}`} role="status">
          {toast.message}
        </div>
      ) : null}
    </main>
  );
}

interface ProjectSelectorProps {
  busy: boolean;
  menuRef: RefObject<HTMLElement | null>;
  open: boolean;
  state: ProjectState | null;
  onToggle: () => void;
  onOpen: () => void;
  onCreate: () => void;
  onSaveAs: () => void;
  onRetrySave: () => void;
  onReloadExternal: () => void;
  onSelectRecent: (recent: RecentProject) => void;
  onRemoveRecent: (recent: RecentProject) => void;
}

function ProjectSelector({
  busy,
  menuRef,
  open,
  state,
  onToggle,
  onOpen,
  onCreate,
  onSaveAs,
  onRetrySave,
  onReloadExternal,
  onSelectRecent,
  onRemoveRecent,
}: ProjectSelectorProps) {
  const activeName = state?.activeName ?? "未命名规划";
  const statusLabel = {
    saved: "已保存",
    saving: "保存中",
    unsaved: "未保存",
    conflict: "外部已修改",
    error: "保存失败",
  }[state?.saveStatus ?? "saved"];
  const recentStatusLabel = {
    available: "可用",
    missing: "文件不存在",
    unreadable: "无法读取",
    invalid: "格式无效",
    conflict: "存在冲突",
  } as const;

  return (
    <section className="project-selector" aria-label="项目规划" ref={menuRef}>
      <div className="project-selector__current">
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          className="project-selector__trigger"
          disabled={busy}
          onClick={onToggle}
          type="button"
        >
          <span className="project-selector__icon" aria-hidden="true">⌂</span>
          <span className="project-selector__label">
            <strong>{activeName}</strong>
            <small>{state?.parentPath ?? "尚未选择项目文件"}</small>
          </span>
          <span className={`project-selector__status project-selector__status--${state?.saveStatus ?? "saved"}`}>
            {statusLabel}
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
        {open ? (
          <div className="project-selector__menu" role="menu">
            <div className="project-selector__menu-actions">
              <button className="button button--quiet" disabled={busy} onClick={onOpen} type="button">
                打开项目
              </button>
              <button className="button button--quiet" disabled={busy} onClick={onCreate} type="button">
                新建项目
              </button>
              <button className="button button--quiet" disabled={busy} onClick={onSaveAs} type="button">
                另存为
              </button>
            </div>
            {state?.workspaceMode === "unnamedLegacy" ? (
              <div className="project-selector__save-actions">
                <span>当前是未命名本地工作区，建议另存为 JSON 项目文件。</span>
                <button className="text-button" disabled={busy} onClick={onSaveAs} type="button">
                  开始迁移
                </button>
              </div>
            ) : null}
            {state?.saveStatus === "conflict" || state?.saveStatus === "error" || state?.saveStatus === "unsaved" ? (
              <div className="project-selector__save-actions">
                <span>{state.lastError ?? "当前项目尚未写入文件"}</span>
                <button className="text-button" disabled={busy} onClick={onRetrySave} type="button">
                  重试保存
                </button>
                {state.saveStatus === "conflict" ? (
                  <button className="text-button" disabled={busy} onClick={onReloadExternal} type="button">
                    重新加载外部文件
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="project-selector__recent-title">最近打开</div>
            {state?.recent.length ? (
              state.recent.map((recent) => (
                <div className="project-selector__recent" key={recent.path} role="menuitem">
                  <button
                    className="project-selector__recent-main"
                    disabled={busy || recent.status !== "available"}
                    onClick={() => onSelectRecent(recent)}
                    type="button"
                  >
                    <strong>{recent.name}</strong>
                    <small>{recent.parentPath}</small>
                    <em>{recentStatusLabel[recent.status]}</em>
                  </button>
                  <button
                    aria-label={`移除最近记录 ${recent.name}`}
                    className="project-selector__remove"
                    disabled={busy}
                    onClick={() => onRemoveRecent(recent)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))
            ) : (
              <p className="project-selector__empty">暂无最近项目</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PlannerHeader({
  busy,
  onCreateMother,
  projectSelector,
  saveStatus,
}: {
  busy: boolean;
  onCreateMother: () => void;
  projectSelector: ReactNode;
  saveStatus: ProjectSaveStatus;
}) {
  const saveLabel: Record<ProjectSaveStatus, string> = {
    saved: "已自动保存",
    saving: "保存中",
    unsaved: "未保存",
    conflict: "外部已修改",
    error: "保存失败",
  };
  return (
    <header className="planner-header">
      <div className="planner-header__left">
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
        {projectSelector}
      </div>
      <div className="planner-header__actions">
        <span className={`local-status local-status--${saveStatus}`}>
          <i aria-hidden="true" />
          {saveLabel[saveStatus]}
        </span>
        <button
          className="button button--primary planner-header__new"
          disabled={busy}
          onClick={onCreateMother}
          type="button"
        >
          ＋ 新建母任务
        </button>
      </div>
    </header>
  );
}

interface TimelineBoardProps {
  rows: BoardRow[];
  tasks: MotherTask[];
  motherSortMode: MotherSortMode;
  quarterOverview: boolean;
  range: ViewRange;
  busy: boolean;
  conflicts: DependencyConflict[];
  showDependencies: boolean;
  showWeekends: boolean;
  onToggleMother: (mother: MotherTask) => void;
  onEditMother: (mother: MotherTask) => void;
  onRequestDeleteMother: (mother: MotherTask) => void;
  onReorderMother: (
    draggedId: string,
    targetId: string,
    position: MotherDropPosition,
  ) => void;
  onReorderSubTask: (
    motherId: string,
    draggedId: string,
    targetId: string,
    position: SubTaskDropPosition,
  ) => void;
  onSetDependencies: (mother: MotherTask) => void;
  onAddSubTask: (mother: MotherTask) => void;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
  onQuickAdd: (mother: MotherTask, initialDate: DateOnly) => void;
  onDirectUpdate: (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => void;
  taskColumnWidth: number;
  onTaskColumnWidthChange: (width: number) => void;
  onTaskColumnWidthCommit: (width: number) => void;
  columnWidth: number;
  timelineWidth: number;
  anchorDate: DateOnly;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onAnchorChange: (anchorDate: DateOnly, persist: boolean) => void;
  onCommitPan: () => void;
}

function TimelineBoard({
  rows,
  tasks,
  motherSortMode,
  quarterOverview,
  range,
  busy,
  conflicts,
  showDependencies,
  showWeekends,
  onToggleMother,
  onEditMother,
  onRequestDeleteMother,
  onReorderMother,
  onReorderSubTask,
  onSetDependencies,
  onAddSubTask,
  onEditSubTask,
  onQuickAdd,
  onDirectUpdate,
  taskColumnWidth,
  onTaskColumnWidthChange,
  onTaskColumnWidthCommit,
  columnWidth,
  timelineWidth,
  anchorDate,
  scrollContainerRef,
  onAnchorChange,
  onCommitPan,
}: TimelineBoardProps) {
  const today = todayDateOnly();
  const todayIndex = range.dates.indexOf(today);
  const [focusedMotherId, setFocusedMotherId] = useState<string | null>(null);
  const [draggedMotherId, setDraggedMotherId] = useState<string | null>(null);
  const activeMotherDragRef = useRef<ActiveMotherDrag | null>(null);
  const activeTaskColumnResizeRef = useRef<ActiveTaskColumnResize | null>(null);
  const motherDropTargetRef = useRef<MotherDropTarget | null>(null);
  const suppressedMotherClickRef = useRef<string | null>(null);
  const [motherDropTarget, setMotherDropTarget] =
    useState<MotherDropTarget | null>(null);
  const [draggedSubTaskId, setDraggedSubTaskId] = useState<string | null>(null);
  const activeSubTaskDragRef = useRef<ActiveSubTaskDrag | null>(null);
  const subTaskDropTargetRef = useRef<SubTaskDropTarget | null>(null);
  const [subTaskDropTarget, setSubTaskDropTarget] =
    useState<SubTaskDropTarget | null>(null);
  const activePanRef = useRef<ActiveTimelinePan | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panCommitTimerRef = useRef<number | null>(null);
  const wheelAnchorRef = useRef<DateOnly>(anchorDate);
  const wheelDeltaRef = useRef(0);
  const timelineColumnRef = useRef<HTMLDivElement>(null);
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

  const clearMotherDrag = () => {
    activeMotherDragRef.current = null;
    motherDropTargetRef.current = null;
    setDraggedMotherId(null);
    setMotherDropTarget(null);
  };

  const beginTaskColumnResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || event.button !== 0) {
      return;
    }
    activeTaskColumnResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: taskColumnWidth,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const updateTaskColumnResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activeTaskColumnResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    onTaskColumnWidthChange(active.startWidth + event.clientX - active.startX);
    event.preventDefault();
  };

  const finishTaskColumnResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activeTaskColumnResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    const nextWidth = clampTaskColumnWidth(active.startWidth + event.clientX - active.startX);
    onTaskColumnWidthChange(nextWidth);
    onTaskColumnWidthCommit(nextWidth);
    activeTaskColumnResizeRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId) &&
      typeof event.currentTarget.releasePointerCapture === "function"
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const handleTaskColumnResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 10;
    const nextWidth =
      event.key === "Home"
        ? MIN_TASK_COLUMN_WIDTH
        : event.key === "End"
          ? MAX_TASK_COLUMN_WIDTH
          : event.key === "ArrowLeft"
            ? taskColumnWidth - step
            : event.key === "ArrowRight"
              ? taskColumnWidth + step
              : null;
    if (nextWidth === null) {
      return;
    }
    event.preventDefault();
    const clampedWidth = clampTaskColumnWidth(nextWidth);
    onTaskColumnWidthChange(clampedWidth);
    onTaskColumnWidthCommit(clampedWidth);
  };

  const beginMotherDrag = (
    mother: MotherTask,
    event: ReactPointerEvent<HTMLElement>,
    suppressClick: boolean,
  ) => {
    if (busy || motherSortMode === "tag" || event.button !== 0) {
      return;
    }
    activeMotherDragRef.current = {
      pointerId: event.pointerId,
      motherId: mother.id,
      startY: event.clientY,
      moved: false,
      suppressClick,
    };
    setDraggedMotherId(mother.id);
    setMotherDropTarget(null);
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const updateMotherDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const active = activeMotherDragRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    if (!active.moved && Math.abs(event.clientY - active.startY) < 4) {
      return;
    }
    active.moved = true;
    event.preventDefault();

    const motherRows = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".task-row--mother[data-mother-row-id]",
      ),
    ).filter((element) => element.dataset.motherRowId !== active.motherId);
    let nextTarget: MotherDropTarget | null = null;
    for (const element of motherRows) {
      const id = element.dataset.motherRowId;
      if (!id) {
        continue;
      }
      const rectangle = element.getBoundingClientRect();
      if (event.clientY < rectangle.top + rectangle.height / 2) {
        nextTarget = { id, position: "before" };
        break;
      }
      nextTarget = { id, position: "after" };
    }
    motherDropTargetRef.current = nextTarget;
    setMotherDropTarget(nextTarget);
  };

  const finishMotherDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const active = activeMotherDragRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const target = motherDropTargetRef.current;
    if (active.moved && active.suppressClick) {
      suppressedMotherClickRef.current = active.motherId;
      window.setTimeout(() => {
        if (suppressedMotherClickRef.current === active.motherId) {
          suppressedMotherClickRef.current = null;
        }
      }, 0);
    }
    if (active.moved && target) {
      onReorderMother(active.motherId, target.id, target.position);
    }
    clearMotherDrag();
    event.preventDefault();
  };

  const clearSubTaskDrag = () => {
    activeSubTaskDragRef.current = null;
    subTaskDropTargetRef.current = null;
    setDraggedSubTaskId(null);
    setSubTaskDropTarget(null);
  };

  const beginSubTaskDrag = (
    mother: MotherTask,
    subTask: SubTask,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (busy || event.button !== 0) {
      return;
    }
    activeSubTaskDragRef.current = {
      pointerId: event.pointerId,
      motherId: mother.id,
      subTaskId: subTask.id,
      startY: event.clientY,
      moved: false,
    };
    setDraggedSubTaskId(subTask.id);
    setSubTaskDropTarget(null);
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const updateSubTaskDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const active = activeSubTaskDragRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    if (!active.moved && Math.abs(event.clientY - active.startY) < 4) {
      return;
    }
    active.moved = true;
    event.preventDefault();

    const subTaskRows = Array.from(
      document.querySelectorAll<HTMLElement>(
        `.task-row--subtask[data-sub-row-id][data-mother-row-id="${active.motherId}"]`,
      ),
    ).filter((element) => element.dataset.subRowId !== active.subTaskId);
    let nextTarget: SubTaskDropTarget | null = null;
    for (const element of subTaskRows) {
      const id = element.dataset.subRowId;
      if (!id) {
        continue;
      }
      const rectangle = element.getBoundingClientRect();
      if (event.clientY < rectangle.top + rectangle.height / 2) {
        nextTarget = { id, position: "before" };
        break;
      }
      nextTarget = { id, position: "after" };
    }
    subTaskDropTargetRef.current = nextTarget;
    setSubTaskDropTarget(nextTarget);
  };

  const finishSubTaskDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const active = activeSubTaskDragRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const target = subTaskDropTargetRef.current;
    if (active.moved && target) {
      onReorderSubTask(active.motherId, active.subTaskId, target.id, target.position);
    }
    clearSubTaskDrag();
    event.preventDefault();
  };

  useEffect(() => {
    wheelAnchorRef.current = anchorDate;
    wheelDeltaRef.current = 0;
  }, [anchorDate]);

  const monthGroups = useMemo(() => buildMonthGroups(range.dates), [range.dates]);

  useEffect(() => {
    const element = timelineColumnRef.current;
    if (!element) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      const horizontal =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.shiftKey
            ? event.deltaY
            : 0;
      if (horizontal === 0) {
        return;
      }
      event.preventDefault();
      wheelDeltaRef.current += horizontal;
      const days = Math.trunc(wheelDeltaRef.current / columnWidth);
      if (days === 0) {
        return;
      }
      wheelDeltaRef.current += days * columnWidth;
      const next = shiftAnchor(wheelAnchorRef.current, days);
      wheelAnchorRef.current = next;
      onAnchorChange(next, false);
      if (panCommitTimerRef.current !== null) {
        window.clearTimeout(panCommitTimerRef.current);
      }
      panCommitTimerRef.current = window.setTimeout(() => {
        panCommitTimerRef.current = null;
        onCommitPan();
      }, 300);
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      if (panCommitTimerRef.current !== null) {
        window.clearTimeout(panCommitTimerRef.current);
        panCommitTimerRef.current = null;
      }
    };
  }, [columnWidth, onAnchorChange, onCommitPan]);

  const clearPan = () => {
    activePanRef.current = null;
    setIsPanning(false);
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".timeline-bar, .resize-handle, [data-no-pan]")
    ) {
      return;
    }
    activePanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      baseAnchor: anchorDate,
      currentAnchor: anchorDate,
      moved: false,
      committedDays: 0,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const updatePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activePanRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - active.startX;
    if (!active.moved && Math.abs(deltaX) < 4) {
      return;
    }
    if (!active.moved) {
      active.moved = true;
      setIsPanning(true);
    }
    const offset = pixelsToDayOffset(-deltaX, columnWidth);
    if (offset === active.committedDays) {
      return;
    }
    active.committedDays = offset;
    active.currentAnchor = shiftAnchor(active.baseAnchor, offset);
    onAnchorChange(active.currentAnchor, false);
  };

  const finishPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activePanRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (active.moved) {
      onAnchorChange(active.currentAnchor, true);
    }
    clearPan();
  };

  return (
    <section className="board-frame" aria-label="工作规划时间板">
      <div className="board-scroll" ref={scrollContainerRef}>
        <div
          className="board-grid"
          style={
            {
              "--task-column-width": `${taskColumnWidth}px`,
              "--timeline-width": `${timelineWidth}px`,
            } as CSSProperties
          }
        >
          <div className="task-column" style={{ "--task-column-width": `${taskColumnWidth}px` } as CSSProperties}>
            <div className="task-column__header">
              <span>母任务 / 子任务</span>
              <div
                aria-label="调整任务名列宽"
                aria-valuemax={MAX_TASK_COLUMN_WIDTH}
                aria-valuemin={MIN_TASK_COLUMN_WIDTH}
                aria-valuenow={taskColumnWidth}
                className="task-column__resize-handle"
                onKeyDown={handleTaskColumnResizeKeyDown}
                onPointerCancel={() => {
                  activeTaskColumnResizeRef.current = null;
                }}
                onPointerDown={beginTaskColumnResize}
                onPointerMove={updateTaskColumnResize}
                onPointerUp={finishTaskColumnResize}
                role="separator"
                tabIndex={0}
              />
            </div>
            {rows.map((row) => (
              <TaskTreeRow
                busy={busy}
                key={row.kind === "subTask" ? row.subTask.id : `${row.kind}-${row.mother.id}`}
                onAddSubTask={onAddSubTask}
                onEditMother={onEditMother}
                onEditSubTask={onEditSubTask}
                onRequestDeleteMother={onRequestDeleteMother}
                draggedMotherId={draggedMotherId}
                dropTarget={motherDropTarget}
                onMotherPointerCancel={clearMotherDrag}
                onMotherPointerDown={beginMotherDrag}
                onMotherPointerMove={updateMotherDrag}
                onMotherPointerUp={finishMotherDrag}
                draggedSubTaskId={draggedSubTaskId}
                subTaskDropTarget={subTaskDropTarget}
                onSubTaskPointerCancel={clearSubTaskDrag}
                onSubTaskPointerDown={beginSubTaskDrag}
                onSubTaskPointerMove={updateSubTaskDrag}
                onSubTaskPointerUp={finishSubTaskDrag}
                onSetDependencies={onSetDependencies}
                onToggleMother={(mother) => {
                  if (suppressedMotherClickRef.current === mother.id) {
                    suppressedMotherClickRef.current = null;
                    return;
                  }
                  onToggleMother(mother);
                }}
                conflict={conflictMotherIds.has(row.mother.id)}
                focusedMotherId={focusedMotherId}
                relatedMotherIds={relatedMotherIds}
                onFocusMother={setFocusedMotherId}
                motherSortMode={motherSortMode}
                row={row}
              />
            ))}
          </div>

          <div
            className={`timeline-column ${isPanning ? "is-panning" : ""}`}
            onLostPointerCapture={finishPan}
            onPointerCancel={finishPan}
            onPointerDown={beginPan}
            onPointerMove={updatePan}
            onPointerUp={finishPan}
            ref={timelineColumnRef}
            style={{ width: timelineWidth }}
          >
            {quarterOverview ? (
              <QuarterTimelineHeader
                range={range}
                pixelsPerDay={columnWidth}
                timelineWidth={timelineWidth}
                today={today}
              />
            ) : (
              <>
                <div
                  aria-hidden="true"
                  className="date-header__months"
                  style={{ gridTemplateColumns: `repeat(${range.dates.length}, ${columnWidth}px)` }}
                >
                  {monthGroups.map((group) => (
                    <span
                      className="date-month"
                      key={group.key}
                      style={{ gridColumn: `span ${group.span}` }}
                    >
                      {group.label}
                    </span>
                  ))}
                </div>
                <div
                  className="date-header"
                  style={{ gridTemplateColumns: `repeat(${range.dates.length}, ${columnWidth}px)` }}
                >
                  {range.dates.map((date) => {
                    const weekday = dayOfWeek(date);
                    return (
                      <div
                        className={`date-cell ${showWeekends && (weekday === 0 || weekday === 6) ? "is-weekend" : ""} ${date === today ? "is-today" : ""}`}
                        key={date}
                      >
                        <strong>{formatShortDate(date)}</strong>
                        <span>{weekdayLabels[weekday]}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <div className="timeline-rows">
              {quarterOverview ? (
                <QuarterTimelineRows
                  busy={busy}
                  onDirectUpdate={onDirectUpdate}
                  focusedMotherId={focusedMotherId}
                  onEditSubTask={onEditSubTask}
                  onFocusMother={setFocusedMotherId}
                  onQuickAdd={onQuickAdd}
                  pixelsPerDay={columnWidth}
                  range={range}
                  relatedMotherIds={relatedMotherIds}
                  rows={rows}
                  timelineWidth={timelineWidth}
                  today={today}
                />
              ) : (
                <>
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
                      showWeekends={showWeekends}
                    />
                  ))}
                </>
              )}
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
  motherSortMode: MotherSortMode;
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
  draggedMotherId: string | null;
  dropTarget: MotherDropTarget | null;
  onMotherPointerDown: (
    mother: MotherTask,
    event: ReactPointerEvent<HTMLElement>,
    suppressClick: boolean,
  ) => void;
  onMotherPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onMotherPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onMotherPointerCancel: () => void;
  draggedSubTaskId: string | null;
  subTaskDropTarget: SubTaskDropTarget | null;
  onSubTaskPointerDown: (
    mother: MotherTask,
    subTask: SubTask,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onSubTaskPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onSubTaskPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onSubTaskPointerCancel: () => void;
}

type MotherActionIconName = "edit" | "dependency" | "add" | "delete";

function MotherActionIcon({ name }: { name: MotherActionIconName }) {
  if (name === "edit") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4 20h4l10.6-10.6a2.1 2.1 0 0 0-4-4L4 16v4Z" />
        <path d="m13.5 6.5 4 4" />
      </svg>
    );
  }
  if (name === "dependency") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M9.5 14.5 14.5 9.5" />
        <path d="M7.2 16.8 5.6 18.4a2.8 2.8 0 0 1-4-4l3.1-3.1a2.8 2.8 0 0 1 4 0" />
        <path d="m15.3 12.7a2.8 2.8 0 0 1 0-4l3.1-3.1a2.8 2.8 0 1 1 4 4l-1.6 1.6" />
      </svg>
    );
  }
  if (name === "add") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  );
}

function TaskTreeRow({
  row,
  busy,
  motherSortMode,
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
  draggedMotherId,
  dropTarget,
  onMotherPointerDown,
  onMotherPointerMove,
  onMotherPointerUp,
  onMotherPointerCancel,
  draggedSubTaskId,
  subTaskDropTarget,
  onSubTaskPointerDown,
  onSubTaskPointerMove,
  onSubTaskPointerUp,
  onSubTaskPointerCancel,
}: TaskTreeRowProps) {
  const focusClass = focusedMotherId
    ? relatedMotherIds.has(row.mother.id)
      ? "is-related"
      : ""
    : "";
  if (row.kind === "mother") {
    const motherTag = getMotherTag(row.mother);
    const canReorderMother = motherSortMode === "manual";
    const dropPosition = dropTarget?.id === row.mother.id
      ? dropTarget.position
      : null;
    const dragClass = [
      draggedMotherId === row.mother.id ? "is-dragging" : "",
      dropPosition ? `is-drop-${dropPosition}` : "",
    ].filter(Boolean).join(" ");
    return (
      <>
        {row.tagGroup ? (
          <div className="tag-group-row" aria-label={`${row.tagGroup.tag ?? "无标签"}标签组`}>
            <span className="tag-group-row__title">
              {row.tagGroup.tag ?? "无标签"}
            </span>
            <span className="tag-group-row__count">{row.tagGroup.count} 项母任务</span>
          </div>
        ) : null}
        <div
          className={`task-row task-row--mother ${motherSortMode === "tag" ? "mother-row--tag-sorted" : ""} ${conflict ? "has-conflict" : ""} ${focusClass} ${dragClass}`}
          data-mother-row-id={row.mother.id}
          onMouseEnter={() => onFocusMother(row.mother.id)}
          onMouseLeave={() => onFocusMother(null)}
        >
        <span
          aria-hidden="true"
          className={`mother-drag-handle ${canReorderMother ? "" : "mother-drag-handle--disabled"}`}
          data-testid={`mother-drag-handle-${row.mother.id}`}
          onPointerCancel={canReorderMother ? onMotherPointerCancel : undefined}
          onPointerDown={canReorderMother ? (event) => onMotherPointerDown(row.mother, event, false) : undefined}
          onPointerMove={canReorderMother ? onMotherPointerMove : undefined}
          onPointerUp={canReorderMother ? onMotherPointerUp : undefined}
          title={canReorderMother ? "按住拖动调整母任务顺序" : "按标签分组时不可调整母任务顺序"}
        >
          <svg viewBox="0 0 12 18">
            <circle cx="3" cy="4" r="1.2" />
            <circle cx="9" cy="4" r="1.2" />
            <circle cx="3" cy="9" r="1.2" />
            <circle cx="9" cy="9" r="1.2" />
            <circle cx="3" cy="14" r="1.2" />
            <circle cx="9" cy="14" r="1.2" />
          </svg>
        </span>
        <button
          aria-label={row.mother.expanded ? "收起母任务" : "展开母任务"}
          className="tree-toggle"
          disabled={busy}
          onClick={() => onToggleMother(row.mother)}
        >
          {row.mother.expanded ? "⌄" : "›"}
        </button>
        <button
          aria-expanded={row.mother.expanded}
          aria-label={`${row.mother.expanded ? "收起" : "展开"}母任务“${row.mother.name}”`}
          className="task-name task-name--mother"
          disabled={busy}
          onClick={() => onToggleMother(row.mother)}
          onPointerCancel={canReorderMother ? onMotherPointerCancel : undefined}
          onPointerDown={canReorderMother ? (event) => onMotherPointerDown(row.mother, event, true) : undefined}
          onPointerMove={canReorderMother ? onMotherPointerMove : undefined}
          onPointerUp={canReorderMother ? onMotherPointerUp : undefined}
          title={`${row.mother.expanded ? "点击收起子任务" : "点击展开子任务"}${canReorderMother ? "；按住拖动可调整顺序" : ""}`}
        >
          {row.mother.name}
        </button>
        {motherTag ? (
          <span
            className="mother-tag"
            data-tone={getMotherTagTone(motherTag)}
            title={`标签：${motherTag}`}
          >
            {motherTag}
          </span>
        ) : null}
        <span className="task-count">{row.mother.subTasks.length}</span>
        {row.mother.dependsOn.length > 0 ? (
          <span
            className="dependency-badge"
            title={`已有 ${row.mother.dependsOn.length} 个前置母任务`}
          >
            依赖 {row.mother.dependsOn.length}
          </span>
        ) : null}
        {conflict ? (
          <span className="conflict-indicator" title="当前排期与前置需求存在冲突">
            ⚠
          </span>
        ) : null}
        <div className="row-actions">
          <button
            aria-label={`修改母任务“${row.mother.name}”`}
            className="row-action"
            disabled={busy}
            onClick={() => onEditMother(row.mother)}
            title="修改母任务"
          >
            <MotherActionIcon name="edit" />
          </button>
          <button
            aria-label={`设置“${row.mother.name}”的依赖`}
            className="row-action"
            disabled={busy}
            onClick={() => onSetDependencies(row.mother)}
            title="设置依赖"
          >
            <MotherActionIcon name="dependency" />
          </button>
          <button
            aria-label={`为“${row.mother.name}”添加子任务`}
            className="row-action"
            disabled={busy}
            onClick={() => onAddSubTask(row.mother)}
            title="添加子任务"
          >
            <MotherActionIcon name="add" />
          </button>
          <button
            aria-label={`删除母任务“${row.mother.name}”`}
            className="row-action row-action--danger"
            disabled={busy}
            onClick={() => onRequestDeleteMother(row.mother)}
            title="删除母任务"
          >
            <MotherActionIcon name="delete" />
          </button>
        </div>
        </div>
      </>
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

  if (row.kind === "subTask") {
    const subDropPosition = subTaskDropTarget?.id === row.subTask.id
      ? subTaskDropTarget.position
      : null;
    const subDragClass = [
      draggedSubTaskId === row.subTask.id ? "is-dragging" : "",
      subDropPosition ? `is-drop-${subDropPosition}` : "",
    ].filter(Boolean).join(" ");
    return (
      <div
        className={`task-row task-row--subtask ${focusClass} ${subDragClass}`}
        data-sub-row-id={row.subTask.id}
        data-mother-row-id={row.mother.id}
      >
        <span
          aria-hidden="true"
          className="subtask-drag-handle"
          data-testid={`subtask-drag-handle-${row.subTask.id}`}
          onPointerCancel={onSubTaskPointerCancel}
          onPointerDown={(event) =>
            onSubTaskPointerDown(row.mother, row.subTask, event)
          }
          onPointerMove={onSubTaskPointerMove}
          onPointerUp={onSubTaskPointerUp}
          title="按住拖动调整子任务顺序"
        >
          <svg viewBox="0 0 12 18">
            <circle cx="3" cy="4" r="1.2" />
            <circle cx="9" cy="4" r="1.2" />
            <circle cx="3" cy="9" r="1.2" />
            <circle cx="9" cy="9" r="1.2" />
            <circle cx="3" cy="14" r="1.2" />
            <circle cx="9" cy="14" r="1.2" />
          </svg>
        </span>
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

  return null;
}

interface TimelineRowProps {
  row: BoardRow;
  showWeekends: boolean;
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
  showWeekends,
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
      : ""
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
            className={showWeekends && (weekday === 0 || weekday === 6) ? "is-weekend" : ""}
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
      <>
        {row.tagGroup ? (
          <div className="tag-group-row tag-group-row--timeline" aria-hidden="true" />
        ) : null}
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
      </>
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
    if (row.kind === "mother" && row.tagGroup) {
      totalHeight += 31;
    }
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

function EmptyBoard({
  onCreate,
  onImport,
}: {
  onCreate: () => void;
  onImport: () => void;
}) {
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
        <button className="button button--quiet" onClick={onImport}>
          导入 JSON
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

function ImportTemplateDialog({
  onCancel,
  onCopy,
}: {
  onCancel: () => void;
  onCopy: () => void;
}) {
  return (
    <DialogShell title="AI 导入模板" onCancel={onCancel}>
      <div className="form-stack import-template">
        <div className="import-template__guide">
          <strong>让 AI 帮你整理规划</strong>
          <p>
            复制下面的模板并连同原始规划发给 AI，让它替换示例内容，且只返回 JSON，
            不要添加 Markdown 代码块。将结果保存为 <code>.json</code> 后即可导入。
          </p>
        </div>
        <ul className="import-template__rules">
          <li>所有 id 必须唯一；dependsOn 只能填写前置母任务的 id。</li>
          <li>日期使用 YYYY-MM-DD；单日任务的 endDate 填 null。</li>
          <li>删除不需要的示例任务，不要保留占位内容。</li>
        </ul>
        <label className="import-template__content">
          <span>可导入 JSON 模板</span>
          <textarea aria-label="可导入 JSON 模板" readOnly value={IMPORT_TEMPLATE} />
        </label>
        <footer className="modal-actions modal-actions--end">
          <button className="button button--quiet" onClick={onCancel} type="button">
            关闭
          </button>
          <button className="button button--primary button--with-icon" onClick={onCopy} type="button">
            <svg aria-hidden="true" className="button__icon" viewBox="0 0 24 24">
              <rect height="12" rx="1.5" width="10" x="9" y="8" />
              <path d="M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-7A1.5 1.5 0 0 0 5 5.5v9A1.5 1.5 0 0 0 6.5 16H9" />
            </svg>
            复制模板
          </button>
        </footer>
      </div>
    </DialogShell>
  );
}

interface MotherTaskDialogProps {
  mode: "create" | "rename";
  initialName: string;
  initialTag: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, tag: string) => Promise<void>;
  onDelete?: () => void;
}

function MotherTaskDialog({
  mode,
  initialName,
  initialTag,
  busy,
  onCancel,
  onSubmit,
  onDelete,
}: MotherTaskDialogProps) {
  const [name, setName] = useState(initialName);
  const [tag, setTag] = useState(initialTag);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("请输入母任务名称。");
      return;
    }
    setError(null);
    void onSubmit(name, tag);
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
        <label className="field-label mother-tag-field">
          <span>标签（可选）</span>
          <input
            disabled={busy}
            maxLength={MOTHER_TAG_MAX_LENGTH}
            onChange={(event) => setTag(event.target.value)}
            placeholder="例如：产品、内容、研究"
            value={tag}
          />
        </label>
        <p className="field-hint">按标签分组时，同一标签的母任务会排在一起；留空归入“无标签”。</p>
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

interface ImportDialogProps {
  state: ImportState;
  busy: boolean;
  onCancel: () => void;
  onModeChange: (mode: ImportMode) => void;
  onSubmit: () => void;
}

function ImportDialog({
  state,
  busy,
  onCancel,
  onModeChange,
  onSubmit,
}: ImportDialogProps) {
  return (
    <DialogShell title="导入规划数据" onCancel={onCancel}>
      <div className="form-stack">
        <div className="import-file-summary">
          <strong>{state.source.fileName}</strong>
          <span>
            版本 {state.preview.version ?? "未知"} · {state.preview.motherTaskCount} 个母任务 · {state.preview.subTaskCount} 个子任务 · {state.preview.dependencyCount} 条依赖
          </span>
        </div>
        <fieldset className="import-modes">
          <legend>导入方式</legend>
          <label>
            <input
              checked={state.mode === "overwrite"}
              disabled={busy}
              name="import-mode"
              onChange={() => onModeChange("overwrite")}
              type="radio"
            />
            <span>
              <strong>覆盖</strong>
              <small>替换当前全部规划数据</small>
            </span>
          </label>
          <label>
            <input
              checked={state.mode === "merge"}
              disabled={busy}
              name="import-mode"
              onChange={() => onModeChange("merge")}
              type="radio"
            />
            <span>
              <strong>合并</strong>
              <small>按 id 更新，文件中没有的当前任务保持不动</small>
            </span>
          </label>
        </fieldset>
        {state.preview.valid ? (
          <p className="import-valid">文件校验通过，可以开始导入。</p>
        ) : (
          <div className="import-errors" role="alert">
            <strong>发现 {state.preview.errors.length} 个问题</strong>
            <ul>
              {state.preview.errors.map((error, index) => (
                <li key={`${error.path}-${index}`}>
                  <code>{error.path}</code>
                  <span>{error.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <footer className="modal-actions modal-actions--end">
          <button className="button button--quiet" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="button button--primary"
            disabled={busy || !state.preview.valid}
            onClick={onSubmit}
          >
            开始导入
          </button>
        </footer>
      </div>
    </DialogShell>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
}

function ConfirmDialog({
  title,
  description,
  busy,
  onCancel,
  onConfirm,
  confirmLabel = "确认删除",
}: ConfirmDialogProps) {
  return (
    <DialogShell title={title} onCancel={onCancel}>
      <p className="confirm-copy">{description}</p>
      <footer className="modal-actions modal-actions--end">
        <button className="button button--quiet" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="button button--danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </footer>
    </DialogShell>
  );
}
