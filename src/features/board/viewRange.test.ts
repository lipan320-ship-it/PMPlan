import { describe, expect, it } from "vitest";
import { getViewRange, navigateAnchor } from "./viewRange";

describe("view range", () => {
  it("builds week and biweek ranges from Monday", () => {
    expect(getViewRange("week", "2026-09-17")).toMatchObject({
      startDate: "2026-09-14",
      endDate: "2026-09-20",
    });
    expect(getViewRange("biweek", "2026-09-17").dates).toHaveLength(14);
  });

  it("builds natural months and navigates by view period", () => {
    expect(getViewRange("month", "2028-02-17")).toMatchObject({
      startDate: "2028-02-01",
      endDate: "2028-02-29",
    });
    expect(navigateAnchor("week", "2026-09-17", 1)).toBe("2026-09-24");
    expect(navigateAnchor("month", "2026-12-17", 1)).toBe("2027-01-01");
  });
});
