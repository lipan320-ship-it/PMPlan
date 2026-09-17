import {
  addDays,
  addMonths,
  daysInMonth,
  startOfMonth,
  startOfWeek,
} from "../../domain/dateOnly";
import type { DateOnly, ViewMode } from "../../domain/models";

export interface ViewRange {
  startDate: DateOnly;
  endDate: DateOnly;
  dates: DateOnly[];
}

export function getViewRange(
  viewMode: ViewMode,
  anchorDate: DateOnly,
): ViewRange {
  const startDate =
    viewMode === "month" ? startOfMonth(anchorDate) : startOfWeek(anchorDate);
  const totalDays =
    viewMode === "week"
      ? 7
      : viewMode === "biweek"
        ? 14
        : daysInMonth(anchorDate);
  const dates = Array.from({ length: totalDays }, (_, index) =>
    addDays(startDate, index),
  );

  return {
    startDate,
    endDate: dates.at(-1) ?? startDate,
    dates,
  };
}

export function navigateAnchor(
  viewMode: ViewMode,
  anchorDate: DateOnly,
  direction: -1 | 1,
): DateOnly {
  if (viewMode === "month") {
    return addMonths(anchorDate, direction);
  }
  return addDays(anchorDate, direction * (viewMode === "week" ? 7 : 14));
}

export function getDayColumnWidth(viewMode: ViewMode): number {
  if (viewMode === "week") {
    return 104;
  }
  if (viewMode === "biweek") {
    return 74;
  }
  return 48;
}
