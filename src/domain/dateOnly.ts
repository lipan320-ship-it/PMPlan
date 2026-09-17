import { DomainError, type DateOnly } from "./models";

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const millisecondsPerDay = 86_400_000;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseParts(value: DateOnly): DateParts {
  const match = datePattern.exec(value);
  if (!match) {
    throw new DomainError(
      "invalid_date",
      `无效日期“${value}”，应使用 YYYY-MM-DD 格式。`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new DomainError("invalid_date", `日期“${value}”并不存在。`);
  }

  return { year, month, day };
}

function toEpochDay(value: DateOnly): number {
  const { year, month, day } = parseParts(value);
  return Math.floor(Date.UTC(year, month - 1, day) / millisecondsPerDay);
}

function formatUtcDate(date: Date): DateOnly {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function assertDateOnly(value: DateOnly): DateOnly {
  parseParts(value);
  return value;
}

export function compareDateOnly(left: DateOnly, right: DateOnly): number {
  return toEpochDay(left) - toEpochDay(right);
}

export function addDays(value: DateOnly, days: number): DateOnly {
  if (!Number.isInteger(days)) {
    throw new DomainError("invalid_day_offset", "日期偏移量必须是整数天。");
  }
  return formatUtcDate(new Date((toEpochDay(value) + days) * millisecondsPerDay));
}

export function diffDays(start: DateOnly, end: DateOnly): number {
  return toEpochDay(end) - toEpochDay(start);
}

export function inclusiveDuration(start: DateOnly, end: DateOnly | null): number {
  const effectiveEnd = end ?? start;
  const difference = diffDays(start, effectiveEnd);
  if (difference < 0) {
    throw new DomainError("invalid_date_range", "结束日期不能早于开始日期。");
  }
  return difference + 1;
}

export function validateDateRange(
  start: DateOnly,
  end: DateOnly | null,
): void {
  inclusiveDuration(start, end);
}

export function todayDateOnly(now = new Date()): DateOnly {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
