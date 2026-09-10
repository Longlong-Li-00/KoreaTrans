import { randomBytes, scryptSync } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

const reader = createInterface({ input: stdin, output: stdout });
const password = await reader.question("Personal passphrase (16+ characters): ");
reader.close();

if (password.length < 16 || password.length > 256) {
  console.error("Passphrase must contain between 16 and 256 characters.");
  process.exitCode = 1;
} else {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N, r, p });
  console.log(`scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derived.toString("base64url")}`);
}
