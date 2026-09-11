import {
  clearSessionCookie,
  configuredUsers,
  createSessionCookie,
  normalizeUserId,
  verifyPassword,
  verifySessionCookie,
} from "./lib/auth.js";
import { randomUUID } from "node:crypto";
import {
  clearLoginFailures,
  clientKey,
  hasAllowedOrigin,
  isLoginRateLimited,
  noteLoginFailure,
} from "./lib/security.js";
import { createTelemetryStore, utcMonthRange } from "./lib/telemetry-store.js";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

function json(status, body, headers = {}) {
  return {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers },
    jsonBody: body,
  };
}

function secureCookies(env) {
  return env.APP_COOKIE_SECURE !== "false";
}

function configurationIsValid(env) {
  return Boolean(
    configuredUsers(env).size > 0 &&
      env.SESSION_SIGNING_SECRET?.length >= 32 &&
      env.AZURE_SPEECH_KEY &&
      env.AZURE_SPEECH_REGION,
  );
}

function sessionFor(request, env, nowMs) {
  return verifySessionCookie(request.headers.get("cookie"), env.SESSION_SIGNING_SECRET, nowMs);
}

function publicUser(user) {
  return user
    ? { id: user.id, displayName: user.displayName, role: user.role }
    : null;
}

function monthlyLimitSeconds(env) {
  const configured = Number(env.AZURE_SPEECH_MONTHLY_LIMIT_SECONDS || 18_000);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 18_000;
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

const FEEDBACK_CATEGORIES = new Set([
  "translation",
  "latency",
  "caption-stability",
  "connection",
  "interface",
  "other",
]);

export function createHandlers({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  telemetryStore: suppliedTelemetryStore,
} = {}) {
  const telemetryStore =
    suppliedTelemetryStore === undefined ? createTelemetryStore(env) : suppliedTelemetryStore;

  return {
    async login(request) {
      if (!hasAllowedOrigin(request, env)) {
        return json(403, { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。" });
      }
      if (!configurationIsValid(env)) {
        return json(503, { code: "CONFIG_ERROR", message: "服务尚未完成安全配置。" });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const userId = normalizeUserId(body?.username || "longlong");
      const key = `${clientKey(request)}:${userId || "invalid"}`;
      if (isLoginRateLimited(key, now())) {
        return json(429, { code: "RATE_LIMITED", message: "尝试次数过多，请稍后再试。" });
      }

      const users = configuredUsers(env);
      const user = users.get(userId);
      const comparisonHash = user?.passwordHash || users.values().next().value?.passwordHash;
      const valid = await verifyPassword(body?.password, comparisonHash);
      if (!valid || !user) {
        noteLoginFailure(key, now());
        return json(401, { code: "INVALID_CREDENTIALS", message: "用户名或访问口令不正确。" });
      }

      clearLoginFailures(key);
      return json(
        200,
        { authenticated: true, user: publicUser(user) },
        {
          "Set-Cookie": createSessionCookie(
            env.SESSION_SIGNING_SECRET,
            user,
            now(),
            secureCookies(env),
          ),
        },
      );
    },

    async session(request) {
      const user = sessionFor(request, env, now());
      return json(200, { authenticated: Boolean(user), user: publicUser(user) });
    },

    async logout(request) {
      if (!hasAllowedOrigin(request, env)) {
        return json(403, { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。" });
      }
      return {
        status: 204,
        headers: {
          ...NO_STORE_HEADERS,
          "Set-Cookie": clearSessionCookie(secureCookies(env)),
        },
      };
    },

    async speechToken(request) {
      if (!hasAllowedOrigin(request, env)) {
        return json(403, { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。" });
      }
      if (!configurationIsValid(env)) {
        return json(503, { code: "CONFIG_ERROR", message: "服务尚未完成安全配置。" });
      }
      if (!sessionFor(request, env, now())) {
        return json(401, { code: "UNAUTHORIZED", message: "登录已失效，请重新登录。" });
      }

      const region = env.AZURE_SPEECH_REGION;
      try {
        const response = await fetchImpl(
          `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
          {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
              "Content-Length": "0",
            },
          },
        );
        if (!response.ok) throw new Error("Azure token endpoint rejected the request");
        const token = await response.text();
        if (!token) throw new Error("Azure token endpoint returned an empty token");

        return json(200, {
          token,
          region,
          expiresAt: now() + 10 * 60 * 1000,
        });
      } catch {
        return json(503, {
          code: "SPEECH_TOKEN_FAILED",
          message: "暂时无法连接翻译服务，请稍后重试。",
        });
      }
    },

    async usageSummary(request) {
      const user = sessionFor(request, env, now());
      if (!user) {
        return json(401, { code: "UNAUTHORIZED", message: "登录已失效，请重新登录。" });
      }
      const limitSeconds = monthlyLimitSeconds(env);
      const instant = new Date(now());
      const period = utcMonthRange(instant);
      if (!telemetryStore) {
        return json(200, {
          available: false,
          source: "application_estimate",
          monthlyLimitSeconds: limitSeconds,
          estimatedUsedSeconds: null,
          estimatedRemainingSeconds: null,
          periodStart: period.start,
          periodEnd: period.end,
          asOf: instant.toISOString(),
        });
      }
      try {
        const usedSeconds = Math.max(0, await telemetryStore.getMonthlyUsedSeconds(instant));
        return json(200, {
          available: true,
          source: "application_estimate",
          monthlyLimitSeconds: limitSeconds,
          estimatedUsedSeconds: Math.round(usedSeconds),
          estimatedRemainingSeconds: Math.max(0, Math.round(limitSeconds - usedSeconds)),
          periodStart: period.start,
          periodEnd: period.end,
          asOf: instant.toISOString(),
        });
      } catch {
        return json(503, { code: "USAGE_UNAVAILABLE", message: "暂时无法读取额度估算。" });
      }
    },

    async usageRecord(request) {
      if (!hasAllowedOrigin(request, env)) {
        return json(403, { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。" });
      }
      const user = sessionFor(request, env, now());
      if (!user) {
        return json(401, { code: "UNAUTHORIZED", message: "登录已失效，请重新登录。" });
      }
      if (!telemetryStore) {
        return json(503, { code: "USAGE_UNAVAILABLE", message: "额度估算尚未配置。" });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const identifierPattern = /^[a-zA-Z0-9-]{10,80}$/;
      const seconds = Number(body?.seconds);
      if (
        !identifierPattern.test(body?.meetingId || "") ||
        !identifierPattern.test(body?.eventId || "") ||
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > 60
      ) {
        return json(400, { code: "INVALID_USAGE_EVENT", message: "用量事件格式无效。" });
      }
      try {
        await telemetryStore.recordUsage({
          userId: user.id,
          meetingId: body.meetingId,
          eventId: body.eventId,
          seconds: Math.round(seconds * 10) / 10,
          recordedAt: new Date(now()),
        });
        return { status: 204, headers: NO_STORE_HEADERS };
      } catch {
        return json(503, { code: "USAGE_RECORD_FAILED", message: "暂时无法更新额度估算。" });
      }
    },

    async feedbackSubmit(request) {
      if (!hasAllowedOrigin(request, env)) {
        return json(403, { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。" });
      }
      const user = sessionFor(request, env, now());
      if (!user) {
        return json(401, { code: "UNAUTHORIZED", message: "登录已失效，请重新登录。" });
      }
      if (!telemetryStore) {
        return json(503, { code: "FEEDBACK_UNAVAILABLE", message: "反馈服务尚未配置。" });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const rating = Number(body?.rating);
      const category = FEEDBACK_CATEGORIES.has(body?.category) ? body.category : "";
      const comment = typeof body?.comment === "string" ? body.comment.trim().slice(0, 1_000) : "";
      if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !category || comment.length < 2) {
        return json(400, { code: "INVALID_FEEDBACK", message: "请填写评分、类别和具体意见。" });
      }
      try {
        await telemetryStore.saveFeedback({
          id: randomUUID(),
          userId: user.id,
          displayName: user.displayName,
          rating,
          category,
          comment,
          status: typeof body?.status === "string" ? body.status.slice(0, 32) : "unknown",
          meetingDurationSeconds: boundedInteger(body?.meetingDurationSeconds, 0, 14_400),
          finalCaptionCount: boundedInteger(body?.finalCaptionCount, 0, 10_000),
          gapCount: boundedInteger(body?.gapCount, 0, 1_000),
          appVersion: typeof body?.appVersion === "string" ? body.appVersion.slice(0, 32) : "unknown",
          createdAt: new Date(now()),
        });
        return json(201, { accepted: true });
      } catch {
        return json(503, { code: "FEEDBACK_FAILED", message: "反馈暂时未能保存，请稍后重试。" });
      }
    },

    async feedbackList(request) {
      const user = sessionFor(request, env, now());
      if (!user) {
        return json(401, { code: "UNAUTHORIZED", message: "登录已失效，请重新登录。" });
      }
      if (user.role !== "owner") {
        return json(403, { code: "FORBIDDEN", message: "只有所有者可以导出测试反馈。" });
      }
      if (!telemetryStore) {
        return json(503, { code: "FEEDBACK_UNAVAILABLE", message: "反馈服务尚未配置。" });
      }
      try {
        return json(200, { items: await telemetryStore.listFeedback(200) });
      } catch {
        return json(503, { code: "FEEDBACK_UNAVAILABLE", message: "暂时无法读取测试反馈。" });
      }
    },
  };
}
