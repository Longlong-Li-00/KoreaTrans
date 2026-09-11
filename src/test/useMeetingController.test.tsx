import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingController } from "../hooks/useMeetingController";
import { clearMeetingDraft } from "../lib/meetingStore";

const speechMocks = vi.hoisted(() => ({
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    code = "MOCK_ERROR";
  },
  recordUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/speechTranslator", () => ({
  AzureSpeechTranslator: class AzureSpeechTranslator {
    start() {
      return speechMocks.start();
    }
    stop() {
      return speechMocks.stop();
    }
  },
}));

describe("useMeetingController pause flow", () => {
  beforeEach(async () => {
    await clearMeetingDraft();
    speechMocks.start.mockClear();
    speechMocks.stop.mockClear();
  });

  afterEach(async () => {
    await clearMeetingDraft();
  });

  it("暂停会停止识别器，继续后在同一会议中关闭暂停区间", async () => {
    const { result } = renderHook(() => useMeetingController(vi.fn()));

    await act(async () => result.current.beginMeeting());
    await waitFor(() => expect(result.current.status).toBe("listening"));
    const meetingId = result.current.meeting?.id;

    await act(async () => result.current.pauseMeeting());
    expect(result.current.status).toBe("paused");
    expect(speechMocks.stop).toHaveBeenCalled();
    expect(result.current.captions.items).toEqual([
      expect.objectContaining({ kind: "pause", endMs: null }),
    ]);

    act(() => result.current.resumePausedMeeting());
    await waitFor(() => expect(result.current.status).toBe("listening"));
    expect(result.current.meeting?.id).toBe(meetingId);
    expect(speechMocks.start).toHaveBeenCalledTimes(2);
    expect(result.current.captions.items).toEqual([
      expect.objectContaining({ kind: "pause", endMs: expect.any(Number) }),
    ]);
  });
});
