import { describe, expect, it } from "vitest";
import type { MotherTask } from "./models";
import { validateDependencyChange } from "./dependencies";

function task(id: string, dependsOn: string[] = []): MotherTask {
  return {
    id,
    name: id,
    expanded: true,
    sortOrder: 0,
    dependsOn,
    subTasks: [],
  };
}

describe("dependency validation", () => {
  it("allows multiple non-cyclic predecessors", () => {
    const tasks = [task("A"), task("B"), task("C")];
    expect(() => validateDependencyChange(tasks, "C", ["A", "B"]))
      .not.toThrow();
  });

  it("rejects self, duplicate, missing and cyclic dependencies", () => {
    const tasks = [task("A"), task("B", ["A"]), task("C", ["B"])];
    expect(() => validateDependencyChange(tasks, "A", ["A"])).toThrow(
      "不能依赖自身",
    );
    expect(() => validateDependencyChange(tasks, "C", ["B", "B"])).toThrow(
      "不能重复",
    );
    expect(() => validateDependencyChange(tasks, "C", ["missing"])).toThrow(
      "无效",
    );
    expect(() => validateDependencyChange(tasks, "A", ["C"])).toThrow(
      "循环依赖",
    );
  });
});
