import { describe, expect, it } from "vitest";
import { captionReducer, initialCaptionState } from "../lib/captionReducer";
import type { CaptionSegment, GapMarker, PauseMarker } from "../types";

function caption(id: string, status: "interim" | "final" = "final"): CaptionSegment {
  return {
    id,
    kind: "caption",
    status,
    startMs: 1_000,
    endMs: 2_000,
    sourceKo: `한국어 ${id}`,
    translationZhHans: `中文 ${id}`,
  };
}

describe("captionReducer", () => {
  it("只保留一个可覆盖的临时字幕", () => {
    const first = captionReducer(initialCaptionState, { type: "set_interim", segment: caption("a", "interim") });
    const second = captionReducer(first, { type: "set_interim", segment: caption("b", "interim") });
    expect(second.items).toHaveLength(0);
    expect(second.provisional?.id).toBe("provisional");
    expect(second.provisional?.sourceKo).toContain("b");
  });

  it("最终字幕冻结并忽略重复事件", () => {
    const finalized = captionReducer(initialCaptionState, { type: "finalize", segment: caption("fixed") });
    const repeated = captionReducer(finalized, { type: "finalize", segment: caption("fixed") });
    expect(repeated.items).toHaveLength(1);
    expect(repeated.items[0]).toMatchObject({ id: "fixed", status: "final" });
    expect(repeated.provisional).toBeNull();
  });

  it("乱序到达的最终事件仍按原始时间排列", () => {
    const late = captionReducer(initialCaptionState, {
      type: "finalize",
      segment: { ...caption("late"), startMs: 5_000, endMs: 6_000 },
    });
    const reordered = captionReducer(late, {
      type: "finalize",
      segment: { ...caption("early"), startMs: 1_000, endMs: 2_000 },
    });
    expect(reordered.items.map((item) => item.id)).toEqual(["early", "late"]);
  });

  it("丢弃空结果与恢复数据中的临时字幕", () => {
    const empty = { ...caption("empty"), sourceKo: " ", translationZhHans: "" };
    expect(captionReducer(initialCaptionState, { type: "finalize", segment: empty }).items).toHaveLength(0);
    const hydrated = captionReducer(initialCaptionState, {
      type: "hydrate",
      items: [caption("interim", "interim"), caption("final")],
    });
    expect(hydrated.items.map((item) => item.id)).toEqual(["final"]);
  });

  it("打开和关闭缺失区间，且不产生重叠的开放标记", () => {
    const gap: GapMarker = { id: "gap-1", kind: "gap", startMs: 4_000, endMs: null, reason: "网络中断" };
    const opened = captionReducer(initialCaptionState, { type: "open_gap", gap });
    const duplicate = captionReducer(opened, {
      type: "open_gap",
      gap: { ...gap, id: "gap-2", startMs: 5_000 },
    });
    const closed = captionReducer(duplicate, { type: "close_gap", id: "gap-1", endMs: 3_000 });
    expect(duplicate.items).toHaveLength(1);
    expect(closed.items[0]).toMatchObject({ startMs: 4_000, endMs: 4_000 });
  });

  it("主动暂停作为独立区间保存，并在继续时关闭", () => {
    const pause: PauseMarker = {
      id: "pause-1",
      kind: "pause",
      startMs: 7_000,
      endMs: null,
      reason: "用户主动暂停",
    };
    const opened = captionReducer(initialCaptionState, { type: "open_pause", pause });
    const closed = captionReducer(opened, { type: "close_pause", id: pause.id, endMs: 12_000 });
    expect(closed.items).toEqual([{ ...pause, endMs: 12_000 }]);
    expect(closed.provisional).toBeNull();
  });
});
