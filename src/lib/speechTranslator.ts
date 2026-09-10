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
  onDisconnected: (reason: string) => void;
  onTokenError: (reason: string) => void;
}

const TICKS_PER_MILLISECOND = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;

export class AzureSpeechTranslator {
  private recognizer: import("microsoft-cognitiveservices-speech-sdk").TranslationRecognizer | null = null;
  private refreshTimer: number | null = null;
  private stopping = false;
  private disconnectReported = false;

  constructor(private readonly callbacks: TranslatorCallbacks) {}

  async start() {
    this.stopping = false;
    this.disconnectReported = false;
    const SpeechSDK = await import("microsoft-cognitiveservices-speech-sdk");
    const credential = await fetchSpeechToken();
    const config = SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(
      credential.token,
      credential.region,
    );
    config.speechRecognitionLanguage = "ko-KR";
    config.addTargetLanguage("zh-Hans");

    const audio = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer = new SpeechSDK.TranslationRecognizer(config, audio);
    this.recognizer = recognizer;

    recognizer.recognizing = (_sender, event) => {
      const payload = this.toPayload(event.result, "provisional");
      if (payload) this.callbacks.onInterim(payload);
    };
    recognizer.recognized = (_sender, event) => {
      if (event.result.reason !== SpeechSDK.ResultReason.TranslatedSpeech) return;
      const payload = this.toPayload(event.result, event.result.resultId);
      if (payload) this.callbacks.onFinal(payload);
    };
    recognizer.canceled = (_sender, event) => {
      if (this.stopping) return;
      const details = SpeechSDK.CancellationDetails.fromResult(event.result);
      const reason =
        event.reason === SpeechSDK.CancellationReason.Error
          ? `翻译连接中断（${details.ErrorCode}）`
          : "翻译连接已取消";
      this.reportDisconnect(reason);
    };
    recognizer.sessionStopped = () => {
      if (!this.stopping) this.reportDisconnect("翻译会话意外停止");
    };

    await new Promise<void>((resolve, reject) => {
      recognizer.startContinuousRecognitionAsync(resolve, (error) => reject(new Error(error)));
    });
    this.scheduleTokenRefresh(credential.expiresAt);
  }

  async stop() {
    this.stopping = true;
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

  private toPayload(
    result: import("microsoft-cognitiveservices-speech-sdk").TranslationRecognitionResult,
    fallbackId: string,
  ) {
    const sourceKo = result.text?.trim() ?? "";
    const translationZhHans = result.translations.get("zh-Hans")?.trim() ?? "";
    if (!sourceKo && !translationZhHans) return null;
    const startMs = clampMilliseconds(Number(result.offset) / TICKS_PER_MILLISECOND);
    const durationMs = clampMilliseconds(Number(result.duration) / TICKS_PER_MILLISECOND);
    return {
      id: result.resultId || fallbackId,
      sourceKo,
      translationZhHans,
      startMs,
      endMs: startMs + durationMs,
    };
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

  private reportDisconnect(reason: string) {
    if (this.disconnectReported) return;
    this.disconnectReported = true;
    this.callbacks.onDisconnected(reason);
  }
}
