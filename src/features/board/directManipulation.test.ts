import { describe, expect, it } from "vitest";
import type { SubTask } from "../../domain/models";
import {
  moveSubTask,
  pixelsToDayOffset,
  resizeSubTaskEnd,
  resizeSubTaskStart,
} from "./directManipulation";

const task: SubTask = {
  id: "sub_1",
  motherTaskId: "mother_1",
  name: "Task",
  startDate: "2026-09-17",
  endDate: "2026-09-19",
  sortOrder: 0,
};

describe("direct timeline manipulation", () => {
  it("snaps pointer movement to whole days", () => {
    expect(pixelsToDayOffset(34, 60)).toBe(1);
    expect(pixelsToDayOffset(29, 60)).toBe(0);
    expect(pixelsToDayOffset(-35, 60)).toBe(-1);
  });

  it("moves both dates while preserving duration and null end semantics", () => {
    expect(moveSubTask(task, 2)).toEqual({
      startDate: "2026-09-19",
      endDate: "2026-09-21",
    });
    expect(moveSubTask({ ...task, endDate: null }, -1)).toEqual({
      startDate: "2026-09-16",
      endDate: null,
    });
  });

  it("resizes each edge without crossing the opposite edge", () => {
    expect(resizeSubTaskStart(task, -2)).toEqual({
      startDate: "2026-09-15",
      endDate: "2026-09-19",
    });
    expect(resizeSubTaskStart(task, 99).startDate).toBe("2026-09-19");
    expect(resizeSubTaskEnd(task, 2)).toEqual({
      startDate: "2026-09-17",
      endDate: "2026-09-21",
    });
    expect(resizeSubTaskEnd(task, -99)).toEqual({
      startDate: "2026-09-17",
      endDate: null,
    });
  });
});
