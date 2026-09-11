import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "klt_session";
const SESSION_SECONDS = 12 * 60 * 60;
const HASH_BYTES = 64;
const USER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const LEGACY_USER = Object.freeze({ id: "longlong", displayName: "Longlong", role: "owner" });

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signatureFor(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeCompare(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || password.length < 1 || password.length > 256) return false;
  if (typeof storedHash !== "string") return false;

  const [algorithm, nText, rText, pText, saltText, hashText] = storedHash.split("$");
  if (algorithm !== "scrypt" || !nText || !rText || !pText || !saltText || !hashText) return false;

  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || N > 131072) {
    return false;
  }

  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (expected.length !== HASH_BYTES || salt.length < 16) return false;
    const actual = await scrypt(password, salt, HASH_BYTES, { N, r, p });
    return safeCompare(actual, expected);
  } catch {
    return false;
  }
}

export async function hashPasswordForTest(password, salt = randomBytes(16)) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const derived = await scrypt(password, salt, HASH_BYTES, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function normalizeUserId(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return USER_ID_PATTERN.test(normalized) ? normalized : "";
}

export function configuredUsers(env) {
  const users = new Map();
  if (env.APP_PASSWORD_SCRYPT_HASH) {
    users.set(LEGACY_USER.id, { ...LEGACY_USER, passwordHash: env.APP_PASSWORD_SCRYPT_HASH });
  }

  if (!env.APP_TEST_USERS_JSON) return users;
  try {
    const parsed = JSON.parse(env.APP_TEST_USERS_JSON);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return users;
    for (const [rawId, entry] of Object.entries(parsed).slice(0, 25)) {
      const id = normalizeUserId(rawId);
      if (!id || !entry || typeof entry !== "object" || entry.enabled === false) continue;
      const displayName = typeof entry.displayName === "string" ? entry.displayName.trim() : id;
      const role = entry.role === "owner" ? "owner" : "tester";
      if (
        displayName.length < 1 ||
        displayName.length > 40 ||
        typeof entry.passwordHash !== "string"
      ) continue;
      users.set(id, { id, displayName, role, passwordHash: entry.passwordHash });
    }
  } catch {
    // A malformed optional registry must not expose configuration details.
  }
  return users;
}

export function createSessionCookie(secret, user, nowMs = Date.now(), secure = true) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SESSION_SIGNING_SECRET must contain at least 32 characters");
  }
  const id = normalizeUserId(user?.id);
  if (!id) throw new Error("A valid user id is required");
  const payload = encode(
    JSON.stringify({
      v: 2,
      sub: id,
      name: String(user?.displayName || id).slice(0, 40),
      role: user?.role === "owner" ? "owner" : "tester",
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + SESSION_SECONDS,
      nonce: randomBytes(12).toString("base64url"),
    }),
  );
  const value = `${payload}.${signatureFor(payload, secret)}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict`;
}

export function clearSessionCookie(secure = true) {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict`;
}

export function parseCookieHeader(header) {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

export function verifySessionCookie(cookieHeader, secret, nowMs = Date.now()) {
  if (typeof secret !== "string" || secret.length < 32) return null;
  const value = parseCookieHeader(cookieHeader)[COOKIE_NAME];
  if (!value) return null;

  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  if (!safeCompare(suppliedSignature, signatureFor(payload, secret))) return null;

  try {
    const parsed = JSON.parse(decode(payload));
    const nowSeconds = Math.floor(nowMs / 1000);
    if (!Number.isInteger(parsed.exp) || parsed.exp <= nowSeconds) return null;
    if (parsed.v === 1) return LEGACY_USER;
    const id = normalizeUserId(parsed.sub);
    if (parsed.v !== 2 || !id) return null;
    return {
      id,
      displayName:
        typeof parsed.name === "string" && parsed.name.trim()
          ? parsed.name.trim().slice(0, 40)
          : id,
      role: parsed.role === "owner" ? "owner" : "tester",
    };
  } catch {
    return null;
  }
}
