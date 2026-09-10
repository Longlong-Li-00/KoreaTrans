import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this script through npm run dev");
const spawnOptions = { stdio: "inherit" };
const children = [
  spawn(process.execPath, [npmCli, "run", "dev:web"], spawnOptions),
  spawn(process.execPath, [npmCli, "run", "dev:api"], spawnOptions),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code !== 0) stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
