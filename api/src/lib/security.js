const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failuresByClient = new Map();

export function allowedOrigins(env) {
  return new Set(
    (env.APP_ALLOWED_ORIGINS ?? "http://localhost:4280,http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function hasAllowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  return Boolean(origin && allowedOrigins(env).has(origin));
}

export function clientKey(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-client-ip") ||
    "unknown"
  );
}

export function isLoginRateLimited(key, nowMs = Date.now()) {
  const current = failuresByClient.get(key);
  if (!current) return false;
  if (nowMs - current.startedAt >= WINDOW_MS) {
    failuresByClient.delete(key);
    return false;
  }
  return current.count >= MAX_FAILURES;
}

export function noteLoginFailure(key, nowMs = Date.now()) {
  const current = failuresByClient.get(key);
  if (!current || nowMs - current.startedAt >= WINDOW_MS) {
    failuresByClient.set(key, { count: 1, startedAt: nowMs });
    return;
  }
  current.count += 1;
}

export function clearLoginFailures(key) {
  failuresByClient.delete(key);
}

export function resetRateLimitsForTest() {
  failuresByClient.clear();
}

