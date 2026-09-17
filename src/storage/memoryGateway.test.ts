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

  it("previews, applies and exports JSON without partial invalid writes", async () => {
    const gateway = new MemoryStorageGateway(emptyBoard);
    const valid = JSON.stringify({
      version: "1.0",
      tasks: [
        {
          id: "T-001",
          name: "Imported",
          dependsOn: [],
          subTasks: [
            {
              id: "S-001",
              name: "Imported child",
              startDate: "2026-09-17",
            },
          ],
        },
      ],
    });
    const preview = await gateway.analyzeImport(
      { kind: "content", value: valid, fileName: "valid.json" },
      "overwrite",
    );
    expect(preview).toMatchObject({
      valid: true,
      motherTaskCount: 1,
      subTaskCount: 1,
    });
    await gateway.applyImport(
      { kind: "content", value: valid, fileName: "valid.json" },
      "overwrite",
    );
    expect((await gateway.loadBoard()).tasks[0].name).toBe("Imported");

    const invalid = JSON.stringify({ version: "2.0", tasks: [] });
    await expect(
      gateway.applyImport(
        { kind: "content", value: invalid, fileName: "invalid.json" },
        "overwrite",
      ),
    ).rejects.toThrow();
    expect((await gateway.loadBoard()).tasks[0].name).toBe("Imported");

    const exported = await gateway.exportJson();
    expect(exported.content).toContain('"version": "1.0"');
    expect(exported.result.subTaskCount).toBe(1);
  });
});
