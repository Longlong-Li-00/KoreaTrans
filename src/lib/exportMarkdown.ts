import type { MeetingDraft, TimelineItem } from "../types";
import { formatElapsed } from "./time";

function safeText(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function renderItem(item: TimelineItem) {
  if (item.kind === "gap") {
    const end = item.endMs === null ? "未恢复" : formatElapsed(item.endMs);
    return `> ⚠️ 未翻译区间 ${formatElapsed(item.startMs)}–${end}：${safeText(item.reason)}`;
  }

  if (item.kind === "pause") {
    const end = item.endMs === null ? "尚未继续" : formatElapsed(item.endMs);
    return `> ⏸️ 主动暂停 ${formatElapsed(item.startMs)}–${end}：暂停期间未使用麦克风或翻译额度`;
  }

  return [
    `### ${formatElapsed(item.startMs)}–${formatElapsed(item.endMs)}`,
    "",
    safeText(item.translationZhHans) || "（无中文译文）",
    "",
    `<small lang="ko">${safeText(item.sourceKo) || "（无韩文转写）"}</small>`,
  ].join("\n");
}

export function buildMeetingMarkdown(draft: MeetingDraft) {
  const start = new Date(draft.startedAt);
  const end = draft.endedAt ? new Date(draft.endedAt) : null;
  const durationMs = end ? Math.max(0, end.getTime() - start.getTime()) : 0;

  return [
    "# 韩语会议实时翻译记录",
    "",
    `- 开始时间：${start.toLocaleString("zh-CN", { timeZone: "Asia/Seoul" })}（Asia/Seoul）`,
    `- 结束时间：${end ? end.toLocaleString("zh-CN", { timeZone: "Asia/Seoul" }) : "未记录"}`,
    `- 会话时长：${formatElapsed(durationMs)}`,
    "- 语言：韩语（ko-KR）→ 简体中文（zh-Hans）",
    "- 服务：Azure Speech Translation",
    `- 应用版本：${draft.appVersion}`,
    "",
    "> 本文件由自动语音识别和机器翻译生成，未经韩中双语人工校验。它仅用于辅助理解，不能视为逐字会议纪要、法律记录或可直接引用的学术材料。",
    "",
    "## 双语字幕",
    "",
    draft.items.length ? draft.items.map(renderItem).join("\n\n") : "（本场没有已确认字幕）",
    "",
  ].join("\n");
}

export function downloadMeetingMarkdown(draft: MeetingDraft) {
  const text = buildMeetingMarkdown(draft);
  const blob = new Blob(["\uFEFF", text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = draft.startedAt.slice(0, 19).replaceAll(":", "-");
  anchor.href = url;
  anchor.download = `korean-meeting-${stamp}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
