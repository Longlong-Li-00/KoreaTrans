import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { captionReducer, initialCaptionState } from "../lib/captionReducer";
import { downloadMeetingMarkdown } from "../lib/exportMarkdown";
import { clearMeetingDraft, loadMeetingDraft, saveMeetingDraft } from "../lib/meetingStore";
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
  const [recoverableDraft, setRecoverableDraft] = useState<MeetingDraft | null>(null);
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
      if (attempt >= RECONNECT_DELAYS_MS.length) {
        setStatus("error");
        setRuntimeMessage("连续重连失败。请检查网络、Azure F0 配额和麦克风权限后手动重试。");
        return;
      }

      const delay = RECONNECT_DELAYS_MS[attempt];
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connectRef.current(true);
      }, delay);
    },
    [openGap, stopTranslator],
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
        onDisconnected: (reason) => scheduleReconnect(reason),
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
        setRuntimeMessage("正在收听韩语；灰色字幕仍可能修订。");
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
      toSegment,
    ],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    loadMeetingDraft()
      .then((draft) => setRecoverableDraft(draft))
      .catch(() => setDraftError("无法读取本地恢复草稿；当前会话仍可使用。"));
  }, []);

  useEffect(() => {
    if (!meeting) return;
    const timeout = window.setTimeout(() => {
      const draft: MeetingDraft = {
        schemaVersion: 1,
        id: meeting.id,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        updatedAt: new Date().toISOString(),
        sourceLanguage: "ko-KR",
        targetLanguage: "zh-Hans",
        provider: "azure-speech-translation",
        appVersion: __APP_VERSION__,
        items: captions.items,
      };
      saveMeetingDraft(draft).catch(() =>
        setDraftError("本地自动保存失败；请尽快结束并导出当前字幕。"),
      );
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [captions.items, meeting]);

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

  const beginMeeting = useCallback(() => {
    const now = new Date();
    const identity = { id: crypto.randomUUID(), startedAt: now.toISOString(), endedAt: null };
    dispatch({ type: "clear" });
    meetingRef.current = identity;
    setMeeting(identity);
    meetingStartedMsRef.current = now.getTime();
    activeRef.current = true;
    reconnectAttemptRef.current = 0;
    gapIdRef.current = null;
    setHasDownloaded(false);
    setElapsedMs(0);
    setDraftError(null);
    void connectRef.current(false);
  }, []);

  const stopMeeting = useCallback(async () => {
    if (!meetingRef.current) return;
    activeRef.current = false;
    connectGenerationRef.current += 1;
    clearReconnectTimer();
    closeGap();
    const endedAt = new Date().toISOString();
    if (meetingRef.current) meetingRef.current = { ...meetingRef.current, endedAt };
    setMeeting((current) => (current ? { ...current, endedAt } : current));
    setStatus("stopped");
    setRuntimeMessage("会议已停止。请先导出，再确认清除本地草稿。");
    await stopTranslator();
    await releaseWakeLock();
  }, [clearReconnectTimer, closeGap, releaseWakeLock, stopTranslator]);

  const recoverDraft = useCallback(() => {
    const draft = recoverableDraft;
    if (!draft) return;
    dispatch({ type: "hydrate", items: draft.items });
    const recovered = { id: draft.id, startedAt: draft.startedAt, endedAt: draft.endedAt };
    meetingRef.current = recovered;
    setMeeting(recovered);
    meetingStartedMsRef.current = Date.parse(draft.startedAt);
    const openGapItem = [...draft.items].reverse().find((item) => item.kind === "gap" && item.endMs === null);
    gapIdRef.current = openGapItem?.id ?? null;
    setStatus("stopped");
    setElapsedMs(
      draft.endedAt
        ? Math.max(0, Date.parse(draft.endedAt) - Date.parse(draft.startedAt))
        : Math.max(0, Date.now() - Date.parse(draft.startedAt)),
    );
    setRuntimeMessage(draft.endedAt ? "已恢复结束的本地草稿。" : "已恢复中断的本场草稿，可继续收听。" );
    setRecoverableDraft(null);
    setHasDownloaded(false);
  }, [recoverableDraft]);

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

  const discardRecoverableDraft = useCallback(async () => {
    await clearMeetingDraft();
    setRecoverableDraft(null);
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

  const exportDraft = useCallback(() => {
    const draft = buildCurrentDraft();
    if (!draft) return;
    downloadMeetingMarkdown(draft);
    setHasDownloaded(true);
  }, [buildCurrentDraft]);

  const clearCurrentDraft = useCallback(async () => {
    activeRef.current = false;
    await stopTranslator();
    await clearMeetingDraft();
    dispatch({ type: "clear" });
    meetingRef.current = null;
    setMeeting(null);
    meetingStartedMsRef.current = null;
    gapIdRef.current = null;
    setStatus("idle");
    setRuntimeMessage("准备开始");
    setElapsedMs(0);
    setHasDownloaded(false);
    setDraftError(null);
  }, [stopTranslator]);

  return {
    captions,
    meeting,
    recoverableDraft,
    status,
    runtimeMessage,
    elapsedMs,
    draftError,
    hasDownloaded,
    beginMeeting,
    stopMeeting,
    recoverDraft,
    resumeMeeting,
    retryConnection,
    discardRecoverableDraft,
    exportDraft,
    clearCurrentDraft,
  };
}
