import { afterEach, describe, expect, it } from "vitest";
import { clearMeetingDraft, loadMeetingDraft, saveMeetingDraft } from "../lib/meetingStore";
import type { MeetingDraft } from "../types";

const baseDraft: MeetingDraft = {
  schemaVersion: 1,
  id: "meeting-1",
  startedAt: "2026-09-10T01:00:00.000Z",
  endedAt: null,
  updatedAt: "2026-09-10T01:00:10.000Z",
  sourceLanguage: "ko-KR",
  targetLanguage: "zh-Hans",
  provider: "azure-speech-translation",
  appVersion: "0.1.0",
  items: [],
};

afterEach(() => clearMeetingDraft());

describe("meetingStore", () => {
  it("只持久化最终字幕和缺失标记", async () => {
    await saveMeetingDraft({
      ...baseDraft,
      items: [
        { id: "temp", kind: "caption", status: "interim", startMs: 0, endMs: 1, sourceKo: "임시", translationZhHans: "临时" },
        { id: "final", kind: "caption", status: "final", startMs: 1, endMs: 2, sourceKo: "확정", translationZhHans: "最终" },
        { id: "gap", kind: "gap", startMs: 2, endMs: 4, reason: "网络中断" },
      ],
    });
    const restored = await loadMeetingDraft();
    expect(restored?.items.map((item) => item.id)).toEqual(["final", "gap"]);
  });

  it("可彻底清除当前草稿", async () => {
    await saveMeetingDraft(baseDraft);
    await clearMeetingDraft();
    expect(await loadMeetingDraft()).toBeNull();
  });
});
