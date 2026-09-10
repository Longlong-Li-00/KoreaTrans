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
let configProperties: Array<[string, string]> = [];

interface TestResult {
  text: string;
  translations: Map<string, string>;
  offset: number;
  duration: number;
  resultId: string;
  reason: number;
  cancellationCode?: number;
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
    setProperty(name: string, value: string) {
      configProperties.push([name, value]);
    }
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
    PropertyId: {
      Speech_SegmentationStrategy: "segmentation-strategy",
      SpeechServiceResponse_TranslationRequestStablePartialResult: "stable-translation-partial",
    },
    ResultReason: { TranslatedSpeech: 1 },
    CancellationReason: { Error: 1 },
    CancellationErrorCode: {
      AuthenticationFailure: 1,
      BadRequestParameters: 2,
      Forbidden: 8,
    },
    CancellationDetails: { fromResult: (result: TestResult) => ({ ErrorCode: result.cancellationCode ?? 7 }) },
  };
});

const tokenMock = vi.mocked(fetchSpeechToken);

beforeEach(() => {
  latestRecognizer = null;
  configProperties = [];
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
    expect(configProperties).toEqual([
      ["segmentation-strategy", "Semantic"],
      ["stable-translation-partial", "true"],
    ]);

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
    expect(callbacks.onFinal).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^speech-.+-1$/), endMs: 3_000 }),
    );

    await vi.advanceTimersByTimeAsync(480_000);
    expect(tokenMock).toHaveBeenCalledTimes(2);
    expect(latestRecognizer!.authorizationToken).toBe("token-2");

    latestRecognizer!.canceled?.(null, { result, reason: 1 });
    latestRecognizer!.sessionStopped?.();
    expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1);
    expect(callbacks.onDisconnected).toHaveBeenCalledWith("翻译连接中断（错误代码 7）", false);
    await translator.stop();
  });

  it("配额拒绝被标记为不可自动重连错误", async () => {
    const now = Date.now();
    tokenMock.mockResolvedValueOnce({
      token: "token-1",
      region: "koreacentral",
      expiresAt: now + 600_000,
    });
    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onDisconnected: vi.fn(),
      onTokenError: vi.fn(),
    };
    const translator = new AzureSpeechTranslator(callbacks);
    await translator.start();
    const result: TestResult = {
      text: "",
      translations: new Map(),
      offset: 0,
      duration: 0,
      resultId: "quota",
      reason: 1,
      cancellationCode: 8,
    };
    latestRecognizer!.canceled?.(null, { result, reason: 1 });
    expect(callbacks.onDisconnected).toHaveBeenCalledWith(
      "Azure Speech F0 配额可能已耗尽或访问被拒绝，翻译已停止",
      true,
    );
    await translator.stop();
  });

  it("上游 resultId 缺失或重复时仍为不同语句生成不同的最终字幕 ID", async () => {
    tokenMock.mockResolvedValueOnce({
      token: "token-1",
      region: "eastasia",
      expiresAt: Date.now() + 600_000,
    });
    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onDisconnected: vi.fn(),
      onTokenError: vi.fn(),
    };
    const translator = new AzureSpeechTranslator(callbacks);
    await translator.start();

    const first: TestResult = {
      text: "첫 번째 문장입니다.",
      translations: new Map([["zh-Hans", "这是第一句话。"]]),
      offset: 10_000_000,
      duration: 20_000_000,
      resultId: "",
      reason: 1,
    };
    const second: TestResult = {
      text: "두 번째 문장입니다.",
      translations: new Map([["zh-Hans", "这是第二句话。"]]),
      offset: 40_000_000,
      duration: 20_000_000,
      resultId: "",
      reason: 1,
    };

    latestRecognizer!.recognized?.(null, { result: first });
    latestRecognizer!.recognized?.(null, { result: second });
    latestRecognizer!.recognized?.(null, { result: second });

    const firstId = callbacks.onFinal.mock.calls[0][0].id;
    const secondId = callbacks.onFinal.mock.calls[1][0].id;
    expect(firstId).not.toBe(secondId);
    expect(callbacks.onFinal.mock.calls[2][0].id).toBe(secondId);

    await translator.stop();
  });

  it("限制临时字幕刷新频率并在最终结果到达时取消过期更新", async () => {
    tokenMock.mockResolvedValueOnce({
      token: "token-1",
      region: "eastasia",
      expiresAt: Date.now() + 600_000,
    });
    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onDisconnected: vi.fn(),
      onTokenError: vi.fn(),
    };
    const translator = new AzureSpeechTranslator(callbacks);
    await translator.start();

    const result = (text: string, translation: string, offset: number): TestResult => ({
      text,
      translations: new Map([["zh-Hans", translation]]),
      offset,
      duration: 10_000_000,
      resultId: "",
      reason: 1,
    });
    const first = result("첫", "第", 10_000_000);
    const second = result("첫 번째", "第一", 10_500_000);
    const latest = result("첫 번째 문장", "第一句话", 11_000_000);

    latestRecognizer!.recognizing?.(null, { result: first });
    latestRecognizer!.recognizing?.(null, { result: second });
    latestRecognizer!.recognizing?.(null, { result: latest });
    expect(callbacks.onInterim).toHaveBeenCalledTimes(1);
    expect(callbacks.onInterim).toHaveBeenLastCalledWith(
      expect.objectContaining({ translationZhHans: "第" }),
    );

    await vi.advanceTimersByTimeAsync(649);
    expect(callbacks.onInterim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.onInterim).toHaveBeenCalledTimes(2);
    expect(callbacks.onInterim).toHaveBeenLastCalledWith(
      expect.objectContaining({ translationZhHans: "第一句话" }),
    );

    latestRecognizer!.recognizing?.(null, { result: second });
    latestRecognizer!.recognized?.(null, { result: latest });
    await vi.advanceTimersByTimeAsync(650);
    expect(callbacks.onInterim).toHaveBeenCalledTimes(2);
    expect(callbacks.onFinal).toHaveBeenCalledTimes(1);

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
