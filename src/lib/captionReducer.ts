import type { CaptionSegment, CaptionState, GapMarker, TimelineItem } from "../types";

export type CaptionAction =
  | { type: "set_interim"; segment: CaptionSegment }
  | { type: "finalize"; segment: CaptionSegment }
  | { type: "open_gap"; gap: GapMarker }
  | { type: "close_gap"; id: string; endMs: number }
  | { type: "hydrate"; items: TimelineItem[] }
  | { type: "clear" };

export const initialCaptionState: CaptionState = { items: [], provisional: null };

function isUsefulCaption(segment: CaptionSegment) {
  return Boolean(segment.sourceKo.trim() || segment.translationZhHans.trim());
}

function chronological(items: TimelineItem[]) {
  return [...items].sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
}

export function captionReducer(state: CaptionState, action: CaptionAction): CaptionState {
  switch (action.type) {
    case "set_interim":
      if (!isUsefulCaption(action.segment)) return { ...state, provisional: null };
      return {
        ...state,
        provisional: { ...action.segment, status: "interim", id: "provisional" },
      };

    case "finalize": {
      if (!isUsefulCaption(action.segment)) return { ...state, provisional: null };
      if (state.items.some((item) => item.kind === "caption" && item.id === action.segment.id)) {
        return { ...state, provisional: null };
      }
      return {
        items: chronological([...state.items, { ...action.segment, status: "final" }]),
        provisional: null,
      };
    }

    case "open_gap":
      if (state.items.some((item) => item.kind === "gap" && item.endMs === null)) return state;
      return { ...state, provisional: null, items: chronological([...state.items, action.gap]) };

    case "close_gap":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "gap" && item.id === action.id && item.endMs === null
            ? { ...item, endMs: Math.max(item.startMs, action.endMs) }
            : item,
        ),
      };

    case "hydrate":
      return {
        items: chronological(
          action.items.filter(
            (item): item is TimelineItem =>
              item.kind === "gap" || (item.kind === "caption" && item.status === "final"),
          ),
        ),
        provisional: null,
      };

    case "clear":
      return initialCaptionState;
  }
}
