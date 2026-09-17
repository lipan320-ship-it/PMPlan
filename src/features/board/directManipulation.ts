import { addDays, diffDays } from "../../domain/dateOnly";
import type { DateOnly, SubTask } from "../../domain/models";

export interface DateRangeUpdate {
  startDate: DateOnly;
  endDate: DateOnly | null;
}

export function pixelsToDayOffset(deltaX: number, columnWidth: number): number {
  if (!Number.isFinite(deltaX) || !Number.isFinite(columnWidth) || columnWidth <= 0) {
    return 0;
  }
  return Math.round(deltaX / columnWidth);
}

export function moveSubTask(
  subTask: SubTask,
  dayOffset: number,
): DateRangeUpdate {
  return {
    startDate: addDays(subTask.startDate, dayOffset),
    endDate: subTask.endDate ? addDays(subTask.endDate, dayOffset) : null,
  };
}

export function resizeSubTaskStart(
  subTask: SubTask,
  requestedOffset: number,
): DateRangeUpdate {
  const effectiveEnd = subTask.endDate ?? subTask.startDate;
  const maximumOffset = diffDays(subTask.startDate, effectiveEnd);
  const dayOffset = Math.min(requestedOffset, maximumOffset);
  const startDate = addDays(subTask.startDate, dayOffset);

  return {
    startDate,
    endDate:
      startDate === effectiveEnd && subTask.endDate === null ? null : effectiveEnd,
  };
}

export function resizeSubTaskEnd(
  subTask: SubTask,
  requestedOffset: number,
): DateRangeUpdate {
  const effectiveEnd = subTask.endDate ?? subTask.startDate;
  const minimumOffset = -diffDays(subTask.startDate, effectiveEnd);
  const dayOffset = Math.max(requestedOffset, minimumOffset);
  const endDate = addDays(effectiveEnd, dayOffset);

  return {
    startDate: subTask.startDate,
    endDate: endDate === subTask.startDate ? null : endDate,
  };
}
