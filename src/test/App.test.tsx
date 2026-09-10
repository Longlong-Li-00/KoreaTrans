import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

describe("App authentication", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
  });

  it("未登录时显示个人口令入口且空口令不可提交", async () => {
    render(<App />);
    expect(await screen.findByLabelText("个人访问口令")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入翻译台" })).toBeDisabled();
    expect(screen.getByText(/音频不在本应用中录制或保存/)).toBeInTheDocument();
  });
});
