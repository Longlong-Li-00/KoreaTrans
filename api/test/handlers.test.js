import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { hashPasswordForTest, verifySessionCookie } from "../src/lib/auth.js";
import { createHandlers } from "../src/handlers.js";
import { resetRateLimitsForTest } from "../src/lib/security.js";

const PASSWORD = "correct horse battery staple";
const SECRET = "a-test-secret-that-is-definitely-at-least-32-characters";
const ORIGIN = "https://translator.example.test";
let passwordHash;
let testerHash;

function request({ origin = ORIGIN, cookie = "", body } = {}) {
  const headers = new Headers({ origin, cookie, "x-forwarded-for": "203.0.113.1" });
  return {
    headers,
    async json() {
      if (body === undefined) throw new Error("No body");
      return body;
    },
  };
}

function environment(overrides = {}) {
  return {
    APP_PASSWORD_SCRYPT_HASH: passwordHash,
    SESSION_SIGNING_SECRET: SECRET,
    AZURE_SPEECH_KEY: "azure-secret-never-return-this",
    AZURE_SPEECH_REGION: "koreacentral",
    APP_ALLOWED_ORIGINS: ORIGIN,
    APP_COOKIE_SECURE: "true",
    ...overrides,
  };
}

beforeEach(async () => {
  resetRateLimitsForTest();
  passwordHash = await hashPasswordForTest(PASSWORD, Buffer.alloc(16, 7));
  testerHash = await hashPasswordForTest("tester passphrase 12345", Buffer.alloc(16, 8));
});

test("login rejects untrusted origins", async () => {
  const handlers = createHandlers({ env: environment() });
  const result = await handlers.login(request({ origin: "https://evil.example", body: { password: PASSWORD } }));
  assert.equal(result.status, 403);
});

test("login rejects an incorrect password without exposing configuration", async () => {
  const handlers = createHandlers({ env: environment() });
  const result = await handlers.login(request({ body: { password: "wrong" } }));
  assert.equal(result.status, 401);
  assert.equal(result.jsonBody.code, "INVALID_CREDENTIALS");
  assert.equal(JSON.stringify(result).includes("azure-secret"), false);
});

test("login issues a signed HttpOnly cookie and session validates it", async () => {
  const clock = 1_800_000_000_000;
  const handlers = createHandlers({ env: environment(), now: () => clock });
  const login = await handlers.login(request({ body: { password: PASSWORD } }));
  const setCookie = login.headers["Set-Cookie"];
  const cookiePair = setCookie.split(";")[0];

  assert.equal(login.status, 200);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.deepEqual(verifySessionCookie(cookiePair, SECRET, clock), {
    id: "longlong",
    displayName: "Longlong",
    role: "owner",
  });

  const session = await handlers.session(request({ cookie: cookiePair }));
  assert.deepEqual(session.jsonBody, {
    authenticated: true,
    user: { id: "longlong", displayName: "Longlong", role: "owner" },
  });
});

test("tampered and expired session cookies are rejected", async () => {
  const clock = 1_800_000_000_000;
  const handlers = createHandlers({ env: environment(), now: () => clock });
  const login = await handlers.login(request({ body: { password: PASSWORD } }));
  const cookiePair = login.headers["Set-Cookie"].split(";")[0];
  const tampered = `${cookiePair}x`;

  assert.equal((await handlers.session(request({ cookie: tampered }))).jsonBody.authenticated, false);
  assert.equal(verifySessionCookie(cookiePair, SECRET, clock + 13 * 60 * 60 * 1000), null);
});

test("configured tester receives an isolated tester session", async () => {
  const clock = 1_800_000_000_000;
  const env = environment({
    APP_TEST_USERS_JSON: JSON.stringify({
      tester01: { displayName: "测试者 01", role: "tester", passwordHash: testerHash },
    }),
  });
  const handlers = createHandlers({ env, now: () => clock });
  const result = await handlers.login(request({
    body: { username: "Tester01", password: "tester passphrase 12345" },
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.jsonBody.user, { id: "tester01", displayName: "测试者 01", role: "tester" });
  const cookiePair = result.headers["Set-Cookie"].split(";")[0];
  assert.deepEqual((await handlers.session(request({ cookie: cookiePair }))).jsonBody.user, {
    id: "tester01",
    displayName: "测试者 01",
    role: "tester",
  });
});

test("speech token requires a valid session and returns no subscription key", async () => {
  const clock = 1_800_000_000_000;
  const env = environment();
  let upstreamRequest;
  const handlers = createHandlers({
    env,
    now: () => clock,
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return new Response("short-lived-token", { status: 200 });
    },
  });

  const unauthorized = await handlers.speechToken(request());
  assert.equal(unauthorized.status, 401);

  const login = await handlers.login(request({ body: { password: PASSWORD } }));
  const cookiePair = login.headers["Set-Cookie"].split(";")[0];
  const result = await handlers.speechToken(request({ cookie: cookiePair }));

  assert.equal(result.status, 200);
  assert.deepEqual(result.jsonBody, {
    token: "short-lived-token",
    region: "koreacentral",
    expiresAt: clock + 600_000,
  });
  assert.match(upstreamRequest.url, /^https:\/\/koreacentral\./);
  assert.equal(upstreamRequest.options.headers["Ocp-Apim-Subscription-Key"], env.AZURE_SPEECH_KEY);
  assert.equal(JSON.stringify(result).includes(env.AZURE_SPEECH_KEY), false);
});

test("speech provider errors are sanitized", async () => {
  const clock = 1_800_000_000_000;
  const handlers = createHandlers({
    env: environment(),
    now: () => clock,
    fetchImpl: async () => new Response("sensitive upstream detail", { status: 403 }),
  });
  const login = await handlers.login(request({ body: { password: PASSWORD } }));
  const cookiePair = login.headers["Set-Cookie"].split(";")[0];
  const result = await handlers.speechToken(request({ cookie: cookiePair }));

  assert.equal(result.status, 503);
  assert.equal(result.jsonBody.code, "SPEECH_TOKEN_FAILED");
  assert.equal(JSON.stringify(result).includes("sensitive upstream detail"), false);
});

test("usage summary aggregates stored listening seconds without exposing meeting content", async () => {
  const clock = Date.parse("2026-09-11T05:00:00.000Z");
  const recorded = [];
  const telemetryStore = {
    async recordUsage(entry) { recorded.push(entry); },
    async getMonthlyUsedSeconds() { return 3_660.4; },
  };
  const handlers = createHandlers({ env: environment(), now: () => clock, telemetryStore });
  const login = await handlers.login(request({ body: { username: "longlong", password: PASSWORD } }));
  const cookie = login.headers["Set-Cookie"].split(";")[0];
  const usageRequest = request({
    cookie,
    body: { meetingId: "meeting-123456", eventId: "event-12345678", seconds: 15.2 },
  });
  assert.equal((await handlers.usageRecord(usageRequest)).status, 204);
  assert.equal(recorded[0].userId, "longlong");
  assert.equal(recorded[0].seconds, 15.2);

  const summary = await handlers.usageSummary(request({ cookie }));
  assert.equal(summary.status, 200);
  assert.equal(summary.jsonBody.estimatedUsedSeconds, 3_660);
  assert.equal(summary.jsonBody.estimatedRemainingSeconds, 14_340);
  assert.equal(JSON.stringify(summary).includes("meeting-123456"), false);
});

test("feedback stores bounded diagnostics and only owner can export it", async () => {
  const clock = Date.parse("2026-09-11T05:00:00.000Z");
  const feedback = [];
  const telemetryStore = {
    async saveFeedback(entry) { feedback.push(entry); },
    async listFeedback() { return feedback; },
  };
  const env = environment({
    APP_TEST_USERS_JSON: JSON.stringify({
      tester01: { displayName: "测试者 01", role: "tester", passwordHash: testerHash },
    }),
  });
  const handlers = createHandlers({ env, now: () => clock, telemetryStore });
  const testerLogin = await handlers.login(request({
    body: { username: "tester01", password: "tester passphrase 12345" },
  }));
  const testerCookie = testerLogin.headers["Set-Cookie"].split(";")[0];
  const submitted = await handlers.feedbackSubmit(request({
    cookie: testerCookie,
    body: {
      rating: 4,
      category: "caption-stability",
      comment: "临时字幕比之前稳定。",
      status: "stopped",
      meetingDurationSeconds: 600,
      finalCaptionCount: 30,
      gapCount: 1,
      appVersion: "0.2.0",
    },
  }));
  assert.equal(submitted.status, 201);
  assert.equal(feedback[0].userId, "tester01");
  assert.equal(feedback[0].comment, "临时字幕比之前稳定。");
  assert.equal((await handlers.feedbackList(request({ cookie: testerCookie }))).status, 403);

  const ownerLogin = await handlers.login(request({ body: { username: "longlong", password: PASSWORD } }));
  const ownerCookie = ownerLogin.headers["Set-Cookie"].split(";")[0];
  const exported = await handlers.feedbackList(request({ cookie: ownerCookie }));
  assert.equal(exported.status, 200);
  assert.equal(exported.jsonBody.items.length, 1);
});
