import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { clearMeetingDraft, saveMeetingDraft } from "../lib/meetingStore";
import type { MeetingDraft } from "../types";

describe("App authentication", () => {
  beforeEach(async () => {
    await clearMeetingDraft();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
  });

  it("未登录时显示测试账号入口、水印且空口令不可提交", async () => {
    render(<App />);
    expect(await screen.findByLabelText("测试账号")).toHaveValue("longlong");
    expect(await screen.findByLabelText("个人访问口令")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入翻译台" })).toBeDisabled();
    expect(screen.getByText(/音频不在本应用中录制或保存/)).toBeInTheDocument();
    expect(screen.getByText("longlong · beta")).toBeInTheDocument();
  });

  it("已有草稿时仍显示新会议入口", async () => {
    const draft: MeetingDraft = {
      schemaVersion: 1,
      id: "older-meeting",
      startedAt: "2026-09-10T01:00:00.000Z",
      endedAt: "2026-09-10T01:10:00.000Z",
      updatedAt: "2026-09-10T01:10:00.000Z",
      sourceLanguage: "ko-KR",
      targetLanguage: "zh-Hans",
      provider: "azure-speech-translation",
      appVersion: "0.3.0",
      items: [],
    };
    await saveMeetingDraft(draft);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return Promise.resolve(new Response(JSON.stringify({
          authenticated: true,
          user: { id: "tester01", displayName: "测试员 01", role: "tester" },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        available: true,
        source: "application_estimate",
        monthlyLimitSeconds: 18_000,
        estimatedUsedSeconds: 0,
        estimatedRemainingSeconds: 18_000,
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        asOf: "2026-09-10T01:10:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }));

    render(<App />);
    expect(await screen.findByText("会议草稿（1）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始收听" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开草稿" })).toBeInTheDocument();
  });
});
