export type SessionStatus =
  | "idle"
  | "requesting_permission"
  | "connecting"
  | "listening"
  | "reconnecting"
  | "stopped"
  | "error";

export interface CaptionSegment {
  id: string;
  kind: "caption";
  status: "interim" | "final";
  startMs: number;
  endMs: number;
  sourceKo: string;
  translationZhHans: string;
}

export interface GapMarker {
  id: string;
  kind: "gap";
  startMs: number;
  endMs: number | null;
  reason: string;
}

export type TimelineItem = CaptionSegment | GapMarker;

export interface MeetingDraft {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  sourceLanguage: "ko-KR";
  targetLanguage: "zh-Hans";
  provider: "azure-speech-translation";
  appVersion: string;
  items: TimelineItem[];
}

export interface SpeechToken {
  token: string;
  region: string;
  expiresAt: number;
}

export interface CaptionState {
  items: TimelineItem[];
  provisional: CaptionSegment | null;
}

