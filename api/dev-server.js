import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandlers } from "./src/handlers.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const localSettingsPath = resolve(root, "local.settings.json");

if (existsSync(localSettingsPath)) {
  const settings = JSON.parse(readFileSync(localSettingsPath, "utf8"));
  for (const [key, value] of Object.entries(settings.Values ?? {})) {
    if (process.env[key] === undefined) process.env[key] = String(value);
  }
}

const handlers = createHandlers();
const routes = new Map([
  ["POST /api/auth/login", handlers.login],
  ["GET /api/auth/session", handlers.session],
  ["POST /api/auth/logout", handlers.logout],
  ["POST /api/speech/token", handlers.speechToken],
]);

function parseCookies(value = "") {
  return Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:7071");
  const handler = routes.get(`${request.method} ${url.pathname}`);
  if (!handler) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    const body = request.method === "POST" ? await readJson(request) : {};
    const result = await handler({
      method: request.method,
      headers: new Headers(request.headers),
      cookies: parseCookies(request.headers.cookie),
      json: async () => body,
    });
    response.writeHead(result.status ?? 200, result.headers ?? {});
    response.end(result.jsonBody === undefined ? "" : JSON.stringify(result.jsonBody));
  } catch {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Unexpected server error" }));
  }
});

server.listen(7071, "127.0.0.1", () => {
  console.log("Local API ready at http://127.0.0.1:7071");
});
