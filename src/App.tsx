import { useEffect, useRef, useState, type FormEvent } from "react";
import { checkSession, login, logout } from "./lib/api";
import { formatElapsed } from "./lib/time";
import { useMeetingController } from "./hooks/useMeetingController";
import type { SessionStatus, TimelineItem } from "./types";
import "./styles.css";

type AuthenticationState = "checking" | "signed_out" | "signed_in";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "准备就绪",
  requesting_permission: "等待麦克风",
  connecting: "正在连接",
  listening: "正在收听",
  reconnecting: "连接中断",
  stopped: "已停止",
  error: "需要处理",
};

function LoginScreen({
  checking,
  initialError,
  onSignedIn,
}: {
  checking: boolean;
  initialError: string | null;
  onSignedIn: () => void;
}) {
  const [password, setPassword] = useState("");
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const error = submissionError ?? initialError;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await login(password);
      setPassword("");
      onSignedIn();
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : "登录失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="brand-mark" aria-hidden="true">
          <span />
        </div>
        <p className="eyebrow">KOREA LIVE TRANSLATE</p>
        <h1 id="login-title">听懂此刻的讨论</h1>
        <p className="auth-intro">韩语实时转为简体中文字幕。音频不在本应用中录制或保存。</p>
        {checking ? (
          <div className="loading-line" role="status">
            <span className="spinner" /> 正在检查登录状态…
          </div>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="password">个人访问口令</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              minLength={16}
              maxLength={256}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入至少 16 位口令"
              required
            />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button wide" disabled={submitting || password.length < 16}>
              {submitting ? "正在登录…" : "进入翻译台"}
            </button>
          </form>
        )}
        <p className="privacy-footnote">口令只通过 HTTPS 发往你的 Azure Function；Azure Speech 密钥不会进入浏览器。</p>
      </section>
    </main>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  if (item.kind === "gap") {
    return (
      <article className="gap-card" aria-label="未翻译区间">
        <span>连接空档</span>
        <strong>
          {formatElapsed(item.startMs)} — {item.endMs === null ? "尚未恢复" : formatElapsed(item.endMs)}
        </strong>
        <p>{item.reason}</p>
      </article>
    );
  }

  return (
    <article className="caption-card final-caption">
      <time>{formatElapsed(item.startMs)}</time>
      <p className="chinese-caption" lang="zh-Hans">{item.translationZhHans || "（暂无中文译文）"}</p>
      <p className="korean-caption" lang="ko">{item.sourceKo || "（暂无韩文转写）"}</p>
    </article>
  );
}

function App() {
  const [authState, setAuthState] = useState<AuthenticationState>("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const timelineRef = useRef<HTMLDivElement>(null);

  const meetingController = useMeetingController(() => {
    setAuthState("signed_out");
    setAuthError("登录已过期，请重新登录后恢复本场草稿。");
  });

  useEffect(() => {
    checkSession()
      .then((authenticated) => setAuthState(authenticated ? "signed_in" : "signed_out"))
      .catch(() => {
        setAuthState("signed_out");
        setAuthError("无法连接登录服务。请确认 Azure API 已部署并刷新页面。");
      });
  }, []);

  useEffect(() => {
    if (!followLatest) return;
    const element = timelineRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [followLatest, meetingController.captions.items, meetingController.captions.provisional]);

  function handleTimelineScroll() {
    const element = timelineRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowLatest(distanceFromBottom < 72);
  }

  async function signOut() {
    if (meetingController.meeting && !meetingController.meeting.endedAt) {
      await meetingController.stopMeeting();
    }
    await logout().catch(() => undefined);
    setAuthState("signed_out");
    setConsentConfirmed(false);
  }

  async function confirmClear() {
    if (!meetingController.hasDownloaded) return;
    const confirmed = window.confirm(
      "确认已经保存导出的 Markdown 文件，并删除这台设备上的临时字幕草稿？此操作不可撤销。",
    );
    if (confirmed) await meetingController.clearCurrentDraft();
  }

  if (authState !== "signed_in") {
    return (
      <LoginScreen
        checking={authState === "checking"}
        initialError={authError}
        onSignedIn={() => {
          setAuthError(null);
          setAuthState("signed_in");
        }}
      />
    );
  }

  const {
    captions,
    meeting,
    recoverableDraft,
    status,
    runtimeMessage,
    elapsedMs,
    draftError,
    hasDownloaded,
  } = meetingController;
  const isRunning = status === "listening" || status === "connecting" || status === "requesting_permission" || status === "reconnecting";
  const canResume = Boolean(meeting && !meeting.endedAt && !isRunning);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">KO → 简体中文</p>
          <h1>实时翻译台</h1>
        </div>
        <button className="quiet-button" onClick={signOut}>退出</button>
      </header>

      {!meeting && recoverableDraft && (
        <section className="recovery-card" aria-labelledby="recovery-title">
          <span className="recovery-icon" aria-hidden="true">↻</span>
          <div>
            <p className="eyebrow">发现本地草稿</p>
            <h2 id="recovery-title">上次字幕尚未清除</h2>
            <p>
              {new Date(recoverableDraft.startedAt).toLocaleString("zh-CN")} · {recoverableDraft.items.length} 条记录
            </p>
            <div className="button-row">
              <button className="primary-button" onClick={meetingController.recoverDraft}>恢复草稿</button>
              <button className="secondary-button" onClick={meetingController.discardRecoverableDraft}>删除草稿</button>
            </div>
          </div>
        </section>
      )}

      {!meeting && !recoverableDraft && (
        <section className="start-panel">
          <div className="language-route" aria-label="翻译方向">
            <span><b>한</b> 韩语现场</span>
            <i aria-hidden="true">→</i>
            <span><b>中</b> 中文字幕</span>
          </div>
          <h2>把 iPhone 放在桌面中央</h2>
          <p>适合 2–6 人、30 分钟以内的小型会议。请保持 Safari 在前台，并使用稳定的 Wi-Fi 或 5G。</p>
          <label className="consent-check">
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => setConsentConfirmed(event.target.checked)}
            />
            <span>
              <strong>我已告知所有参会者</strong>
              并确认他们同意将现场语音发送至 Azure 进行即时识别与翻译。
            </span>
          </label>
          <button
            className="primary-button start-button"
            disabled={!consentConfirmed}
            onClick={meetingController.beginMeeting}
          >
            <span className="mic-symbol" aria-hidden="true" />
            开始收听
          </button>
          <div className="boundary-note">
            <strong>边界说明</strong>
            本工具不录音、不识别说话人。译文未经人工校验，仅用于辅助理解。
          </div>
        </section>
      )}

      {meeting && (
        <section className="meeting-console">
          <div className={`status-strip status-${status}`} role="status">
            <span className="status-dot" />
            <div>
              <strong>{STATUS_LABELS[status]}</strong>
              <p>{runtimeMessage}</p>
            </div>
            <time>{formatElapsed(elapsedMs)}</time>
          </div>

          {(draftError || !navigator.onLine) && (
            <div className="warning-banner" role="alert">
              {draftError ?? "设备当前离线；离线期间不会生成字幕。"}
            </div>
          )}

          <div
            className="timeline"
            ref={timelineRef}
            onScroll={handleTimelineScroll}
            role="log"
            aria-live="polite"
            aria-label="实时双语字幕"
          >
            {captions.items.length === 0 && !captions.provisional && (
              <div className="empty-state">
                <span className="sound-bars" aria-hidden="true"><i /><i /><i /><i /></span>
                <h2>{isRunning ? "等待韩语发言…" : "本场还没有字幕"}</h2>
                <p>中文会以大字显示，韩文原文保留在下方以便复核。</p>
              </div>
            )}
            {captions.items.map((item) => <TimelineEntry key={item.id} item={item} />)}
            {captions.provisional && (
              <article className="caption-card provisional-caption">
                <span className="provisional-label">临时 · 仍可能修订</span>
                <p className="chinese-caption" lang="zh-Hans">
                  {captions.provisional.translationZhHans || "正在理解…"}
                </p>
                <p className="korean-caption" lang="ko">{captions.provisional.sourceKo}</p>
              </article>
            )}
          </div>

          {!followLatest && (
            <button
              className="return-live"
              onClick={() => {
                setFollowLatest(true);
                const element = timelineRef.current;
                if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
              }}
            >
              ↓ 返回实时
            </button>
          )}

          <footer className="meeting-actions">
            {isRunning && (
              <button className="stop-button" onClick={meetingController.stopMeeting}>
                <span aria-hidden="true" /> 结束会议
              </button>
            )}
            {canResume && !meeting.endedAt && (
              <button className="primary-button" onClick={status === "error" ? meetingController.retryConnection : meetingController.resumeMeeting}>
                {status === "error" ? "检查后重试" : "继续本场"}
              </button>
            )}
            {meeting.endedAt && (
              <>
                <button className="primary-button" onClick={meetingController.exportDraft}>导出双语 Markdown</button>
                <button className="secondary-button" disabled={!hasDownloaded} onClick={confirmClear}>
                  确认并清除草稿
                </button>
              </>
            )}
          </footer>
        </section>
      )}
    </main>
  );
}

export default App;
