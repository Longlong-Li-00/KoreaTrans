import { fetchSpeechToken } from "./api";
import { clampMilliseconds } from "./time";

export interface TranslationPayload {
  id: string;
  sourceKo: string;
  translationZhHans: string;
  startMs: number;
  endMs: number;
}

export interface TranslatorCallbacks {
  onInterim: (payload: TranslationPayload) => void;
  onFinal: (payload: TranslationPayload) => void;
  onDisconnected: (reason: string, fatal: boolean) => void;
  onTokenError: (reason: string) => void;
}

const TICKS_PER_MILLISECOND = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;
const INTERIM_RENDER_INTERVAL_MS = 650;

export class AzureSpeechTranslator {
  private recognizer: import("microsoft-cognitiveservices-speech-sdk").TranslationRecognizer | null = null;
  private refreshTimer: number | null = null;
  private stopping = false;
  private disconnectReported = false;
  private recognitionSessionId = "";
  private nextFinalId = 0;
  private readonly finalIdsBySignature = new Map<string, string>();
  private pendingInterim: TranslationPayload | null = null;
  private interimTimer: number | null = null;
  private lastInterimEmittedAt = 0;

  constructor(private readonly callbacks: TranslatorCallbacks) {}

  async start() {
    this.stopping = false;
    this.disconnectReported = false;
    this.recognitionSessionId = crypto.randomUUID();
    this.nextFinalId = 0;
    this.finalIdsBySignature.clear();
    this.clearPendingInterim();
    this.lastInterimEmittedAt = 0;
    const SpeechSDK = await import("microsoft-cognitiveservices-speech-sdk");
    const credential = await fetchSpeechToken();
    const config = SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(
      credential.token,
      credential.region,
    );
    config.speechRecognitionLanguage = "ko-KR";
    config.addTargetLanguage("zh-Hans");
    config.setProperty(SpeechSDK.PropertyId.Speech_SegmentationStrategy, "Semantic");
    config.setProperty(
      SpeechSDK.PropertyId.SpeechServiceResponse_TranslationRequestStablePartialResult,
      "true",
    );

    const audio = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer = new SpeechSDK.TranslationRecognizer(config, audio);
    this.recognizer = recognizer;

    recognizer.recognizing = (_sender, event) => {
      const payload = this.toPayload(event.result, "provisional");
      if (payload) this.queueInterim(payload);
    };
    recognizer.recognized = (_sender, event) => {
      if (this.stopping) return;
      this.clearPendingInterim();
      if (event.result.reason !== SpeechSDK.ResultReason.TranslatedSpeech) return;
      const payload = this.toPayload(event.result, this.finalIdFor(event.result));
      if (payload) this.callbacks.onFinal(payload);
    };
    recognizer.canceled = (_sender, event) => {
      if (this.stopping) return;
      const details = SpeechSDK.CancellationDetails.fromResult(event.result);
      const fatal = [
        SpeechSDK.CancellationErrorCode.AuthenticationFailure,
        SpeechSDK.CancellationErrorCode.BadRequestParameters,
        SpeechSDK.CancellationErrorCode.Forbidden,
      ].includes(details.ErrorCode);
      let reason = "翻译连接已取消";
      if (details.ErrorCode === SpeechSDK.CancellationErrorCode.AuthenticationFailure) {
        reason = "Azure Speech 身份验证失败，翻译已停止";
      } else if (details.ErrorCode === SpeechSDK.CancellationErrorCode.BadRequestParameters) {
        reason = "Azure Speech 语言或资源配置无效，翻译已停止";
      } else if (details.ErrorCode === SpeechSDK.CancellationErrorCode.Forbidden) {
        reason = "Azure Speech F0 配额可能已耗尽或访问被拒绝，翻译已停止";
      } else if (event.reason === SpeechSDK.CancellationReason.Error) {
        reason = `翻译连接中断（错误代码 ${details.ErrorCode}）`;
      }
      this.reportDisconnect(reason, fatal);
    };
    recognizer.sessionStopped = () => {
      if (!this.stopping) this.reportDisconnect("翻译会话意外停止", false);
    };

    await new Promise<void>((resolve, reject) => {
      recognizer.startContinuousRecognitionAsync(resolve, (error) => reject(new Error(error)));
    });
    this.scheduleTokenRefresh(credential.expiresAt);
  }

  async stop() {
    this.stopping = true;
    this.clearPendingInterim();
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const recognizer = this.recognizer;
    this.recognizer = null;
    if (!recognizer) return;

    await new Promise<void>((resolve) => {
      recognizer.stopContinuousRecognitionAsync(resolve, () => resolve());
    });
    recognizer.close();
  }

  private queueInterim(payload: TranslationPayload) {
    if (this.stopping) return;
    this.pendingInterim = payload;
    const elapsed = Date.now() - this.lastInterimEmittedAt;
    if (this.lastInterimEmittedAt === 0 || elapsed >= INTERIM_RENDER_INTERVAL_MS) {
      this.flushPendingInterim();
      return;
    }
    if (this.interimTimer !== null) return;

    this.interimTimer = window.setTimeout(() => {
      this.interimTimer = null;
      this.flushPendingInterim();
    }, INTERIM_RENDER_INTERVAL_MS - elapsed);
  }

  private flushPendingInterim() {
    const payload = this.pendingInterim;
    this.pendingInterim = null;
    if (!payload || this.stopping) return;
    this.lastInterimEmittedAt = Date.now();
    this.callbacks.onInterim(payload);
  }

  private clearPendingInterim() {
    this.pendingInterim = null;
    if (this.interimTimer !== null) {
      window.clearTimeout(this.interimTimer);
      this.interimTimer = null;
    }
  }

  private toPayload(
    result: import("microsoft-cognitiveservices-speech-sdk").TranslationRecognitionResult,
    id: string,
  ) {
    const sourceKo = result.text?.trim() ?? "";
    const translationZhHans = result.translations.get("zh-Hans")?.trim() ?? "";
    if (!sourceKo && !translationZhHans) return null;
    const startMs = clampMilliseconds(Number(result.offset) / TICKS_PER_MILLISECOND);
    const durationMs = clampMilliseconds(Number(result.duration) / TICKS_PER_MILLISECOND);
    return {
      id,
      sourceKo,
      translationZhHans,
      startMs,
      endMs: startMs + durationMs,
    };
  }

  private finalIdFor(
    result: import("microsoft-cognitiveservices-speech-sdk").TranslationRecognitionResult,
  ) {
    const signature = JSON.stringify([
      result.resultId ?? "",
      String(result.offset ?? ""),
      String(result.duration ?? ""),
      result.text?.trim() ?? "",
      result.translations.get("zh-Hans")?.trim() ?? "",
    ]);
    const existing = this.finalIdsBySignature.get(signature);
    if (existing) return existing;

    this.nextFinalId += 1;
    const id = `speech-${this.recognitionSessionId}-${this.nextFinalId}`;
    this.finalIdsBySignature.set(signature, id);
    return id;
  }

  private scheduleTokenRefresh(expiresAt: number) {
    const delay = Math.max(30_000, expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS);
    this.refreshTimer = window.setTimeout(async () => {
      try {
        const credential = await fetchSpeechToken();
        if (this.recognizer && !this.stopping) {
          this.recognizer.authorizationToken = credential.token;
          this.scheduleTokenRefresh(credential.expiresAt);
        }
      } catch {
        if (!this.stopping) this.callbacks.onTokenError("授权令牌续期失败");
      }
    }, delay);
  }

  private reportDisconnect(reason: string, fatal: boolean) {
    if (this.disconnectReported) return;
    this.disconnectReported = true;
    this.clearPendingInterim();
    this.callbacks.onDisconnected(reason, fatal);
  }
}
