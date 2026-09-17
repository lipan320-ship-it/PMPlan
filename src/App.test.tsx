import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createEmptyBoard } from "./app/createStorageGateway";
import { MemoryStorageGateway } from "./storage/memoryGateway";
import { App } from "./App";

describe("App", () => {
  it("starts empty and creates the first mother task", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createEmptyBoard());
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("heading", { name: "画板还是空的" })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "从空白画板新建母任务" }),
    );
    await user.type(screen.getByLabelText("母任务名称"), "产品发布");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findAllByText("产品发布")).not.toHaveLength(0);
    expect((await gateway.loadBoard()).tasks[0].name).toBe("产品发布");
  });

  it("adds and edits a one-day sub task", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createEmptyBoard());
    const mother = await gateway.createMotherTask({ name: "版本规划" });
    render(<App gateway={gateway} />);

    await screen.findByText("版本规划");
    await user.click(
      screen.getByRole("button", { name: `为“${mother.name}”添加子任务` }),
    );
    await user.type(screen.getByLabelText("子任务名称"), "需求梳理");
    await user.click(screen.getByRole("button", { name: "添加" }));

    expect(await screen.findAllByText("需求梳理")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "编辑子任务“需求梳理”" }));
    const nameInput = screen.getByLabelText("子任务名称");
    await user.clear(nameInput);
    await user.type(nameInput, "需求评审");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findAllByText("需求评审")).not.toHaveLength(0);
    expect((await gateway.loadBoard()).tasks[0].subTasks[0].endDate).toBeNull();
  });

  it("switches view and filters tasks by child name", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createEmptyBoard());
    const motherA = await gateway.createMotherTask({ name: "产品发布" });
    const motherB = await gateway.createMotherTask({ name: "数据分析" });
    await gateway.createSubTask({
      motherTaskId: motherA.id,
      name: "灰度测试",
      startDate: "2026-09-17",
      endDate: null,
    });
    await gateway.createSubTask({
      motherTaskId: motherB.id,
      name: "指标定义",
      startDate: "2026-09-17",
      endDate: null,
    });
    render(<App gateway={gateway} />);

    await screen.findByText("产品发布");
    await user.click(screen.getByRole("button", { name: "月" }));
    expect(screen.getByRole("button", { name: "月" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.type(screen.getByPlaceholderText("搜索任务"), "灰度");
    expect(screen.getByText("产品发布")).toBeInTheDocument();
    expect(screen.queryByText("数据分析")).not.toBeInTheDocument();
  });

  it("requires confirmation before deleting a mother task", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createEmptyBoard());
    await gateway.createMotherTask({ name: "待删除计划" });
    render(<App gateway={gateway} />);

    await screen.findByText("待删除计划");
    await user.click(
      screen.getByRole("button", { name: "删除母任务“待删除计划”" }),
    );
    expect(screen.getByRole("heading", { name: "删除母任务" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect((await gateway.loadBoard()).tasks).toHaveLength(1);

    await user.click(
      screen.getByRole("button", { name: "删除母任务“待删除计划”" }),
    );
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(await screen.findByRole("heading", { name: "画板还是空的" })).toBeInTheDocument();
    expect((await gateway.loadBoard()).tasks).toEqual([]);
  });

  it("prefills the clicked date when double-clicking a mother timeline", async () => {
    const gateway = new MemoryStorageGateway({
      ...createEmptyBoard(),
      viewSettings: {
        viewMode: "biweek",
        anchorDate: "2026-09-17",
        showDependencies: true,
      },
    });
    const mother = await gateway.createMotherTask({ name: "快速规划" });
    render(<App gateway={gateway} />);

    await screen.findByText("快速规划");
    fireEvent.doubleClick(screen.getByTestId(`mother-timeline-${mother.id}`), {
      clientX: 1,
    });

    expect(screen.getByRole("heading", { name: "添加子任务" })).toBeInTheDocument();
    expect(screen.getByLabelText("开始日期")).toHaveValue("2026-09-14");
  });

  it("sets multiple-task dependencies and shows conflict feedback", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway({
      ...createEmptyBoard(),
      viewSettings: {
        viewMode: "biweek",
        anchorDate: "2026-09-17",
        showDependencies: true,
      },
    });
    const predecessor = await gateway.createMotherTask({ name: "前置任务" });
    const successor = await gateway.createMotherTask({ name: "后置任务" });
    await gateway.createSubTask({
      motherTaskId: predecessor.id,
      name: "前置工作",
      startDate: "2026-09-17",
      endDate: "2026-09-20",
    });
    await gateway.createSubTask({
      motherTaskId: successor.id,
      name: "后置工作",
      startDate: "2026-09-20",
      endDate: "2026-09-22",
    });
    const { container } = render(<App gateway={gateway} />);

    await screen.findByText("后置任务");
    await user.click(
      screen.getByRole("button", { name: "设置“后置任务”的依赖" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /前置任务/ }));
    await user.click(screen.getByRole("button", { name: "保存依赖" }));

    expect(await screen.findByRole("button", { name: "依赖 1" })).toBeInTheDocument();
    expect(screen.getByTitle("当前排期与前置需求存在冲突")).toBeInTheDocument();
    expect(container.querySelector(".dependency-path.is-conflict")).not.toBeNull();
    expect((await gateway.loadBoard()).tasks[1].dependsOn).toEqual([
      predecessor.id,
    ]);

    await user.click(screen.getByRole("checkbox", { name: "显示依赖" }));
    await waitFor(() => {
      expect(container.querySelector(".dependency-path")).toBeNull();
    });
    expect((await gateway.loadBoard()).viewSettings.showDependencies).toBe(false);
  });

  it("previews and confirms a transactional overwrite import", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createEmptyBoard());
    await gateway.createMotherTask({ name: "Current data" });
    const { container } = render(<App gateway={gateway} />);
    const content = JSON.stringify({
      version: "1.0",
      tasks: [
        {
          id: "T-001",
          name: "Imported plan",
          expanded: true,
          dependsOn: [],
          subTasks: [
            {
              id: "S-001",
              name: "Imported work",
              startDate: "2026-10-03",
              endDate: null,
            },
          ],
        },
      ],
    });
    await screen.findByText("Current data");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error("file input missing");
    }

    await user.upload(
      input,
      new File([content], "planning.json", { type: "application/json" }),
    );
    expect(
      await screen.findByRole("heading", { name: "导入规划数据" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 个母任务 · 1 个子任务/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始导入" }));
    expect(
      screen.getByRole("heading", { name: "确认覆盖当前规划" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认覆盖" }));

    expect(await screen.findAllByText("Imported plan")).not.toHaveLength(0);
    const board = await gateway.loadBoard();
    expect(board.tasks.map((task) => task.name)).toEqual(["Imported plan"]);
    expect(board.viewSettings.anchorDate).toBe("2026-10-03");
  });
});
