import {
  clearSessionCookie,
  createSessionCookie,
  verifyPassword,
  verifySessionCookie,
} from "./lib/auth.js";
import {
  clearLoginFailures,
  clientKey,
  hasAllowedOrigin,
  isLoginRateLimited,
  noteLoginFailure,
} from "./lib/security.js";

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
    env.APP_PASSWORD_SCRYPT_HASH &&
      env.SESSION_SIGNING_SECRET?.length >= 32 &&
      env.AZURE_SPEECH_KEY &&
      env.AZURE_SPEECH_REGION,
  );
}

function authenticated(request, env, nowMs) {
  return verifySessionCookie(request.headers.get("cookie"), env.SESSION_SIGNING_SECRET, nowMs);
}

export function createHandlers({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  return {
    async login(request) {
      if (!hasAllowedOrigin(request, env)) {
        return json(403, { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。" });
      }
      if (!configurationIsValid(env)) {
        return json(503, { code: "CONFIG_ERROR", message: "服务尚未完成安全配置。" });
      }

      const key = clientKey(request);
      if (isLoginRateLimited(key, now())) {
        return json(429, { code: "RATE_LIMITED", message: "尝试次数过多，请稍后再试。" });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const valid = await verifyPassword(body?.password, env.APP_PASSWORD_SCRYPT_HASH);
      if (!valid) {
        noteLoginFailure(key, now());
        return json(401, { code: "INVALID_CREDENTIALS", message: "口令不正确。" });
      }

      clearLoginFailures(key);
      return {
        status: 204,
        headers: {
          ...NO_STORE_HEADERS,
          "Set-Cookie": createSessionCookie(env.SESSION_SIGNING_SECRET, now(), secureCookies(env)),
        },
      };
    },

    async session(request) {
      return json(200, { authenticated: authenticated(request, env, now()) });
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
      if (!authenticated(request, env, now())) {
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
  };
}

