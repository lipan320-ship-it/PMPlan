import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  compareDateOnly,
  diffDays,
  todayDateOnly,
} from "../../domain/dateOnly";
import type { DateOnly, MotherTask, SubTask } from "../../domain/models";
import { getMotherSpan } from "../../domain/schedule";
import type { BoardRow } from "./BoardPage";
import {
  moveSubTask,
  pixelsToDayOffset,
  resizeSubTaskEnd,
  resizeSubTaskStart,
  type DateRangeUpdate,
} from "./directManipulation";
import {
  buildQuarterMonthBands,
  buildQuarterWeekTicks,
  getQuarterBarGeometry,
  getQuarterDateAtOffset,
  QUARTER_MIN_BAR_WIDTH,
} from "./quarterOverview";
import type { ViewRange } from "./viewRange";

export interface QuarterTimelineHeaderProps {
  range: ViewRange;
  pixelsPerDay: number;
  timelineWidth: number;
  today?: DateOnly;
}

export interface QuarterTimelineRowsProps {
  rows: BoardRow[];
  range: ViewRange;
  pixelsPerDay: number;
  timelineWidth: number;
  busy: boolean;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
  onDirectUpdate: (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => void;
  onQuickAdd: (mother: MotherTask, initialDate: DateOnly) => void;
  focusedMotherId: string | null;
  relatedMotherIds: Set<string>;
  onFocusMother: (motherId: string | null) => void;
  today?: DateOnly;
}

function formatShortDate(value: DateOnly): string {
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}

function focusClass(
  motherId: string,
  focusedMotherId: string | null,
  relatedMotherIds: Set<string>,
): string {
  return focusedMotherId && relatedMotherIds.has(motherId) ? "is-related" : "";
}

/**
 * The compact quarter header intentionally omits one cell per day.  Month
 * bands and Monday ticks are positioned by date distance, so unequal month
 * lengths remain visually proportional.
 */
export function QuarterTimelineHeader({
  range,
  pixelsPerDay,
  timelineWidth,
}: QuarterTimelineHeaderProps) {
  const monthBands = buildQuarterMonthBands(range);
  const weekTicks = buildQuarterWeekTicks(range);
  const safePixelsPerDay = Number.isFinite(pixelsPerDay) && pixelsPerDay > 0
    ? pixelsPerDay
    : 1;

  return (
    <header
      aria-label="季度总览日期"
      className="quarter-timeline__header"
      data-testid="quarter-timeline-header"
      style={{ width: timelineWidth }}
    >
      <div className="quarter-timeline__months" aria-label="月份分组">
        {monthBands.map((band) => (
          <span
            className="quarter-timeline__month"
            data-testid="quarter-month-band"
            key={band.key}
            style={{
              left: band.startOffset * safePixelsPerDay,
              width: band.dayCount * safePixelsPerDay,
            }}
            title={`${band.label}（${band.dayCount} 天）`}
          >
            {band.label}
          </span>
        ))}
      </div>
      <div className="quarter-timeline__weeks" aria-label="周刻度">
        {weekTicks.map((tick) => (
          <span
            className="quarter-timeline__week-tick"
            data-testid="quarter-week-tick"
            key={tick.date}
            style={{ left: tick.dayOffset * safePixelsPerDay }}
            title={`${formatShortDate(tick.date)} 周一`}
          >
            <i aria-hidden="true" />
            <strong>{formatShortDate(tick.date)}</strong>
          </span>
        ))}
      </div>
    </header>
  );
}

function QuarterRowBackground({
  range,
  pixelsPerDay,
}: {
  range: ViewRange;
  pixelsPerDay: number;
}) {
  const safePixelsPerDay = Number.isFinite(pixelsPerDay) && pixelsPerDay > 0
    ? pixelsPerDay
    : 1;
  return (
    <div
      aria-hidden="true"
      className="quarter-timeline__row-grid"
      data-testid="quarter-row-grid"
    >
      {buildQuarterMonthBands(range).slice(1).map((band) => (
        <span
          className="quarter-timeline__month-line"
          key={`month-${band.key}`}
          style={{ left: band.startOffset * safePixelsPerDay }}
        />
      ))}
      {buildQuarterWeekTicks(range).map((tick) => (
        <span
          className="quarter-timeline__week-line"
          key={tick.date}
          style={{ left: tick.dayOffset * safePixelsPerDay }}
        />
      ))}
    </div>
  );
}

function QuarterTodayLine({
  range,
  pixelsPerDay,
  today,
}: {
  range: ViewRange;
  pixelsPerDay: number;
  today: DateOnly;
}) {
  if (
    compareDateOnly(today, range.startDate) < 0 ||
    compareDateOnly(today, range.endDate) > 0
  ) {
    return null;
  }
  const safePixelsPerDay = Number.isFinite(pixelsPerDay) && pixelsPerDay > 0
    ? pixelsPerDay
    : 1;
  return (
    <span
      aria-hidden="true"
      className="quarter-timeline__today-line"
      style={{
        left:
          diffDays(range.startDate, today) * safePixelsPerDay +
          safePixelsPerDay / 2,
      }}
    />
  );
}

interface QuarterTimelineRowProps {
  row: BoardRow;
  range: ViewRange;
  pixelsPerDay: number;
  busy: boolean;
  onEditSubTask: (mother: MotherTask, subTask: SubTask) => void;
  onDirectUpdate: (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => void;
  onQuickAdd: (mother: MotherTask, initialDate: DateOnly) => void;
  focusedMotherId: string | null;
  relatedMotherIds: Set<string>;
  onFocusMother: (motherId: string | null) => void;
}

interface QuarterInteractiveTaskBarProps {
  mother: MotherTask;
  subTask: SubTask;
  geometry: { left: number; width: number };
  pixelsPerDay: number;
  busy: boolean;
  onEdit: (mother: MotherTask, subTask: SubTask) => void;
  onDirectUpdate: (
    mother: MotherTask,
    subTask: SubTask,
    update: DateRangeUpdate,
  ) => void;
}

type QuarterInteractionMode = "move" | "resizeStart" | "resizeEnd";

interface ActiveQuarterDrag {
  pointerId: number;
  mode: QuarterInteractionMode;
  startX: number;
  dayOffset: number;
  moved: boolean;
}

function QuarterInteractiveTaskBar({
  mother,
  subTask,
  geometry,
  pixelsPerDay,
  busy,
  onEdit,
  onDirectUpdate,
}: QuarterInteractiveTaskBarProps) {
  const interactionRef = useRef<ActiveQuarterDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<{
    update: DateRangeUpdate;
    mode: QuarterInteractionMode;
    dayOffset: number;
  } | null>(null);
  const effectiveEnd = subTask.endDate ?? subTask.startDate;
  const previewPixelOffset = (preview?.dayOffset ?? 0) * pixelsPerDay;
  const visualLeft =
    geometry.left +
    (preview?.mode === "resizeStart" || preview?.mode === "move"
      ? previewPixelOffset
      : 0);
  const visualWidth = Math.max(
    QUARTER_MIN_BAR_WIDTH,
    geometry.width +
      (preview?.mode === "resizeStart"
        ? -previewPixelOffset
        : preview?.mode === "resizeEnd"
          ? previewPixelOffset
          : 0),
  );
  const hitWidth = Math.max(visualWidth, 24);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (busy || event.button !== 0) {
      return;
    }
    const edge = (event.target as HTMLElement).dataset.edge;
    const mode: QuarterInteractionMode =
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

  const updateDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = interactionRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    const dayOffset = pixelsToDayOffset(
      event.clientX - active.startX,
      pixelsPerDay,
    );
    const update =
      active.mode === "move"
        ? moveSubTask(subTask, dayOffset)
        : active.mode === "resizeStart"
          ? resizeSubTaskStart(subTask, dayOffset)
          : resizeSubTaskEnd(subTask, dayOffset);
    const updatedEnd = update.endDate ?? update.startDate;
    const effectiveDayOffset =
      active.mode === "move"
        ? diffDays(subTask.startDate, update.startDate)
        : active.mode === "resizeStart"
          ? diffDays(subTask.startDate, update.startDate)
          : diffDays(effectiveEnd, updatedEnd);
    active.dayOffset = effectiveDayOffset;
    active.moved = active.moved || Math.abs(event.clientX - active.startX) >= 4;
    setPreview({
      update,
      mode: active.mode,
      dayOffset: effectiveDayOffset,
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = interactionRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    interactionRef.current = null;
    const update = preview?.update;
    setPreview(null);
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId) &&
      typeof event.currentTarget.releasePointerCapture === "function"
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    suppressClickRef.current = active.moved;
    const dateChanged =
      update &&
      (update.startDate !== subTask.startDate || update.endDate !== subTask.endDate);
    if (active.moved && update && dateChanged) {
      onDirectUpdate(mother, subTask, update);
    }
  };

  const cancelDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = interactionRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    interactionRef.current = null;
    setPreview(null);
  };

  return (
    <button
      aria-label={`编辑子任务“${subTask.name}”`}
      className={`quarter-timeline__bar-hit-target ${preview ? "is-interacting" : ""}`}
      data-no-pan="true"
      data-testid={`quarter-subtask-${subTask.id}`}
      disabled={busy}
      onClick={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          event.preventDefault();
          return;
        }
        onEdit(mother, subTask);
      }}
      onPointerCancel={cancelDrag}
      onPointerDown={beginDrag}
      onPointerMove={updateDrag}
      onPointerUp={finishDrag}
      style={{
        left: visualLeft,
        top: 0,
        width: hitWidth,
        height: "100%",
      }}
      title={`${subTask.name}：${subTask.startDate} 至 ${effectiveEnd}；拖动主体或边缘调整日期，点击编辑日期`}
      type="button"
    >
      <span
        aria-hidden="true"
        className="quarter-resize-handle quarter-resize-handle--start"
        data-edge="start"
      />
      <span
        className="quarter-timeline__bar quarter-timeline__bar--subtask"
        style={{ left: 0, width: visualWidth }}
      >
        <span className="quarter-timeline__bar-label">{subTask.name}</span>
        {preview ? (
          <span
            className="drag-preview"
            data-testid="quarter-drag-preview"
            role="status"
          >
            {preview.update.startDate} → {preview.update.endDate ?? preview.update.startDate}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className="quarter-resize-handle quarter-resize-handle--end"
        data-edge="end"
        style={{ left: visualWidth }}
      />
    </button>
  );
}

function QuarterTimelineRow({
  row,
  range,
  pixelsPerDay,
  busy,
  onEditSubTask,
  onDirectUpdate,
  onQuickAdd,
  focusedMotherId,
  relatedMotherIds,
  onFocusMother,
}: QuarterTimelineRowProps) {
  const focus = focusClass(row.mother.id, focusedMotherId, relatedMotherIds);
  const rowClass = `quarter-timeline__row quarter-timeline__row--${row.kind} ${focus}`;
  const background = (
    <QuarterRowBackground range={range} pixelsPerDay={pixelsPerDay} />
  );

  if (row.kind === "empty") {
    return (
      <div
        className={rowClass}
        data-mother-id={row.mother.id}
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
      ? getQuarterBarGeometry(
          span.startDate,
          span.endDate,
          range,
          pixelsPerDay,
        )
      : null;
    return (
      <>
        {row.tagGroup ? (
          <div className="tag-group-row tag-group-row--timeline" aria-hidden="true" />
        ) : null}
        <div
          className={`${rowClass} quarter-timeline__row--quick-add`}
          data-mother-id={row.mother.id}
          data-testid={`quarter-mother-timeline-${row.mother.id}`}
          onDoubleClick={(event) => {
            if (busy) {
              return;
            }
            const rectangle = event.currentTarget.getBoundingClientRect();
            const initialDate = getQuarterDateAtOffset(
              event.clientX - rectangle.left,
              range,
              pixelsPerDay,
            );
            onQuickAdd(row.mother, initialDate);
          }}
          onMouseEnter={() => onFocusMother(row.mother.id)}
          onMouseLeave={() => onFocusMother(null)}
          title="双击日期快速添加子任务"
        >
          {background}
          {geometry && span ? (
            <span
              aria-label={`${row.mother.name}：${span.startDate} 至 ${span.endDate}`}
              className="quarter-timeline__bar quarter-timeline__bar--mother"
              data-no-pan="true"
              style={{ left: geometry.left, width: geometry.width }}
              title={`${row.mother.name}：${span.startDate} 至 ${span.endDate}`}
            />
          ) : null}
        </div>
      </>
    );
  }

  const endDate = row.subTask.endDate ?? row.subTask.startDate;
  const geometry = getQuarterBarGeometry(
    row.subTask.startDate,
    endDate,
    range,
    pixelsPerDay,
  );
  return (
    <div
      className={rowClass}
      data-mother-id={row.mother.id}
      data-subtask-id={row.subTask.id}
      onMouseEnter={() => onFocusMother(row.mother.id)}
      onMouseLeave={() => onFocusMother(null)}
    >
      {background}
      {geometry ? (
        <QuarterInteractiveTaskBar
          busy={busy}
          geometry={geometry}
          mother={row.mother}
          onDirectUpdate={onDirectUpdate}
          onEdit={onEditSubTask}
          pixelsPerDay={pixelsPerDay}
          subTask={row.subTask}
        />
      ) : null}
    </div>
  );
}

/** Render compact quarter rows with whole-bar date shifting and exact edit fallback. */
export function QuarterTimelineRows({
  rows,
  range,
  pixelsPerDay,
  timelineWidth,
  busy,
  onEditSubTask,
  onDirectUpdate,
  onQuickAdd,
  focusedMotherId,
  relatedMotherIds,
  onFocusMother,
  today = todayDateOnly(),
}: QuarterTimelineRowsProps) {
  return (
    <div
      aria-label="季度总览任务"
      className="quarter-timeline__rows"
      data-testid="quarter-timeline-rows"
      style={{ width: timelineWidth }}
    >
      <QuarterTodayLine range={range} pixelsPerDay={pixelsPerDay} today={today} />
      {rows.map((row) => (
        <QuarterTimelineRow
          busy={busy}
          focusedMotherId={focusedMotherId}
          key={row.kind === "subTask" ? row.subTask.id : `${row.kind}-${row.mother.id}`}
          onEditSubTask={onEditSubTask}
          onDirectUpdate={onDirectUpdate}
          onFocusMother={onFocusMother}
          onQuickAdd={onQuickAdd}
          pixelsPerDay={pixelsPerDay}
          range={range}
          relatedMotherIds={relatedMotherIds}
          row={row}
        />
      ))}
    </div>
  );
}
