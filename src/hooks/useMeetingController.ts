import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, recordUsage } from "../lib/api";
import { captionReducer, initialCaptionState } from "../lib/captionReducer";
import { downloadMeetingMarkdown } from "../lib/exportMarkdown";
import { clearMeetingDraft, listMeetingDrafts, saveMeetingDraft } from "../lib/meetingStore";
import { AzureSpeechTranslator, type TranslationPayload } from "../lib/speechTranslator";
import { itemEndMs } from "../lib/time";
import type { CaptionSegment, MeetingDraft, SessionStatus } from "../types";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

interface MeetingIdentity {
  id: string;
  startedAt: string;
  endedAt: string | null;
}

function humanizeError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && /permission|microphone|notallowed|denied/i.test(error.message)) {
    return "无法使用麦克风。请在 Safari 网站设置中允许麦克风后重试。";
  }
  return "翻译连接失败，正在准备重连。";
}

function isPermissionError(error: unknown) {
  return error instanceof Error && /permission|microphone|notallowed|denied/i.test(error.message);
}

export function useMeetingController(onAuthenticationExpired: () => void) {
  const [captions, dispatch] = useReducer(captionReducer, initialCaptionState);
  const [meeting, setMeeting] = useState<MeetingIdentity | null>(null);
  const [recoverableDrafts, setRecoverableDrafts] = useState<MeetingDraft[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [runtimeMessage, setRuntimeMessage] = useState("准备开始");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [hasDownloaded, setHasDownloaded] = useState(false);

  const itemsRef = useRef(captions.items);
  const meetingRef = useRef(meeting);
  const meetingStartedMsRef = useRef<number | null>(null);
  const translatorRef = useRef<AzureSpeechTranslator | null>(null);
  const activeRef = useRef(false);
  const connectGenerationRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const gapIdRef = useRef<string | null>(null);
  const pauseIdRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const connectRef = useRef<(isReconnect: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => {
    itemsRef.current = captions.items;
  }, [captions.items]);

  useEffect(() => {
    meetingRef.current = meeting;
  }, [meeting]);

  const currentElapsed = useCallback(() => {
    const started = meetingStartedMsRef.current;
    return started === null ? 0 : Math.max(0, Date.now() - started);
  }, []);

  const buildCurrentDraft = useCallback((): MeetingDraft | null => {
    const current = meetingRef.current;
    if (!current) return null;
    return {
      schemaVersion: 1,
      id: current.id,
      startedAt: current.startedAt,
      endedAt: current.endedAt,
      updatedAt: new Date().toISOString(),
      sourceLanguage: "ko-KR",
      targetLanguage: "zh-Hans",
      provider: "azure-speech-translation",
      appVersion: __APP_VERSION__,
      items: itemsRef.current,
    };
  }, []);

  const rememberRecoverableDraft = useCallback((draft: MeetingDraft) => {
    setRecoverableDrafts((current) =>
      [draft, ...current.filter((item) => item.id !== draft.id)]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    );
  }, []);

  const requestWakeLock = useCallback(async () => {
    const wakeLock = navigator.wakeLock;
    if (!wakeLock || document.visibilityState !== "visible") return;
    try {
      wakeLockRef.current = await wakeLock.request("screen");
      wakeLockRef.current.addEventListener("release", () => {
        wakeLockRef.current = null;
      });
    } catch {
      setRuntimeMessage("请保持 Safari 前台并关闭自动锁屏，避免麦克风中断。");
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock) await lock.release().catch(() => undefined);
  }, []);

  const openGap = useCallback(
    (reason: string, startOverride?: number) => {
      if (gapIdRef.current) return;
      const id = `gap-${crypto.randomUUID()}`;
      gapIdRef.current = id;
      dispatch({
        type: "open_gap",
        gap: {
          id,
          kind: "gap",
          startMs: Math.max(0, Math.round(startOverride ?? currentElapsed())),
          endMs: null,
          reason,
        },
      });
    },
    [currentElapsed],
  );

  const closeGap = useCallback(
    (endOverride?: number) => {
      const id = gapIdRef.current;
      if (!id) return;
      dispatch({ type: "close_gap", id, endMs: Math.round(endOverride ?? currentElapsed()) });
      gapIdRef.current = null;
    },
    [currentElapsed],
  );

  const closePause = useCallback(
    (endOverride?: number) => {
      const id = pauseIdRef.current;
      if (!id) return;
      dispatch({ type: "close_pause", id, endMs: Math.round(endOverride ?? currentElapsed()) });
      pauseIdRef.current = null;
    },
    [currentElapsed],
  );

  const stopTranslator = useCallback(async () => {
    const translator = translatorRef.current;
    translatorRef.current = null;
    if (translator) await translator.stop().catch(() => undefined);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(
    (reason: string) => {
      if (!activeRef.current) return;
      openGap(reason);
      setStatus("reconnecting");
      setRuntimeMessage(reason);
      void stopTranslator();

      if (!navigator.onLine || document.visibilityState !== "visible") return;
      if (reconnectTimerRef.current !== null) return;

      const attempt = reconnectAttemptRef.current;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttemptRef.current = Math.min(attempt + 1, RECONNECT_DELAYS_MS.length - 1);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connectRef.current(true);
      }, delay);
    },
    [openGap, stopTranslator],
  );

  const stopForFatalSpeechError = useCallback(
    (reason: string) => {
      activeRef.current = false;
      clearReconnectTimer();
      openGap(reason);
      setStatus("error");
      setRuntimeMessage(reason);
      void stopTranslator();
      void releaseWakeLock();
    },
    [clearReconnectTimer, openGap, releaseWakeLock, stopTranslator],
  );

  const toSegment = useCallback(
    (payload: TranslationPayload, connectionBaseMs: number, statusValue: "interim" | "final") =>
      ({
        id: payload.id,
        kind: "caption",
        status: statusValue,
        startMs: connectionBaseMs + payload.startMs,
        endMs: connectionBaseMs + payload.endMs,
        sourceKo: payload.sourceKo,
        translationZhHans: payload.translationZhHans,
      }) satisfies CaptionSegment,
    [],
  );

  const connect = useCallback(
    async (isReconnect: boolean) => {
      if (!activeRef.current) return;
      if (!navigator.onLine || document.visibilityState !== "visible") {
        scheduleReconnect(!navigator.onLine ? "网络已断开" : "页面进入后台，翻译已暂停");
        return;
      }

      clearReconnectTimer();
      const generation = ++connectGenerationRef.current;
      await stopTranslator();
      if (!activeRef.current || generation !== connectGenerationRef.current) return;

      setStatus(isReconnect ? "reconnecting" : "requesting_permission");
      setRuntimeMessage(isReconnect ? "正在重新连接翻译服务…" : "正在请求麦克风并连接翻译服务…");
      const connectionBaseMs = currentElapsed();
      const translator = new AzureSpeechTranslator({
        onInterim: (payload) => {
          if (generation !== connectGenerationRef.current) return;
          dispatch({ type: "set_interim", segment: toSegment(payload, connectionBaseMs, "interim") });
        },
        onFinal: (payload) => {
          if (generation !== connectGenerationRef.current) return;
          dispatch({ type: "finalize", segment: toSegment(payload, connectionBaseMs, "final") });
        },
        onDisconnected: (reason, fatal) =>
          fatal ? stopForFatalSpeechError(reason) : scheduleReconnect(reason),
        onTokenError: (reason) => scheduleReconnect(reason),
      });
      translatorRef.current = translator;

      try {
        setStatus("connecting");
        await translator.start();
        if (!activeRef.current || generation !== connectGenerationRef.current) {
          await translator.stop();
          return;
        }
        reconnectAttemptRef.current = 0;
        closeGap();
        setStatus("listening");
        setRuntimeMessage("正在收听韩语；临时字幕已降频，最终字幕按语义自动冻结。");
        void requestWakeLock();
      } catch (error) {
        if (!activeRef.current || generation !== connectGenerationRef.current) return;
        if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
          activeRef.current = false;
          setStatus("error");
          setRuntimeMessage(error.message);
          onAuthenticationExpired();
          return;
        }
        const message = humanizeError(error);
        if (isPermissionError(error)) {
          openGap(message);
          setStatus("error");
          setRuntimeMessage(message);
        } else {
          scheduleReconnect(message);
        }
      }
    },
    [
      clearReconnectTimer,
      closeGap,
      currentElapsed,
      onAuthenticationExpired,
      openGap,
      requestWakeLock,
      scheduleReconnect,
      stopTranslator,
      stopForFatalSpeechError,
      toSegment,
    ],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    listMeetingDrafts()
      .then((drafts) => setRecoverableDrafts(drafts))
      .catch(() => setDraftError("无法读取本地恢复草稿；当前会话仍可使用。"));
  }, []);

  useEffect(() => {
    if (!meeting) return;
    const timeout = window.setTimeout(() => {
      const draft = buildCurrentDraft();
      if (!draft) return;
      saveMeetingDraft(draft).catch(() =>
        setDraftError("本地自动保存失败；请尽快结束并导出当前字幕。"),
      );
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [buildCurrentDraft, captions.items, meeting]);

  useEffect(() => {
    if (!meeting) return;
    const update = () => {
      if (meeting.endedAt) {
        setElapsedMs(Math.max(0, Date.parse(meeting.endedAt) - Date.parse(meeting.startedAt)));
      } else {
        setElapsedMs(currentElapsed());
      }
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [currentElapsed, meeting]);

  useEffect(() => {
    if (status !== "listening" || !meeting || meeting.endedAt) return;
    let lastReportedAt = Date.now();
    const flush = () => {
      const reportedAt = Date.now();
      const seconds = Math.min(60, Math.max(0, (reportedAt - lastReportedAt) / 1_000));
      lastReportedAt = reportedAt;
      if (seconds < 0.5) return;
      void recordUsage(meeting.id, seconds)
        .then(() => window.dispatchEvent(new Event("klt-usage-updated")))
        .catch(() => undefined);
    };
    const timer = window.setInterval(flush, 15_000);
    return () => {
      window.clearInterval(timer);
      flush();
    };
  }, [meeting, status]);

  const pauseForExternalReason = useCallback(
    (reason: string) => {
      if (!activeRef.current) return;
      connectGenerationRef.current += 1;
      clearReconnectTimer();
      openGap(reason);
      setStatus("reconnecting");
      setRuntimeMessage(reason);
      void stopTranslator();
    },
    [clearReconnectTimer, openGap, stopTranslator],
  );

  useEffect(() => {
    const handleOffline = () => pauseForExternalReason("网络已断开；此时间段可能没有字幕");
    const handleOnline = () => {
      if (activeRef.current && document.visibilityState === "visible") void connectRef.current(true);
    };
    const handleVisibility = () => {
      if (!activeRef.current) return;
      if (document.visibilityState === "hidden") {
        pauseForExternalReason("页面进入后台；此时间段不会被翻译");
      } else if (navigator.onLine) {
        void connectRef.current(true);
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pauseForExternalReason]);

  useEffect(
    () => () => {
      activeRef.current = false;
      clearReconnectTimer();
      void stopTranslator();
      void releaseWakeLock();
    },
    [clearReconnectTimer, releaseWakeLock, stopTranslator],
  );

  const beginMeeting = useCallback(async () => {
    const previousDraft = buildCurrentDraft();
    if (previousDraft) {
      try {
        await saveMeetingDraft(previousDraft);
        rememberRecoverableDraft(previousDraft);
      } catch {
        setDraftError("无法把当前会议保存为草稿，因此尚未开始新会议。请重试或先导出。");
        return;
      }
    }
    const now = new Date();
    const identity = { id: crypto.randomUUID(), startedAt: now.toISOString(), endedAt: null };
    dispatch({ type: "clear" });
    itemsRef.current = [];
    meetingRef.current = identity;
    setMeeting(identity);
    meetingStartedMsRef.current = now.getTime();
    activeRef.current = true;
    reconnectAttemptRef.current = 0;
    gapIdRef.current = null;
    pauseIdRef.current = null;
    setHasDownloaded(false);
    setElapsedMs(0);
    setDraftError(null);
    void connectRef.current(false);
  }, [buildCurrentDraft, rememberRecoverableDraft]);

  const pauseMeeting = useCallback(async () => {
    const current = meetingRef.current;
    if (!current || current.endedAt || status === "paused") return;
    activeRef.current = false;
    connectGenerationRef.current += 1;
    clearReconnectTimer();
    closeGap();
    const id = `pause-${crypto.randomUUID()}`;
    pauseIdRef.current = id;
    dispatch({
      type: "open_pause",
      pause: {
        id,
        kind: "pause",
        startMs: Math.round(currentElapsed()),
        endMs: null,
        reason: "用户主动暂停",
      },
    });
    setStatus("paused");
    setRuntimeMessage("翻译已暂停；麦克风和用量计时均已停止。继续后仍属于同一场会议。");
    await stopTranslator();
    await releaseWakeLock();
  }, [clearReconnectTimer, closeGap, currentElapsed, releaseWakeLock, status, stopTranslator]);

  const resumePausedMeeting = useCallback(() => {
    const current = meetingRef.current;
    if (!current || current.endedAt || status !== "paused") return;
    closePause();
    activeRef.current = true;
    reconnectAttemptRef.current = 0;
    void connectRef.current(true);
  }, [closePause, status]);

  const stopMeeting = useCallback(async () => {
    if (!meetingRef.current) return;
    activeRef.current = false;
    connectGenerationRef.current += 1;
    clearReconnectTimer();
    closeGap();
    closePause();
    const endedAt = new Date().toISOString();
    if (meetingRef.current) meetingRef.current = { ...meetingRef.current, endedAt };
    setMeeting((current) => (current ? { ...current, endedAt } : current));
    setStatus("stopped");
    setRuntimeMessage("会议已停止。请先导出，再确认清除本地草稿。");
    await stopTranslator();
    await releaseWakeLock();
  }, [clearReconnectTimer, closeGap, closePause, releaseWakeLock, stopTranslator]);

  const recoverDraft = useCallback((id: string) => {
    const draft = recoverableDrafts.find((item) => item.id === id);
    if (!draft) return;
    dispatch({ type: "hydrate", items: draft.items });
    const recovered = { id: draft.id, startedAt: draft.startedAt, endedAt: draft.endedAt };
    meetingRef.current = recovered;
    setMeeting(recovered);
    meetingStartedMsRef.current = Date.parse(draft.startedAt);
    const openGapItem = [...draft.items].reverse().find((item) => item.kind === "gap" && item.endMs === null);
    const openPauseItem = [...draft.items].reverse().find((item) => item.kind === "pause" && item.endMs === null);
    gapIdRef.current = openGapItem?.id ?? null;
    pauseIdRef.current = openPauseItem?.id ?? null;
    setStatus(openPauseItem && !draft.endedAt ? "paused" : "stopped");
    setElapsedMs(
      draft.endedAt
        ? Math.max(0, Date.parse(draft.endedAt) - Date.parse(draft.startedAt))
        : Math.max(0, Date.now() - Date.parse(draft.startedAt)),
    );
    setRuntimeMessage(
      draft.endedAt
        ? "已恢复结束的本地草稿。"
        : openPauseItem
          ? "已恢复暂停中的会议；继续后仍写入本场记录。"
          : "已恢复中断的本场草稿，可继续收听。",
    );
    setRecoverableDrafts((current) => current.filter((item) => item.id !== draft.id));
    setHasDownloaded(false);
  }, [recoverableDrafts]);

  const resumeMeeting = useCallback(() => {
    const current = meetingRef.current;
    if (!current || current.endedAt) return;
    const lastEnd = itemsRef.current.reduce((latest, item) => Math.max(latest, itemEndMs(item)), 0);
    openGap("页面刷新或会话中断", lastEnd);
    activeRef.current = true;
    reconnectAttemptRef.current = 0;
    void connectRef.current(true);
  }, [openGap]);

  const retryConnection = useCallback(() => {
    if (!meetingRef.current || meetingRef.current.endedAt) return;
    activeRef.current = true;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    void connectRef.current(true);
  }, [clearReconnectTimer]);

  const discardRecoverableDraft = useCallback(async (id: string) => {
    await clearMeetingDraft(id);
    setRecoverableDrafts((current) => current.filter((item) => item.id !== id));
  }, []);

  const exportDraft = useCallback(() => {
    const draft = buildCurrentDraft();
    if (!draft) return;
    downloadMeetingMarkdown(draft);
    setHasDownloaded(true);
  }, [buildCurrentDraft]);

  const clearCurrentDraft = useCallback(async () => {
    const currentId = meetingRef.current?.id;
    activeRef.current = false;
    await stopTranslator();
    if (currentId) await clearMeetingDraft(currentId);
    dispatch({ type: "clear" });
    meetingRef.current = null;
    setMeeting(null);
    meetingStartedMsRef.current = null;
    gapIdRef.current = null;
    pauseIdRef.current = null;
    setStatus("idle");
    setRuntimeMessage("准备开始");
    setElapsedMs(0);
    setHasDownloaded(false);
    setDraftError(null);
    setRecoverableDrafts((current) => current.filter((item) => item.id !== currentId));
  }, [stopTranslator]);

  return {
    captions,
    meeting,
    recoverableDrafts,
    status,
    runtimeMessage,
    elapsedMs,
    draftError,
    hasDownloaded,
    beginMeeting,
    pauseMeeting,
    resumePausedMeeting,
    stopMeeting,
    recoverDraft,
    resumeMeeting,
    retryConnection,
    discardRecoverableDraft,
    exportDraft,
    clearCurrentDraft,
  };
}
