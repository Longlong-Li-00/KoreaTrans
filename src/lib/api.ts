import type { SpeechToken } from "../types";

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function parseError(response: Response) {
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    return new ApiError(body.code ?? "REQUEST_FAILED", body.message ?? "请求失败。", response.status);
  } catch {
    return new ApiError("REQUEST_FAILED", "请求失败。", response.status);
  }
}

async function apiFetch(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) throw await parseError(response);
  return response;
}

export async function checkSession() {
  const response = await apiFetch("/api/auth/session", { cache: "no-store" });
  return ((await response.json()) as { authenticated: boolean }).authenticated;
}

export async function login(password: string) {
  await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export async function logout() {
  await apiFetch("/api/auth/logout", { method: "POST" });
}

export async function fetchSpeechToken(): Promise<SpeechToken> {
  const response = await apiFetch("/api/speech/token", { method: "POST", cache: "no-store" });
  return (await response.json()) as SpeechToken;
}

