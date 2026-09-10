import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSpeechToken } from "../lib/api";
import { AzureSpeechTranslator } from "../lib/speechTranslator";

let latestRecognizer: {
  recognizing?: (sender: unknown, event: { result: TestResult }) => void;
  recognized?: (sender: unknown, event: { result: TestResult }) => void;
  canceled?: (sender: unknown, event: { result: TestResult; reason: number }) => void;
  sessionStopped?: () => void;
  authorizationToken?: string;
} | null = null;

interface TestResult {
  text: string;
  translations: Map<string, string>;
  offset: number;
  duration: number;
  resultId: string;
  reason: number;
}

function recordRecognizer(recognizer: NonNullable<typeof latestRecognizer>) {
  latestRecognizer = recognizer;
}

vi.mock("../lib/api", () => ({ fetchSpeechToken: vi.fn() }));

vi.mock("microsoft-cognitiveservices-speech-sdk", () => {
  class SpeechTranslationConfig {
    speechRecognitionLanguage = "";
    static fromAuthorizationToken() {
      return new SpeechTranslationConfig();
    }
    addTargetLanguage() {}
  }

  class TranslationRecognizer {
    authorizationToken = "";
    recognizing?: (sender: unknown, event: { result: TestResult }) => void;
    recognized?: (sender: unknown, event: { result: TestResult }) => void;
    canceled?: (sender: unknown, event: { result: TestResult; reason: number }) => void;
    sessionStopped?: () => void;
    constructor() {
      recordRecognizer(this);
    }
    startContinuousRecognitionAsync(success: () => void) {
      success();
    }
    stopContinuousRecognitionAsync(success: () => void) {
      success();
    }
    close() {}
  }

  return {
    SpeechTranslationConfig,
    AudioConfig: { fromDefaultMicrophoneInput: () => ({}) },
    TranslationRecognizer,
    ResultReason: { TranslatedSpeech: 1 },
    CancellationReason: { Error: 1 },
    CancellationDetails: { fromResult: () => ({ ErrorCode: 7 }) },
  };
});

const tokenMock = vi.mocked(fetchSpeechToken);

beforeEach(() => {
  latestRecognizer = null;
  tokenMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T01:00:00.000Z"));
});

describe("AzureSpeechTranslator", () => {
  it("传递临时/最终结果，在第八分钟刷新令牌，并对断连只报告一次", async () => {
    const now = Date.now();
    tokenMock
      .mockResolvedValueOnce({ token: "token-1", region: "koreacentral", expiresAt: now + 600_000 })
      .mockResolvedValueOnce({ token: "token-2", region: "koreacentral", expiresAt: now + 1_080_000 });
    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onDisconnected: vi.fn(),
      onTokenError: vi.fn(),
    };
    const translator = new AzureSpeechTranslator(callbacks);
    await translator.start();

    const result: TestResult = {
      text: "실험을 시작합니다.",
      translations: new Map([["zh-Hans", "开始实验。"]]),
      offset: 10_000_000,
      duration: 20_000_000,
      resultId: "result-1",
      reason: 1,
    };
    latestRecognizer!.recognizing?.(null, { result });
    latestRecognizer!.recognized?.(null, { result });
    expect(callbacks.onInterim).toHaveBeenCalledWith(expect.objectContaining({ startMs: 1_000 }));
    expect(callbacks.onFinal).toHaveBeenCalledWith(expect.objectContaining({ id: "result-1", endMs: 3_000 }));

    await vi.advanceTimersByTimeAsync(480_000);
    expect(tokenMock).toHaveBeenCalledTimes(2);
    expect(latestRecognizer!.authorizationToken).toBe("token-2");

    latestRecognizer!.canceled?.(null, { result, reason: 1 });
    latestRecognizer!.sessionStopped?.();
    expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1);
    expect(callbacks.onDisconnected).toHaveBeenCalledWith("翻译连接中断（7）");
    await translator.stop();
  });

  it("令牌续期失败时给上层明确重建信号", async () => {
    const now = Date.now();
    tokenMock
      .mockResolvedValueOnce({ token: "token-1", region: "koreacentral", expiresAt: now + 600_000 })
      .mockRejectedValueOnce(new Error("unauthorized"));
    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onDisconnected: vi.fn(),
      onTokenError: vi.fn(),
    };
    const translator = new AzureSpeechTranslator(callbacks);
    await translator.start();
    await vi.advanceTimersByTimeAsync(480_000);
    expect(callbacks.onTokenError).toHaveBeenCalledWith("授权令牌续期失败");
    await translator.stop();
  });
});
