import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;
const count = Number(process.argv[2] || 5);

if (!Number.isInteger(count) || count < 1 || count > 20) {
  throw new Error("Tester count must be an integer between 1 and 20.");
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

const users = {};
const credentialLines = [
  "KoreaTrans 测试账号（请分别私下发送，不要提交到 Git）",
  `生成时间：${new Date().toISOString()}`,
  "",
];

for (let index = 1; index <= count; index += 1) {
  const suffix = String(index).padStart(2, "0");
  const id = `tester${suffix}`;
  const password = randomBytes(18).toString("base64url");
  users[id] = {
    displayName: `测试者 ${suffix}`,
    role: "tester",
    enabled: true,
    passwordHash: hashPassword(password),
  };
  credentialLines.push(`${id}  ${password}`);
}

const privateDirectory = resolve("private");
await mkdir(privateDirectory, { recursive: true });
await writeFile(
  resolve(privateDirectory, "tester-credentials.txt"),
  `${credentialLines.join("\r\n")}\r\n`,
  { encoding: "utf8", mode: 0o600 },
);
await writeFile(
  resolve(privateDirectory, "app-test-users.json"),
  JSON.stringify(users),
  { encoding: "utf8", mode: 0o600 },
);

console.log("Generated private/tester-credentials.txt and private/app-test-users.json.");
console.log("Both paths are ignored by Git. Keep them private.");
