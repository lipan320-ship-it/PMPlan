import { describe, expect, it } from "vitest";
import type { MotherTask, SubTask } from "./models";
import { evaluateDependencyConflicts, getMotherSpan } from "./schedule";

function subTask(
  id: string,
  motherTaskId: string,
  startDate: string,
  endDate: string | null,
): SubTask {
  return { id, motherTaskId, name: id, startDate, endDate, sortOrder: 0 };
}

function motherTask(
  id: string,
  dependsOn: string[],
  subTasks: SubTask[],
): MotherTask {
  return { id, name: id, expanded: true, sortOrder: 0, dependsOn, subTasks };
}

describe("schedule derivation", () => {
  it("derives a mother span and normalizes a one-day task", () => {
    const task = motherTask("A", [], [
      subTask("A1", "A", "2026-09-18", null),
      subTask("A2", "A", "2026-09-15", "2026-09-20"),
    ]);

    expect(getMotherSpan(task)).toEqual({
      startDate: "2026-09-15",
      endDate: "2026-09-20",
    });
  });

  it("treats equal predecessor end and successor start as a conflict", () => {
    const predecessor = motherTask("A", [], [
      subTask("A1", "A", "2026-09-17", "2026-09-20"),
    ]);
    const successor = motherTask("B", ["A"], [
      subTask("B1", "B", "2026-09-20", "2026-09-22"),
    ]);

    expect(evaluateDependencyConflicts([predecessor, successor])).toHaveLength(1);
    successor.subTasks[0].startDate = "2026-09-21";
    expect(evaluateDependencyConflicts([predecessor, successor])).toEqual([]);
  });
});
