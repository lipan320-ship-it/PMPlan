import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "../domain/models";
import { MemoryStorageGateway } from "./memoryGateway";

const emptyBoard: BoardSnapshot = {
  tasks: [],
  viewSettings: {
    viewMode: "biweek",
    anchorDate: "2026-09-17",
    showDependencies: true,
  },
};

describe("MemoryStorageGateway", () => {
  it("supports the same basic CRUD contract as the desktop gateway", async () => {
    const gateway = new MemoryStorageGateway(emptyBoard);
    const mother = await gateway.createMotherTask({ name: "  Launch  " });
    const child = await gateway.createSubTask({
      motherTaskId: mother.id,
      name: "Prototype",
      startDate: "2026-09-17",
      endDate: null,
    });
    await gateway.setMotherExpanded({ id: mother.id, expanded: false });

    await gateway.updateSubTask({
      id: child.id,
      name: "Prototype review",
      startDate: "2026-09-18",
      endDate: "2026-09-19",
    });

    const board = await gateway.loadBoard();
    expect(board.tasks[0].name).toBe("Launch");
    expect(board.tasks[0].expanded).toBe(false);
    expect(board.tasks[0].subTasks[0]).toMatchObject({
      name: "Prototype review",
      startDate: "2026-09-18",
      endDate: "2026-09-19",
    });

    await gateway.deleteMotherTask(mother.id);
    expect((await gateway.loadBoard()).tasks).toEqual([]);
  });
});
