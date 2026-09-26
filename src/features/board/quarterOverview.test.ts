import { describe, expect, it } from "vitest";
import { addDays, dayOfWeek, diffDays } from "../../domain/dateOnly";
import {
  QUARTER_MAX_DAYS,
  QUARTER_MIN_BAR_WIDTH,
  QUARTER_MIN_DAYS,
  buildQuarterMonthBands,
  buildQuarterWeekTicks,
  getQuarterBarGeometry,
  getQuarterDateAtOffset,
  getQuarterOverviewRange,
} from "./quarterOverview";

describe("quarter overview primitives", () => {
  it("keeps arbitrary anchors and produces natural 90, 91, and 92 day windows", () => {
    const ninety = getQuarterOverviewRange("2028-02-29");
    const ninetyOne = getQuarterOverviewRange("2026-09-17");
    const ninetyTwo = getQuarterOverviewRange("2026-11-09");

    expect(ninety.startDate).toBe("2028-02-29");
    expect(ninety.dates).toHaveLength(90);
    expect(ninety.endDate).toBe("2028-05-28");
    expect(ninetyOne.dates).toHaveLength(91);
    expect(ninetyOne.endDate).toBe("2026-12-16");
    expect(ninetyTwo.dates).toHaveLength(92);
    expect(ninetyTwo.endDate).toBe("2027-02-08");
  });

  it("clamps a short month-end anniversary to the minimum window", () => {
    const range = getQuarterOverviewRange("2026-01-31");

    expect(range.dates.length).toBe(QUARTER_MIN_DAYS);
    expect(range.endDate).toBe("2026-04-30");
    expect(range.dates).toHaveLength(90);
  });

  it("keeps the range contract bounded by the quarter constants", () => {
    const range = getQuarterOverviewRange("2026-05-01");

    expect(range.dates.length).toBeGreaterThanOrEqual(QUARTER_MIN_DAYS);
    expect(range.dates.length).toBeLessThanOrEqual(QUARTER_MAX_DAYS);
  });

  it("splits cross-year months by their actual day proportions", () => {
    const bands = buildQuarterMonthBands(
      getQuarterOverviewRange("2026-11-09"),
    );

    expect(bands).toEqual([
      { key: "2026-11", label: "2026 年 11 月", startOffset: 0, dayCount: 22 },
      { key: "2026-12", label: "2026 年 12 月", startOffset: 22, dayCount: 31 },
      { key: "2027-01", label: "2027 年 1 月", startOffset: 53, dayCount: 31 },
      { key: "2027-02", label: "2027 年 2 月", startOffset: 84, dayCount: 8 },
    ]);
  });

  it("emits Monday ticks inside an arbitrary window", () => {
    const range = getQuarterOverviewRange("2026-11-11");
    const ticks = buildQuarterWeekTicks(range);

    expect(ticks[0]).toEqual({ date: "2026-11-16", dayOffset: 5 });
    expect(ticks.every((tick) => dayOfWeek(tick.date) === 1)).toBe(true);
    expect(ticks.every((tick) => tick.dayOffset >= 0)).toBe(true);
    expect(ticks.every((tick) => tick.dayOffset < range.dates.length)).toBe(true);
  });

  it("maps task dates proportionally and clips at the range edges", () => {
    const range = getQuarterOverviewRange("2026-11-09");

    expect(getQuarterBarGeometry("2026-11-14", "2026-11-16", range, 2)).toEqual({
      left: 10,
      width: 6,
    });
    expect(getQuarterBarGeometry("2026-11-01", "2026-11-12", range, 2)).toEqual({
      left: 0,
      width: 8,
    });
    expect(getQuarterBarGeometry("2026-11-16", "2026-11-14", range, 2)).toBeNull();
    expect(getQuarterBarGeometry("2027-03-01", "2027-03-02", range, 2)).toBeNull();
  });

  it("keeps a single-day marker visible at compressed scales", () => {
    const range = getQuarterOverviewRange("2026-11-09");
    const geometry = getQuarterBarGeometry("2026-11-20", "2026-11-20", range, 1);

    expect(geometry).not.toBeNull();
    expect(geometry!.width).toBe(QUARTER_MIN_BAR_WIDTH);
    expect(geometry!.left).toBeGreaterThanOrEqual(0);
    expect(geometry!.left + geometry!.width).toBeLessThanOrEqual(
      range.dates.length,
    );
  });

  it("clamps x-to-date conversion to the first and last date", () => {
    const range = getQuarterOverviewRange("2026-11-09");
    const pixelsPerDay = 2;
    const totalWidth = range.dates.length * pixelsPerDay;

    expect(getQuarterDateAtOffset(-10, range, pixelsPerDay)).toBe("2026-11-09");
    expect(getQuarterDateAtOffset(0, range, pixelsPerDay)).toBe("2026-11-09");
    expect(getQuarterDateAtOffset(2, range, pixelsPerDay)).toBe("2026-11-10");
    expect(getQuarterDateAtOffset(totalWidth + 10, range, pixelsPerDay)).toBe(
      range.endDate,
    );
  });

  it("uses date-only arithmetic across a leap boundary", () => {
    const range = getQuarterOverviewRange("2027-12-01");

    expect(diffDays(range.startDate, range.endDate) + 1).toBe(range.dates.length);
    expect(range.dates).toContain("2028-02-29");
    expect(addDays(range.startDate, range.dates.length - 1)).toBe(range.endDate);
  });
});
