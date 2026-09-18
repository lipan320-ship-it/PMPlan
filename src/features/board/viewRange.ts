import { addDays } from "../../domain/dateOnly";
import type { DateOnly, ViewMode } from "../../domain/models";

export interface ViewRange {
  startDate: DateOnly;
  endDate: DateOnly;
  dates: DateOnly[];
}

const MIN_VISIBLE_DAYS = 7;
const MAX_VISIBLE_DAYS = 92;

/**
 * jsdom 与首帧尚未测得视口宽度时（viewportWidth === 0）的兜底天数。
 * 缺失兜底会导致首帧与集成测试拿到空窗口。
 */
const FALLBACK_DAY_COUNT: Record<ViewMode, number> = {
  week: 7,
  biweek: 14,
  month: 30,
};

export function getDayColumnWidth(viewMode: ViewMode): number {
  if (viewMode === "week") {
    return 104;
  }
  if (viewMode === "biweek") {
    return 74;
  }
  return 48;
}

/** 从 anchorDate 起连续 dayCount 天，不按周首 / 月初对齐。 */
export function getViewRange(
  anchorDate: DateOnly,
  dayCount: number,
): ViewRange {
  const totalDays = clampDayCount(dayCount);
  const dates = Array.from({ length: totalDays }, (_, index) =>
    addDays(anchorDate, index),
  );

  return {
    startDate: dates[0] ?? anchorDate,
    endDate: dates.at(-1) ?? anchorDate,
    dates,
  };
}

/** 可见天数由可用宽度与档位基准列宽推导，保证日期密度稳定。 */
export function getVisibleDayCount(
  availableTimelineWidth: number,
  viewMode: ViewMode,
): number {
  if (!Number.isFinite(availableTimelineWidth) || availableTimelineWidth <= 0) {
    return FALLBACK_DAY_COUNT[viewMode];
  }
  const baseColumnWidth = getDayColumnWidth(viewMode);
  return clampDayCount(
    Math.round(availableTimelineWidth / baseColumnWidth),
  );
}

/** 按天位移锚点，是连续平移与翻页的唯一位置运算。 */
export function shiftAnchor(anchorDate: DateOnly, days: number): DateOnly {
  return addDays(anchorDate, days);
}

/** 翻页步长取半个窗口，使相邻窗口存在重叠，维持连续感。 */
export function getPanStepDays(dayCount: number): number {
  return Math.max(1, Math.round(clampDayCount(dayCount) / 2));
}

/**
 * 把关注日（今天）定位到窗口前约四分之一处，
 * 避免去对齐后「点今天只看得到未来」。
 */
export function getAnchorForFocusDate(
  focusDate: DateOnly,
  dayCount: number,
): DateOnly {
  const leadDays = Math.max(1, Math.floor(clampDayCount(dayCount) / 4));
  return addDays(focusDate, -leadDays);
}

function clampDayCount(dayCount: number): number {
  if (!Number.isFinite(dayCount)) {
    return MIN_VISIBLE_DAYS;
  }
  const rounded = Math.round(dayCount);
  return Math.min(MAX_VISIBLE_DAYS, Math.max(MIN_VISIBLE_DAYS, rounded));
}
