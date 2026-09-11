export type SessionStatus =
  | "idle"
  | "requesting_permission"
  | "connecting"
  | "listening"
  | "paused"
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

export interface PauseMarker {
  id: string;
  kind: "pause";
  startMs: number;
  endMs: number | null;
  reason: "用户主动暂停";
}

export type TimelineItem = CaptionSegment | GapMarker | PauseMarker;

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

export interface AuthUser {
  id: string;
  displayName: string;
  role: "owner" | "tester";
}

export interface AuthSession {
  authenticated: boolean;
  user: AuthUser | null;
}

export interface UsageSummary {
  available: boolean;
  source: "application_estimate";
  monthlyLimitSeconds: number;
  estimatedUsedSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  periodStart: string;
  periodEnd: string;
  asOf: string;
}

export interface FeedbackPayload {
  rating: number;
  category: string;
  comment: string;
  status: SessionStatus;
  meetingDurationSeconds: number;
  finalCaptionCount: number;
  gapCount: number;
  appVersion: string;
}

export interface FeedbackEntry extends FeedbackPayload {
  id: string;
  userId: string;
  displayName: string;
  createdAt: string;
}

export interface CaptionState {
  items: TimelineItem[];
  provisional: CaptionSegment | null;
}
