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

export function createSessionCookie(secret, nowMs = Date.now(), secure = true) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SESSION_SIGNING_SECRET must contain at least 32 characters");
  }
  const payload = encode(
    JSON.stringify({
      v: 1,
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
  if (typeof secret !== "string" || secret.length < 32) return false;
  const value = parseCookieHeader(cookieHeader)[COOKIE_NAME];
  if (!value) return false;

  const separator = value.lastIndexOf(".");
  if (separator < 1) return false;
  const payload = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  if (!safeCompare(suppliedSignature, signatureFor(payload, secret))) return false;

  try {
    const parsed = JSON.parse(decode(payload));
    const nowSeconds = Math.floor(nowMs / 1000);
    return parsed.v === 1 && Number.isInteger(parsed.exp) && parsed.exp > nowSeconds;
  } catch {
    return false;
  }
}

