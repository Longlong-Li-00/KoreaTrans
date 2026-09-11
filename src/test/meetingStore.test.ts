import { afterEach, describe, expect, it } from "vitest";
import { clearMeetingDraft, listMeetingDrafts, loadMeetingDraft, saveMeetingDraft } from "../lib/meetingStore";
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
  it("只持久化最终字幕、缺失标记和主动暂停", async () => {
    await saveMeetingDraft({
      ...baseDraft,
      items: [
        { id: "temp", kind: "caption", status: "interim", startMs: 0, endMs: 1, sourceKo: "임시", translationZhHans: "临时" },
        { id: "final", kind: "caption", status: "final", startMs: 1, endMs: 2, sourceKo: "확정", translationZhHans: "最终" },
        { id: "gap", kind: "gap", startMs: 2, endMs: 4, reason: "网络中断" },
        { id: "pause", kind: "pause", startMs: 5, endMs: 8, reason: "用户主动暂停" },
      ],
    });
    const restored = await loadMeetingDraft();
    expect(restored?.items.map((item) => item.id)).toEqual(["final", "gap", "pause"]);
  });

  it("按会议分别保存，删除一份不会影响其他草稿", async () => {
    await saveMeetingDraft(baseDraft);
    await saveMeetingDraft({ ...baseDraft, id: "meeting-2", updatedAt: "2026-09-10T01:01:00.000Z" });
    expect((await listMeetingDrafts()).map((draft) => draft.id)).toEqual(["meeting-2", "meeting-1"]);
    await clearMeetingDraft("meeting-2");
    expect((await listMeetingDrafts()).map((draft) => draft.id)).toEqual(["meeting-1"]);
    expect((await loadMeetingDraft("meeting-1"))?.id).toBe("meeting-1");
  });

  it("升级数据库时保留旧版单槽位草稿", async () => {
    await clearMeetingDraft();
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase("korea-live-translate");
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("korea-live-translate", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put(baseDraft, "current");
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    expect((await listMeetingDrafts()).map((draft) => draft.id)).toEqual(["meeting-1"]);
  });
});
