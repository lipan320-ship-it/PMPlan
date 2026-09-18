import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "../../domain/models";
import { MemoryStorageGateway } from "../../storage/memoryGateway";
import { App } from "../../App";

/** jsdom 没有 ResizeObserver，视口宽度为 0，双周档位使用基准列宽。 */
const BIWEEK_COLUMN_WIDTH = 74;

function createBoard(anchorDate: string): BoardSnapshot {
  return {
    tasks: [],
    viewSettings: {
      viewMode: "biweek",
      anchorDate,
      showDependencies: false,
      taskColumnWidth: 348,
    },
  };
}

async function createGateway(anchorDate: string): Promise<MemoryStorageGateway> {
  const gateway = new MemoryStorageGateway(createBoard(anchorDate));
  await gateway.createMotherTask({ name: "连续平移母任务" });
  return gateway;
}

describe("timeline panning", () => {
  it("keeps a month boundary inside one continuous window", async () => {
    const { container } = render(<App gateway={await createGateway("2026-10-25")} />);

    await screen.findByText("10/31");
    expect(screen.getByText("11/1")).toBeInTheDocument();
    expect(screen.getByText("2026 年 10 月")).toBeInTheDocument();
    expect(screen.getByText("2026 年 11 月")).toBeInTheDocument();
    expect(container.querySelectorAll(".date-month")).toHaveLength(2);
  });

  it("pans across the month boundary and persists silently", async () => {
    const gateway = await createGateway("2026-10-25");
    const { container } = render(<App gateway={gateway} />);

    await screen.findByText("10/31");
    const column = container.querySelector(".timeline-column") as HTMLElement;
    fireEvent.pointerDown(column, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(column, {
      clientX: 600 - BIWEEK_COLUMN_WIDTH * 3,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(screen.getByText("10/28")).toBeInTheDocument();
    });
    expect(screen.getByText("11/1")).toBeInTheDocument();
    expect(column.className).toContain("is-panning");

    fireEvent.pointerUp(column, {
      clientX: 600 - BIWEEK_COLUMN_WIDTH * 3,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(column.className).not.toContain("is-panning");
    });
    const snapshot = await gateway.loadBoard();
    expect(snapshot.viewSettings.anchorDate).toBe("2026-10-28");
    expect(screen.queryByText("视图设置已保存")).toBeNull();
  });

  it("does not pan when the gesture starts on a task bar", async () => {
    const gateway = await createGateway("2026-10-25");
    const mother = (await gateway.loadBoard()).tasks[0];
    await gateway.createSubTask({
      motherTaskId: mother.id,
      name: "平移子任务",
      startDate: "2026-10-26",
      endDate: "2026-10-30",
    });
    const { container } = render(<App gateway={gateway} />);

    await screen.findAllByText("平移子任务");
    const bar = container.querySelector(
      ".timeline-bar--subtask",
    ) as HTMLElement;

    fireEvent.pointerDown(bar, { button: 0, clientX: 500, pointerId: 2 });
    fireEvent.pointerMove(bar, {
      clientX: 500 - BIWEEK_COLUMN_WIDTH * 3,
      pointerId: 2,
    });
    fireEvent.pointerUp(bar, {
      clientX: 500 - BIWEEK_COLUMN_WIDTH * 3,
      pointerId: 2,
    });

    // 任务条自身的拖期提交是异步的，先刷新掉再断言，避免测试结束后仍有状态更新。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText("10/25")).toBeInTheDocument();
    const snapshot = await gateway.loadBoard();
    expect(snapshot.viewSettings.anchorDate).toBe("2026-10-25");
  });

  it("pages by half of the window and persists silently", async () => {
    const gateway = await createGateway("2026-10-25");
    render(<App gateway={gateway} />);

    await screen.findByText("10/31");
    fireEvent.click(screen.getByRole("button", { name: "下一周期" }));

    await waitFor(() => {
      expect(screen.queryByText("10/31")).toBeNull();
    });
    const snapshot = await gateway.loadBoard();
    expect(snapshot.viewSettings.anchorDate).toBe("2026-11-01");
    expect(screen.queryByText("视图设置已保存")).toBeNull();
  });
});
