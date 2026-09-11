import { describe, expect, it } from "vitest";
import { buildMeetingMarkdown } from "../lib/exportMarkdown";
import type { MeetingDraft } from "../types";

describe("buildMeetingMarkdown", () => {
  it("输出双语字幕、缺失区间、版本和证据边界", () => {
    const draft: MeetingDraft = {
      schemaVersion: 1,
      id: "meeting-1",
      startedAt: "2026-09-10T01:00:00.000Z",
      endedAt: "2026-09-10T01:10:00.000Z",
      updatedAt: "2026-09-10T01:10:00.000Z",
      sourceLanguage: "ko-KR",
      targetLanguage: "zh-Hans",
      provider: "azure-speech-translation",
      appVersion: "0.1.0",
      items: [
        { id: "c1", kind: "caption", status: "final", startMs: 1_000, endMs: 2_500, sourceKo: "실험을 시작합니다.", translationZhHans: "开始实验。" },
        { id: "g1", kind: "gap", startMs: 3_000, endMs: 8_000, reason: "网络中断" },
        { id: "p1", kind: "pause", startMs: 9_000, endMs: 14_000, reason: "用户主动暂停" },
      ],
    };
    const markdown = buildMeetingMarkdown(draft);
    expect(markdown).toContain("开始实验。");
    expect(markdown).toContain("실험을 시작합니다.");
    expect(markdown).toContain("未翻译区间 00:00:03–00:00:08");
    expect(markdown).toContain("主动暂停 00:00:09–00:00:14");
    expect(markdown).toContain("暂停期间未使用麦克风或翻译额度");
    expect(markdown).toContain("应用版本：0.1.0");
    expect(markdown).toContain("未经韩中双语人工校验");
  });
});
