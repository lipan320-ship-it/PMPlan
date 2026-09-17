import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the local-first desktop shell", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "规划空间正在准备中" }),
    ).toBeInTheDocument();
    expect(screen.getByText("本地离线模式")).toBeInTheDocument();
    expect(screen.getByText("当前页面不请求网络，也不会上传规划数据。"))
      .toBeInTheDocument();
  });
});
