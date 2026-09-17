import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  assertDateOnly,
  daysInMonth,
  diffDays,
  inclusiveDuration,
  startOfWeek,
} from "./dateOnly";

describe("date-only utilities", () => {
  it("validates real calendar dates", () => {
    expect(assertDateOnly("2028-02-29")).toBe("2028-02-29");
    expect(() => assertDateOnly("2027-02-29")).toThrow("并不存在");
    expect(() => assertDateOnly("09/17/2026")).toThrow("YYYY-MM-DD");
  });

  it("derives calendar periods from date-only values", () => {
    expect(startOfWeek("2026-09-17")).toBe("2026-09-14");
    expect(startOfWeek("2026-09-20")).toBe("2026-09-14");
    expect(addMonths("2026-12-18", 1)).toBe("2027-01-01");
    expect(daysInMonth("2028-02-10")).toBe(29);
  });

  it("adds whole days without local timezone arithmetic", () => {
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("uses inclusive duration and treats a missing end as one day", () => {
    expect(inclusiveDuration("2026-09-17", null)).toBe(1);
    expect(inclusiveDuration("2026-09-17", "2026-09-19")).toBe(3);
    expect(diffDays("2026-09-17", "2026-09-19")).toBe(2);
    expect(() => inclusiveDuration("2026-09-17", "2026-09-16")).toThrow(
      "结束日期不能早于开始日期",
    );
  });
});
