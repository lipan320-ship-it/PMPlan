import { describe, expect, it } from "vitest";
import {
  getAnchorForFocusDate,
  getDayColumnWidth,
  getPanStepDays,
  getViewRange,
  getVisibleDayCount,
  shiftAnchor,
} from "./viewRange";

describe("view range", () => {
  it("builds a continuous range from an arbitrary start date", () => {
    const range = getViewRange("2026-09-17", 7);

    expect(range.startDate).toBe("2026-09-17");
    expect(range.endDate).toBe("2026-09-23");
    expect(range.dates).toEqual([
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
    ]);
  });

  it("keeps month boundaries inside a single continuous range", () => {
    const range = getViewRange("2026-10-25", 14);

    expect(range.dates).toContain("2026-10-31");
    expect(range.dates).toContain("2026-11-01");
    expect(range.dates.indexOf("2026-11-01")).toBe(
      range.dates.indexOf("2026-10-31") + 1,
    );
  });

  it("clamps the day count instead of deriving it from the view mode", () => {
    expect(getViewRange("2026-09-17", 3).dates).toHaveLength(7);
    expect(getViewRange("2026-09-17", 200).dates).toHaveLength(92);
  });

  it("derives the visible day count from the available width", () => {
    expect(getVisibleDayCount(0, "week")).toBe(7);
    expect(getVisibleDayCount(0, "biweek")).toBe(14);
    expect(getVisibleDayCount(0, "month")).toBe(30);
    expect(getVisibleDayCount(728, "week")).toBe(7);
    expect(getVisibleDayCount(1440, "month")).toBe(30);
    expect(getVisibleDayCount(20000, "month")).toBe(92);
  });

  it("shifts the anchor by whole days in both directions", () => {
    expect(shiftAnchor("2026-10-25", 1)).toBe("2026-10-26");
    expect(shiftAnchor("2026-10-25", -10)).toBe("2026-10-15");
    expect(shiftAnchor("2026-10-25", 0)).toBe("2026-10-25");
  });

  it("pages by about half of the window so consecutive windows overlap", () => {
    expect(getPanStepDays(14)).toBe(7);
    expect(getPanStepDays(30)).toBe(15);
    expect(getPanStepDays(7)).toBe(4);
  });

  it("puts the focus date near the first quarter of the window", () => {
    const anchor = getAnchorForFocusDate("2026-10-15", 14);
    expect(anchor).toBe("2026-10-12");

    const range = getViewRange(anchor, 14);
    expect(range.dates).toContain("2026-10-15");
    expect(range.dates.indexOf("2026-10-15")).toBe(3);
  });

  it("keeps the density presets as base column widths", () => {
    expect(getDayColumnWidth("week")).toBe(104);
    expect(getDayColumnWidth("biweek")).toBe(74);
    expect(getDayColumnWidth("month")).toBe(48);
  });
});
