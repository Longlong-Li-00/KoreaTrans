import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  checkSession,
  fetchFeedback,
  fetchUsageSummary,
  login,
  logout,
  submitFeedback,
} from "./lib/api";
import { formatElapsed } from "./lib/time";
import { useMeetingController } from "./hooks/useMeetingController";
import type { AuthUser, FeedbackPayload, SessionStatus, TimelineItem, UsageSummary } from "./types";
import "./styles.css";

type AuthenticationState = "checking" | "signed_out" | "signed_in";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "准备就绪",
  requesting_permission: "等待麦克风",
  connecting: "正在连接",
  listening: "正在收听",
  paused: "已主动暂停",
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
  onSignedIn: (user: AuthUser) => void;
}) {
  const [username, setUsername] = useState(() => localStorage.getItem("klt-last-user") || "longlong");
  const [password, setPassword] = useState("");
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const error = submissionError ?? initialError;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmissionError(null);
    try {
      const session = await login(username, password);
      if (!session.user) throw new Error("登录响应缺少用户信息。");
      localStorage.setItem("klt-last-user", session.user.id);
      setPassword("");
      onSignedIn(session.user);
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
            <label htmlFor="username">测试账号</label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              minLength={2}
              maxLength={32}
              pattern="[A-Za-z0-9._-]+"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="例如 tester01"
              required
            />
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
            <button className="primary-button wide" disabled={submitting || username.length < 2 || password.length < 16}>
              {submitting ? "正在登录…" : "进入翻译台"}
            </button>
          </form>
        )}
        <p className="privacy-footnote">账号和口令只通过 HTTPS 发往 Azure Function；Azure Speech 密钥不会进入浏览器。</p>
        <p className="maker-watermark">longlong · beta</p>
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

  if (item.kind === "pause") {
    return (
      <article className="pause-card" aria-label="主动暂停区间">
        <span>主动暂停</span>
        <strong>
          {formatElapsed(item.startMs)} — {item.endMs === null ? "尚未继续" : formatElapsed(item.endMs)}
        </strong>
        <p>此期间未使用麦克风或翻译额度，仍计入同一场会议的时间线。</p>
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

function formatQuota(seconds: number | null) {
  if (seconds === null) return "暂不可用";
  const roundedMinutes = Math.max(0, Math.ceil(seconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours === 0) return `${minutes} 分钟`;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

function FeedbackPanel({
  diagnostics,
  onClose,
}: {
  diagnostics: Omit<FeedbackPayload, "rating" | "category" | "comment">;
  onClose: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [category, setCategory] = useState("caption-stability");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      await submitFeedback({ ...diagnostics, rating, category, comment });
      setMessage("反馈已保存，谢谢你的测试。");
      setComment("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "反馈提交失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">BETA FEEDBACK</p>
            <h2 id="feedback-title">告诉我实际使用感受</h2>
          </div>
          <button className="quiet-button" type="button" onClick={onClose} aria-label="关闭反馈窗口">关闭</button>
        </div>
        <form onSubmit={submit}>
          <fieldset className="rating-field">
            <legend>整体可用性评分</legend>
            <div className="rating-options">
              {[1, 2, 3, 4, 5].map((value) => (
                <label key={value} className={rating === value ? "selected" : ""}>
                  <input
                    type="radio"
                    name="rating"
                    value={value}
                    checked={rating === value}
                    onChange={() => setRating(value)}
                  />
                  {value}
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor="feedback-category">主要反馈类别</label>
          <select id="feedback-category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="caption-stability">字幕稳定性</option>
            <option value="translation">翻译理解度</option>
            <option value="latency">显示延迟</option>
            <option value="connection">连接或麦克风</option>
            <option value="interface">界面与操作</option>
            <option value="other">其他</option>
          </select>
          <label htmlFor="feedback-comment">具体意见</label>
          <textarea
            id="feedback-comment"
            value={comment}
            minLength={2}
            maxLength={1_000}
            rows={5}
            onChange={(event) => setComment(event.target.value)}
            placeholder="例如：临时字幕仍跳动较多；断网恢复正常；某些科研术语难以理解……"
            required
          />
          <p className="feedback-privacy">
            自动附带版本、状态、时长、最终字幕条数和断档数；不会上传音频或字幕内容。
          </p>
          {message && <p className="feedback-message" role="status">{message}</p>}
          <button className="primary-button wide" disabled={submitting || rating === 0 || comment.trim().length < 2}>
            {submitting ? "正在提交…" : "提交反馈"}
          </button>
        </form>
      </section>
    </div>
  );
}

function safeCsvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function downloadFeedbackExport() {
  const entries = await fetchFeedback();
  const columns = [
    "createdAt", "userId", "displayName", "rating", "category", "comment", "status",
    "meetingDurationSeconds", "finalCaptionCount", "gapCount", "appVersion",
  ] as const;
  const rows = [
    columns.map(safeCsvCell).join(","),
    ...entries.map((entry) => columns.map((column) => safeCsvCell(entry[column])).join(",")),
  ];
  const blob = new Blob(["\uFEFF", rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `koreatrans-feedback-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [authState, setAuthState] = useState<AuthenticationState>("checking");
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageUnavailable, setUsageUnavailable] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [ownerMessage, setOwnerMessage] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const meetingController = useMeetingController(() => {
    setAuthState("signed_out");
    setCurrentUser(null);
    setAuthError("登录已过期，请重新登录后恢复本场草稿。");
  });

  const refreshUsage = useCallback(() => {
    if (authState !== "signed_in") return;
    fetchUsageSummary()
      .then((summary) => {
        setUsageSummary(summary);
        setUsageUnavailable(!summary.available);
      })
      .catch(() => setUsageUnavailable(true));
  }, [authState]);

  useEffect(() => {
    checkSession()
      .then((session) => {
        setCurrentUser(session.user);
        setAuthState(session.authenticated && session.user ? "signed_in" : "signed_out");
      })
      .catch(() => {
        setAuthState("signed_out");
        setAuthError("无法连接登录服务。请确认 Azure API 已部署并刷新页面。");
      });
  }, []);

  useEffect(() => {
    if (authState !== "signed_in") return;
    refreshUsage();
    const timer = window.setInterval(refreshUsage, 30_000);
    window.addEventListener("klt-usage-updated", refreshUsage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("klt-usage-updated", refreshUsage);
    };
  }, [authState, refreshUsage]);

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
    setCurrentUser(null);
    setUsageSummary(null);
    setConsentConfirmed(false);
  }

  async function exportFeedback() {
    setOwnerMessage(null);
    try {
      await downloadFeedbackExport();
    } catch (cause) {
      setOwnerMessage(cause instanceof Error ? cause.message : "反馈导出失败。");
    }
  }

  async function confirmClear() {
    if (!meetingController.hasDownloaded) return;
    const confirmed = window.confirm(
      "确认已经保存导出的 Markdown 文件，并删除这台设备上的临时字幕草稿？此操作不可撤销。",
    );
    if (confirmed) await meetingController.clearCurrentDraft();
  }

  async function discardSavedDraft(id: string) {
    const confirmed = window.confirm("确认删除这份本地会议草稿？此操作不可撤销。");
    if (confirmed) await meetingController.discardRecoverableDraft(id);
  }

  async function startAnotherMeeting() {
    const confirmed = window.confirm(
      "上一场会议会保留在本机草稿中。开始前，请再次确认本场所有参会者均已同意云端语音翻译。",
    );
    if (confirmed) await meetingController.beginMeeting();
  }

  if (authState !== "signed_in") {
    return (
      <LoginScreen
        checking={authState === "checking"}
        initialError={authError}
        onSignedIn={(user) => {
          setAuthError(null);
          setCurrentUser(user);
          setAuthState("signed_in");
        }}
      />
    );
  }

  const {
    captions,
    meeting,
    recoverableDrafts,
    status,
    runtimeMessage,
    elapsedMs,
    draftError,
    hasDownloaded,
  } = meetingController;
  const isRunning = status === "listening" || status === "connecting" || status === "requesting_permission" || status === "reconnecting";
  const canResume = Boolean(meeting && !meeting.endedAt && !isRunning && status !== "paused");
  const finalCaptionCount = captions.items.filter((item) => item.kind === "caption").length;
  const gapCount = captions.items.filter((item) => item.kind === "gap").length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">KO → 简体中文</p>
          <h1>实时翻译台</h1>
          <p className="maker-watermark">longlong · beta</p>
        </div>
        <div className="topbar-actions">
          <span className="user-chip" title={currentUser?.id}>{currentUser?.displayName}</span>
          <button className="quiet-button" onClick={() => setFeedbackOpen(true)}>反馈</button>
          <button className="quiet-button" onClick={signOut}>退出</button>
        </div>
      </header>

      <section className="quota-card" aria-label="本月翻译额度估算">
        <div>
          <span>F0 本月预计剩余</span>
          <strong>
            {usageUnavailable
              ? "暂不可用"
              : usageSummary
                ? `≈ ${formatQuota(usageSummary.estimatedRemainingSeconds)}`
                : "正在读取…"}
          </strong>
        </div>
        <button className="quota-refresh" type="button" onClick={refreshUsage}>刷新</button>
        <p>仅统计此功能上线后的本应用有效收听时间；Azure Portal 计量是最终依据。</p>
      </section>

      {currentUser?.role === "owner" && (
        <div className="owner-tools">
          <button className="quiet-button" type="button" onClick={exportFeedback}>导出测试反馈</button>
          {ownerMessage && <span role="alert">{ownerMessage}</span>}
        </div>
      )}

      {!meeting && recoverableDrafts.length > 0 && (
        <section className="drafts-panel" aria-labelledby="drafts-title">
          <div className="drafts-heading">
            <div>
              <p className="eyebrow">本机临时保存</p>
              <h2 id="drafts-title">会议草稿（{recoverableDrafts.length}）</h2>
            </div>
            <p>草稿不会阻止开始新会议；完成后请及时导出或删除。</p>
          </div>
          <div className="draft-list">
            {recoverableDrafts.map((draft) => {
              const captionCount = draft.items.filter((item) => item.kind === "caption").length;
              return (
                <article className="recovery-card" key={draft.id}>
                  <span className="recovery-icon" aria-hidden="true">↻</span>
                  <div>
                    <h3>{new Date(draft.startedAt).toLocaleString("zh-CN")}</h3>
                    <p>{draft.endedAt ? "已结束" : "未结束"} · {captionCount} 条字幕</p>
                    <div className="button-row">
                      <button className="primary-button" onClick={() => meetingController.recoverDraft(draft.id)}>打开草稿</button>
                      <button className="secondary-button" onClick={() => discardSavedDraft(draft.id)}>删除</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {!meeting && (
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
        <section className={`meeting-console ${meeting.endedAt ? "is-ended" : ""}`}>
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
              <button className="pause-button" onClick={meetingController.pauseMeeting}>
                <span aria-hidden="true">Ⅱ</span> 暂停翻译
              </button>
            )}
            {status === "paused" && !meeting.endedAt && (
              <button className="primary-button" onClick={meetingController.resumePausedMeeting}>
                继续翻译
              </button>
            )}
            {!meeting.endedAt && (
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
                <button className="secondary-button" onClick={startAnotherMeeting}>
                  保留草稿，开始新会议
                </button>
              </>
            )}
          </footer>
        </section>
      )}

      {feedbackOpen && (
        <FeedbackPanel
          diagnostics={{
            status,
            meetingDurationSeconds: Math.round(elapsedMs / 1_000),
            finalCaptionCount,
            gapCount,
            appVersion: __APP_VERSION__,
          }}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </main>
  );
}

export default App;
