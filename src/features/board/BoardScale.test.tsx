import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BoardSnapshot, MotherTask } from "../../domain/models";
import { MemoryStorageGateway } from "../../storage/memoryGateway";
import { App } from "../../App";

function createLargeBoard(): BoardSnapshot {
  const tasks: MotherTask[] = Array.from({ length: 50 }, (_, motherIndex) => ({
    id: `mother_${motherIndex}`,
    name: `规模母任务 ${motherIndex + 1}`,
    expanded: true,
    sortOrder: motherIndex,
    dependsOn: motherIndex > 0 ? [`mother_${motherIndex - 1}`] : [],
    subTasks: Array.from({ length: 10 }, (_, subIndex) => ({
      id: `sub_${motherIndex}_${subIndex}`,
      motherTaskId: `mother_${motherIndex}`,
      name: `规模子任务 ${motherIndex + 1}-${subIndex + 1}`,
      startDate: `2026-09-${String(14 + (subIndex % 10)).padStart(2, "0")}`,
      endDate: null,
      sortOrder: subIndex,
    })),
  }));
  return {
    tasks,
    viewSettings: {
      viewMode: "biweek",
      anchorDate: "2026-09-17",
      showDependencies: true,
      taskColumnWidth: 348,
    },
  };
}

describe("large planning board", () => {
  it("renders 50 mother tasks and 500 child tasks in the shared row model", async () => {
    const gateway = new MemoryStorageGateway(createLargeBoard());
    const { container } = render(<App gateway={gateway} />);

    expect(await screen.findAllByText("规模母任务 50")).not.toHaveLength(0);
    expect(container.querySelectorAll(".task-row--mother")).toHaveLength(50);
    expect(container.querySelectorAll(".task-row--subtask")).toHaveLength(500);
    expect(container.querySelectorAll(".timeline-bar--subtask")).toHaveLength(500);
  });
});
