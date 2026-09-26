import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "../../domain/models";
import { getQuarterOverviewRange } from "./quarterOverview";
import { App } from "../../App";
import { MemoryStorageGateway } from "../../storage/memoryGateway";

const ANCHOR_DATE = "2026-11-09";
const MOTHER_ID = "mother-quarter-overview";
const SUBTASK_ID = "sub-quarter-overview";

function getQuarterEdge(bar: HTMLElement, edge: "start" | "end"): HTMLElement {
  const handle = bar.querySelector(`[data-edge="${edge}"]`);
  if (!(handle instanceof HTMLElement)) {
    throw new Error(`quarter ${edge} resize handle missing`);
  }
  return handle;
}

function createQuarterBoard(): BoardSnapshot {
  return {
    tasks: [
      {
        id: MOTHER_ID,
        name: "季度规划",
        expanded: true,
        sortOrder: 0,
        dependsOn: [],
        subTasks: [
          {
            id: SUBTASK_ID,
            motherTaskId: MOTHER_ID,
            name: "跨月交付",
            startDate: "2026-11-30",
            endDate: "2026-12-02",
            sortOrder: 0,
          },
        ],
      },
    ],
    viewSettings: {
      // Quarter overview is intentionally transient UI state.  It must not
      // expand the persisted view-mode contract or alter the anchor date.
      viewMode: "biweek",
      anchorDate: ANCHOR_DATE,
      showDependencies: false,
      taskColumnWidth: 348,
    },
  };
}

describe("quarter overview integration", () => {
  it("shows a rolling quarter and keeps existing task editing/date data", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createQuarterBoard());
    render(<App gateway={gateway} />);

    await screen.findByText("季度规划");
    const toggle = screen.getByRole("button", { name: "季度总览" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const range = getQuarterOverviewRange(ANCHOR_DATE);
    expect(range.dates.length).toBeGreaterThanOrEqual(90);
    expect(range.dates.length).toBeLessThanOrEqual(92);
    expect(
      screen.getByText(
        `${range.startDate.replaceAll("-", "/")} – ${range.endDate.replaceAll("-", "/")}`,
      ),
    ).toBeInTheDocument();

    const header = screen.getByTestId("quarter-timeline-header");
    expect(document.querySelectorAll(".date-cell")).toHaveLength(0);
    const monthBands = screen.getAllByTestId("quarter-month-band");
    expect(monthBands.map((band) => band.textContent)).toEqual([
      "2026 年 11 月",
      "2026 年 12 月",
      "2027 年 1 月",
      "2027 年 2 月",
    ]);
    expect(header.querySelectorAll("[data-testid='quarter-week-tick']")).toHaveLength(14);
    expect(screen.getAllByTestId("quarter-week-tick")[0]).toHaveAttribute(
      "title",
      "11/9 周一",
    );

    const bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    expect(bar).toHaveAttribute(
      "title",
      "跨月交付：2026-11-30 至 2026-12-02；拖动主体或边缘调整日期，点击编辑日期",
    );

    await user.click(bar);
    expect(
      await screen.findByRole("heading", { name: "编辑子任务" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("开始日期")).toHaveValue("2026-11-30");
    expect(screen.getByLabelText("结束日期（可不填）")).toHaveValue("2026-12-02");

    const persisted = await gateway.loadBoard();
    expect(persisted.viewSettings).toMatchObject({
      viewMode: "biweek",
      anchorDate: ANCHOR_DATE,
    });
    expect(persisted.tasks[0]?.subTasks[0]).toMatchObject({
      startDate: "2026-11-30",
      endDate: "2026-12-02",
    });

    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "月" }));
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "月" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByTestId("quarter-timeline-header")).toBeNull();
    expect((await gateway.loadBoard()).viewSettings).toMatchObject({
      viewMode: "month",
      anchorDate: ANCHOR_DATE,
    });
  });

  it("pages the rolling window by half its active length and persists only the anchor", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createQuarterBoard());
    render(<App gateway={gateway} />);

    await screen.findByText("季度规划");
    await user.click(screen.getByRole("button", { name: "季度总览" }));
    await user.click(screen.getByRole("button", { name: "下一周期" }));

    await waitFor(async () => {
      expect((await gateway.loadBoard()).viewSettings.anchorDate).toBe("2026-12-25");
    });
    expect(screen.getByText("2026/12/25 – 2027/03/24")).toBeInTheDocument();
    expect((await gateway.loadBoard()).viewSettings.viewMode).toBe("biweek");

    const column = document.querySelector(".timeline-column");
    if (!(column instanceof HTMLElement)) {
      throw new Error("timeline column missing");
    }
    fireEvent.pointerDown(column, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(column, { clientX: 600 - 12 * 3, pointerId: 1 });
    fireEvent.pointerUp(column, { clientX: 600 - 12 * 3, pointerId: 1 });
    await waitFor(async () => {
      expect((await gateway.loadBoard()).viewSettings.anchorDate).toBe("2026-12-28");
    });
  });

  it("shifts the whole subtask by snapped quarter days while preserving duration", async () => {
    const gateway = new MemoryStorageGateway(createQuarterBoard());
    render(<App gateway={gateway} />);

    await screen.findByText("季度规划");
    await userEvent.setup().click(screen.getByRole("button", { name: "季度总览" }));

    const bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    fireEvent.pointerDown(bar, { button: 0, clientX: 400, pointerId: 7 });
    fireEvent.pointerMove(bar, { clientX: 424, pointerId: 7 });

    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-12-02 → 2026-12-04",
    );

    fireEvent.pointerMove(bar, { clientX: 436, pointerId: 7 });
    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-12-03 → 2026-12-05",
    );

    fireEvent.pointerUp(bar, { clientX: 436, pointerId: 7 });

    expect(screen.queryByTestId("quarter-drag-preview")).toBeNull();

    await waitFor(async () => {
      expect((await gateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
        startDate: "2026-12-03",
        endDate: "2026-12-05",
      });
    });
  });

  it("keeps a sub-threshold gesture as a click and provides a wider single-day hit target", async () => {
    const snapshot = createQuarterBoard();
    const subTask = snapshot.tasks[0]?.subTasks[0];
    if (!subTask) {
      throw new Error("quarter subtask missing");
    }
    subTask.endDate = null;
    const gateway = new MemoryStorageGateway(snapshot);
    render(<App gateway={gateway} />);

    await screen.findByText("季度规划");
    await userEvent.setup().click(screen.getByRole("button", { name: "季度总览" }));

    const bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    expect(Number.parseFloat(bar.style.width)).toBeGreaterThanOrEqual(24);

    fireEvent.pointerDown(bar, { button: 0, clientX: 400, pointerId: 8 });
    fireEvent.pointerMove(bar, { clientX: 403, pointerId: 8 });
    fireEvent.pointerUp(bar, { clientX: 403, pointerId: 8 });
    fireEvent.click(bar);

    expect(await screen.findByRole("heading", { name: "编辑子任务" })).toBeInTheDocument();
    expect((await gateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
      startDate: "2026-11-30",
      endDate: null,
    });
  });

  it("resizes the quarter task start and end edges with live date previews", async () => {
    const gateway = new MemoryStorageGateway(createQuarterBoard());
    render(<App gateway={gateway} />);

    await screen.findByText("季度规划");
    await userEvent.setup().click(screen.getByRole("button", { name: "季度总览" }));

    let bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    const startEdge = getQuarterEdge(bar, "start");
    fireEvent.pointerDown(startEdge, { button: 0, clientX: 400, pointerId: 9 });
    fireEvent.pointerMove(bar, { clientX: 388, pointerId: 9 });
    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-11-29 → 2026-12-02",
    );
    fireEvent.pointerUp(bar, { clientX: 388, pointerId: 9 });

    await waitFor(async () => {
      expect((await gateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
        startDate: "2026-11-29",
        endDate: "2026-12-02",
      });
    });

    bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    const endEdge = getQuarterEdge(bar, "end");
    fireEvent.pointerDown(endEdge, { button: 0, clientX: 400, pointerId: 10 });
    fireEvent.pointerMove(bar, { clientX: 412, pointerId: 10 });
    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-11-29 → 2026-12-03",
    );
    fireEvent.pointerUp(bar, { clientX: 412, pointerId: 10 });

    await waitFor(async () => {
      expect((await gateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
        startDate: "2026-11-29",
        endDate: "2026-12-03",
      });
    });
  });

  it("extends a single-day quarter task from either edge", async () => {
    const leftSnapshot = createQuarterBoard();
    const leftSubTask = leftSnapshot.tasks[0]?.subTasks[0];
    if (!leftSubTask) {
      throw new Error("quarter subtask missing");
    }
    leftSubTask.endDate = null;
    const leftGateway = new MemoryStorageGateway(leftSnapshot);
    const { unmount } = render(<App gateway={leftGateway} />);

    await screen.findByText("季度规划");
    await userEvent.setup().click(screen.getByRole("button", { name: "季度总览" }));

    let bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    const startEdge = getQuarterEdge(bar, "start");
    fireEvent.pointerDown(startEdge, { button: 0, clientX: 400, pointerId: 11 });
    fireEvent.pointerMove(bar, { clientX: 388, pointerId: 11 });
    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-11-29 → 2026-11-30",
    );
    fireEvent.pointerUp(bar, { clientX: 388, pointerId: 11 });

    await waitFor(async () => {
      expect((await leftGateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
        startDate: "2026-11-29",
        endDate: "2026-11-30",
      });
    });
    unmount();

    const rightSnapshot = createQuarterBoard();
    const rightSubTask = rightSnapshot.tasks[0]?.subTasks[0];
    if (!rightSubTask) {
      throw new Error("quarter subtask missing");
    }
    rightSubTask.endDate = null;
    const rightGateway = new MemoryStorageGateway(rightSnapshot);
    render(<App gateway={rightGateway} />);

    await screen.findByText("季度规划");
    await userEvent.setup().click(screen.getByRole("button", { name: "季度总览" }));

    bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    const endEdge = getQuarterEdge(bar, "end");
    fireEvent.pointerDown(endEdge, { button: 0, clientX: 400, pointerId: 12 });
    fireEvent.pointerMove(bar, { clientX: 412, pointerId: 12 });
    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-11-30 → 2026-12-01",
    );
    fireEvent.pointerUp(bar, { clientX: 412, pointerId: 12 });

    await waitFor(async () => {
      expect((await rightGateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
        startDate: "2026-11-30",
        endDate: "2026-12-01",
      });
    });
  });

  it("does not let quarter edge resizing cross the opposite date", async () => {
    const gateway = new MemoryStorageGateway(createQuarterBoard());
    render(<App gateway={gateway} />);

    await screen.findByText("季度规划");
    await userEvent.setup().click(screen.getByRole("button", { name: "季度总览" }));

    let bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    const startEdge = getQuarterEdge(bar, "start");
    fireEvent.pointerDown(startEdge, { button: 0, clientX: 400, pointerId: 13 });
    fireEvent.pointerMove(bar, { clientX: 520, pointerId: 13 });
    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-12-02 → 2026-12-02",
    );
    fireEvent.pointerUp(bar, { clientX: 520, pointerId: 13 });

    await waitFor(async () => {
      expect((await gateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
        startDate: "2026-12-02",
        endDate: "2026-12-02",
      });
    });

    bar = screen.getByTestId(`quarter-subtask-${SUBTASK_ID}`);
    const endEdge = getQuarterEdge(bar, "end");
    fireEvent.pointerDown(endEdge, { button: 0, clientX: 400, pointerId: 14 });
    fireEvent.pointerMove(bar, { clientX: 280, pointerId: 14 });
    expect(screen.getByTestId("quarter-drag-preview")).toHaveTextContent(
      "2026-12-02 → 2026-12-02",
    );
    fireEvent.pointerUp(bar, { clientX: 280, pointerId: 14 });

    await waitFor(async () => {
      expect((await gateway.loadBoard()).tasks[0]?.subTasks[0]).toMatchObject({
        startDate: "2026-12-02",
        endDate: null,
      });
    });
  });
});
