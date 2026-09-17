import { fireEvent, render, screen } from "@testing-library/react";
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
});
