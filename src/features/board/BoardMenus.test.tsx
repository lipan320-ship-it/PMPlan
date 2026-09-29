import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../App";
import { createEmptyBoard } from "../../app/createStorageGateway";
import { MemoryStorageGateway } from "../../storage/memoryGateway";

const menus = [
  { name: "project", trigger: /未命名规划/ },
  { name: "view", trigger: "查看" },
  { name: "more", trigger: "更多数据操作" },
];

describe("board menus", () => {
  it.each(menus)("dismisses the $name menu on outside clicks and allows reopening", async ({ trigger }) => {
    const user = userEvent.setup();
    render(<App gateway={new MemoryStorageGateway(createEmptyBoard())} />);
    const button = await screen.findByRole("button", { name: trigger });

    await user.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // Non-focusable blank space must dismiss independently of focus changes.
    await user.click(screen.getByRole("main"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    await user.click(screen.getByPlaceholderText("搜索任务"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索任务")).toHaveFocus();

    await user.click(button);
    await user.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(button);
    await user.click(screen.getByRole("menu"));
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.click(button);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("switches between project, view and more menus without leaving the previous one open", async () => {
    const user = userEvent.setup();
    render(<App gateway={new MemoryStorageGateway(createEmptyBoard())} />);
    const project = await screen.findByRole("button", { name: /未命名规划/ });
    const view = screen.getByRole("button", { name: "查看" });
    const more = screen.getByRole("button", { name: "更多数据操作" });

    for (const button of [project, view, more, project]) {
      await user.click(button);
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      for (const candidate of [project, view, more]) {
        expect(candidate).toHaveAttribute("aria-expanded", String(candidate === button));
      }
    }
  });

  it("keeps view settings interactive inside the menu", async () => {
    const user = userEvent.setup();
    const gateway = new MemoryStorageGateway(createEmptyBoard());
    render(<App gateway={gateway} />);
    await user.click(await screen.findByRole("button", { name: "查看" }));

    const menu = screen.getByRole("menu");
    const weekends = within(menu).getByRole("checkbox", { name: "标记周末" });
    await user.click(weekends);
    expect(weekends).not.toBeChecked();
    const dependencies = within(menu).getByRole("checkbox", { name: "显示依赖关系" });
    await user.click(dependencies);
    expect(dependencies).not.toBeChecked();
    expect((await gateway.loadBoard()).viewSettings.showDependencies).toBe(false);
    expect(menu).toBeInTheDocument();

    await user.click(screen.getByRole("main"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("executes a menu action before closing", async () => {
    const user = userEvent.setup();
    render(<App gateway={new MemoryStorageGateway(createEmptyBoard())} />);
    await user.click(await screen.findByRole("button", { name: "更多数据操作" }));
    await user.click(within(screen.getByRole("menu")).getByRole("button", { name: "导入模板" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dismisses even when an outside element stops pointer event propagation", async () => {
    const user = userEvent.setup();
    render(
      <>
        <App gateway={new MemoryStorageGateway(createEmptyBoard())} />
        <div onPointerDown={(event) => event.stopPropagation()}>外部区域</div>
      </>,
    );
    await user.click(await screen.findByRole("button", { name: /未命名规划/ }));
    fireEvent.pointerDown(screen.getByText("外部区域"), { pointerType: "touch" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
