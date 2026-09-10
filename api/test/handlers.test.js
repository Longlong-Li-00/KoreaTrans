import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { hashPasswordForTest, verifySessionCookie } from "../src/lib/auth.js";
import { createHandlers } from "../src/handlers.js";
import { resetRateLimitsForTest } from "../src/lib/security.js";

const PASSWORD = "correct horse battery staple";
const SECRET = "a-test-secret-that-is-definitely-at-least-32-characters";
const ORIGIN = "https://translator.example.test";
let passwordHash;

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

  assert.equal(login.status, 204);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(verifySessionCookie(cookiePair, SECRET, clock), true);

  const session = await handlers.session(request({ cookie: cookiePair }));
  assert.deepEqual(session.jsonBody, { authenticated: true });
});

test("tampered and expired session cookies are rejected", async () => {
  const clock = 1_800_000_000_000;
  const handlers = createHandlers({ env: environment(), now: () => clock });
  const login = await handlers.login(request({ body: { password: PASSWORD } }));
  const cookiePair = login.headers["Set-Cookie"].split(";")[0];
  const tampered = `${cookiePair}x`;

  assert.equal((await handlers.session(request({ cookie: tampered }))).jsonBody.authenticated, false);
  assert.equal(verifySessionCookie(cookiePair, SECRET, clock + 13 * 60 * 60 * 1000), false);
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
