import {
  addDays,
  addMonths,
  assertDateOnly,
  compareDateOnly,
  dayOfWeek,
  daysInMonth,
  diffDays,
  startOfMonth,
  startOfWeek,
} from "../../domain/dateOnly";
import type { DateOnly } from "../../domain/models";
import type { ViewRange } from "./viewRange";

/** The rolling overview is constrained to a three-month-sized window. */
export const QUARTER_MIN_DAYS = 90;
export const QUARTER_MAX_DAYS = 92;

/**
 * A single-day task is still visible when a quarter is compressed to a few
 * pixels per day.  The renderer can use this minimum without changing the
 * date-to-pixel scale used by longer tasks.
 */
export const QUARTER_MIN_BAR_WIDTH = 6;

export interface QuarterMonthBand {
  key: string;
  label: string;
  startOffset: number;
  dayCount: number;
}

export interface QuarterWeekTick {
  date: DateOnly;
  dayOffset: number;
}

export interface QuarterBarGeometry {
  left: number;
  width: number;
}

/**
 * Return the date three calendar months after an arbitrary date.
 *
 * `dateOnly.addMonths` intentionally returns the first day of the target
 * month, so the original day is applied separately and clamped to the target
 * month's actual length (for example, Jan 31 -> Apr 30).
 */
function threeMonthAnniversary(anchorDate: DateOnly): DateOnly {
  assertDateOnly(anchorDate);
  const targetMonth = addMonths(startOfMonth(anchorDate), 3);
  const requestedDay = Number(anchorDate.slice(8, 10));
  const targetDay = Math.min(requestedDay, daysInMonth(targetMonth));
  return addDays(targetMonth, targetDay - 1);
}

function clampQuarterDayCount(dayCount: number): number {
  return Math.min(
    QUARTER_MAX_DAYS,
    Math.max(QUARTER_MIN_DAYS, Math.round(dayCount)),
  );
}

/**
 * Build a continuous rolling quarter from the supplied anchor date.
 *
 * The anniversary itself is exclusive: an anchor of 2026-09-17 with a
 * 2026-12-17 anniversary yields 91 visible days (through 2026-12-16).
 * Month-end cases can produce 89 days, so the result is clamped to the
 * product's 90–92-day contract.
 */
export function getQuarterOverviewRange(anchorDate: DateOnly): ViewRange {
  const anniversary = threeMonthAnniversary(anchorDate);
  const dayCount = clampQuarterDayCount(diffDays(anchorDate, anniversary));
  const dates = Array.from({ length: dayCount }, (_, index) =>
    addDays(anchorDate, index),
  );

  return {
    startDate: anchorDate,
    endDate: dates.at(-1) ?? anchorDate,
    dates,
  };
}

function monthKey(date: DateOnly): string {
  return date.slice(0, 7);
}

function monthLabel(date: DateOnly): string {
  return `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`;
}

/** Build date-proportional month bands for the overview header. */
export function buildQuarterMonthBands(
  range: ViewRange,
): QuarterMonthBand[] {
  const bands: QuarterMonthBand[] = [];
  range.dates.forEach((date, index) => {
    const key = monthKey(date);
    const previous = bands.at(-1);
    if (previous?.key === key) {
      previous.dayCount += 1;
      return;
    }
    bands.push({
      key,
      label: monthLabel(date),
      startOffset: index,
      dayCount: 1,
    });
  });
  return bands;
}

/**
 * Build Monday ticks that fall inside the continuous window.  The first tick
 * is the first Monday on or after the arbitrary anchor; no week alignment is
 * imposed on the window itself.
 */
export function buildQuarterWeekTicks(range: ViewRange): QuarterWeekTick[] {
  if (range.dates.length === 0) {
    return [];
  }

  let tick = startOfWeek(range.startDate);
  if (compareDateOnly(tick, range.startDate) < 0) {
    tick = addDays(tick, 7);
  }

  const ticks: QuarterWeekTick[] = [];
  while (compareDateOnly(tick, range.endDate) <= 0) {
    ticks.push({
      date: tick,
      dayOffset: diffDays(range.startDate, tick),
    });
    tick = addDays(tick, 7);
  }
  return ticks;
}

function effectiveRangeDayCount(range: ViewRange): number {
  return Math.max(1, range.dates.length || diffDays(range.startDate, range.endDate) + 1);
}

/**
 * Convert an inclusive date range into continuous quarter coordinates.
 * Values outside the window are clipped; a fully out-of-range task returns
 * null.  Single-day tasks receive a small minimum marker while remaining
 * centered in their date slot.
 */
export function getQuarterBarGeometry(
  startDate: DateOnly,
  endDate: DateOnly,
  range: ViewRange,
  pixelsPerDay: number,
): QuarterBarGeometry | null {
  if (!Number.isFinite(pixelsPerDay) || pixelsPerDay <= 0) {
    return null;
  }
  if (compareDateOnly(endDate, startDate) < 0) {
    return null;
  }
  if (
    compareDateOnly(endDate, range.startDate) < 0 ||
    compareDateOnly(startDate, range.endDate) > 0
  ) {
    return null;
  }

  const visibleStart =
    compareDateOnly(startDate, range.startDate) < 0
      ? range.startDate
      : startDate;
  const visibleEnd =
    compareDateOnly(endDate, range.endDate) > 0 ? range.endDate : endDate;
  const left = diffDays(range.startDate, visibleStart) * pixelsPerDay;
  const naturalWidth =
    (diffDays(visibleStart, visibleEnd) + 1) * pixelsPerDay;
  const timelineWidth = effectiveRangeDayCount(range) * pixelsPerDay;
  if (naturalWidth >= QUARTER_MIN_BAR_WIDTH) {
    return { left, width: naturalWidth };
  }

  const width = Math.min(QUARTER_MIN_BAR_WIDTH, timelineWidth);
  const centeredLeft = left + naturalWidth / 2 - width / 2;
  return {
    left: Math.max(0, Math.min(timelineWidth - width, centeredLeft)),
    width,
  };
}

/** Map a horizontal offset to the nearest visible date, clamping at edges. */
export function getQuarterDateAtOffset(
  offset: number,
  range: ViewRange,
  pixelsPerDay: number,
): DateOnly {
  if (!Number.isFinite(offset) || !Number.isFinite(pixelsPerDay) || pixelsPerDay <= 0) {
    return range.startDate;
  }
  const dayCount = effectiveRangeDayCount(range);
  const rawIndex = Math.floor(offset / pixelsPerDay);
  const index = Math.max(0, Math.min(dayCount - 1, rawIndex));
  return range.dates[index] ?? addDays(range.startDate, index);
}

/** Kept as a small utility for callers that need to render weekday labels. */
export function isQuarterMonday(date: DateOnly): boolean {
  return dayOfWeek(date) === 1;
}
