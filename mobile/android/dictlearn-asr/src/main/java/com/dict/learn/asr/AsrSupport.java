package com.dict.learn.asr;

import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Pure Java helpers for DictASR: BCP-47 language resolution, Android SpeechRecognizer
 * error mapping, and normalized permission state helpers (JVM unit-testable).
 */
public final class AsrSupport {

    public static final int ERR_NETWORK_TIMEOUT = 1;
    public static final int ERR_NETWORK = 2;
    public static final int ERR_AUDIO = 3;
    public static final int ERR_SERVER = 4;
    public static final int ERR_CLIENT = 5;
    public static final int ERR_SPEECH_TIMEOUT = 6;
    public static final int ERR_NO_MATCH = 7;
    public static final int ERR_RECOGNIZER_BUSY = 8;
    public static final int ERR_INSUFFICIENT_PERMISSIONS = 9;
    public static final int ERR_TOO_MANY_REQUESTS = 10;
    public static final int ERR_SERVER_DISCONNECTED = 11;
    public static final int ERR_LANGUAGE_NOT_SUPPORTED = 12;
    public static final int ERR_LANGUAGE_UNAVAILABLE = 13;
    public static final int ERR_CANNOT_CHECK_SUPPORT = 14;

    private static final Map<String, String> BCP47;
    static {
        Map<String, String> m = new HashMap<>();
        m.put("en", "en-US");
        m.put("vi", "vi-VN");
        m.put("zh", "zh-CN");
        m.put("ja", "ja-JP");
        m.put("ko", "ko-KR");
        m.put("hi", "hi-IN");
        m.put("es", "es-ES");
        m.put("fr", "fr-FR");
        m.put("de", "de-DE");
        m.put("pt", "pt-BR");
        m.put("ru", "ru-RU");
        m.put("ar", "ar-SA");
        m.put("bn", "bn-BD");
        m.put("id", "id-ID");
        m.put("ms", "ms-MY");
        m.put("th", "th-TH");
        m.put("tr", "tr-TR");
        m.put("it", "it-IT");
        m.put("nl", "nl-NL");
        m.put("pl", "pl-PL");
        m.put("uk", "uk-UA");
        m.put("el", "el-GR");
        m.put("cs", "cs-CZ");
        m.put("sv", "sv-SE");
        m.put("da", "da-DK");
        m.put("fi", "fi-FI");
        m.put("no", "nb-NO");
        m.put("nb", "nb-NO");
        m.put("hu", "hu-HU");
        m.put("ro", "ro-RO");
        m.put("he", "he-IL");
        m.put("iw", "he-IL");
        m.put("fa", "fa-IR");
        m.put("ur", "ur-PK");
        m.put("ta", "ta-IN");
        m.put("te", "te-IN");
        m.put("sw", "sw-KE");
        BCP47 = Collections.unmodifiableMap(m);
    }

    private AsrSupport() {}

    public static String toBcp47(String rawLang) {
        if (rawLang == null) return "en-US";
        String trimmed = rawLang.trim();
        if (trimmed.isEmpty()) return "en-US";
        if (trimmed.contains("-")) {
            return trimmed;
        }
        String lower = trimmed.toLowerCase(Locale.ROOT);
        String mapped = BCP47.get(lower);
        return mapped != null ? mapped : trimmed;
    }

    public static final class MappedError {
        public final String code;
        public final String message;
        public final boolean retryableWithCloudFallback;

        public MappedError(String code, String message, boolean retryableWithCloudFallback) {
            this.code = code;
            this.message = message;
            this.retryableWithCloudFallback = retryableWithCloudFallback;
        }
    }

    public static MappedError mapSpeechError(int errorCode) {
        switch (errorCode) {
            case ERR_NO_MATCH:
            case ERR_SPEECH_TIMEOUT:
                return new MappedError(
                    "no-speech",
                    "Chưa nghe rõ giọng nói — bấm 🎤 Mic nói lại hoặc gõ tay.",
                    false
                );
            case ERR_INSUFFICIENT_PERMISSIONS:
                return new MappedError(
                    "not-allowed",
                    "Quyền Micro đang bị tắt — hãy cấp quyền để dùng Mic.",
                    false
                );
            case ERR_AUDIO:
                return new MappedError(
                    "audio-capture",
                    "Không thu được âm thanh từ Micro trên thiết bị.",
                    false
                );
            case ERR_NETWORK:
            case ERR_NETWORK_TIMEOUT:
            case ERR_SERVER:
            case ERR_SERVER_DISCONNECTED:
                return new MappedError(
                    "network",
                    "Không kết nối được dịch vụ nhận giọng nói (cần mạng hoặc gói offline).",
                    false
                );
            case ERR_RECOGNIZER_BUSY:
                return new MappedError(
                    "busy",
                    "Micro đang bận — vui lòng chạm lại sau 1 giây.",
                    false
                );
            case ERR_LANGUAGE_NOT_SUPPORTED:
            case ERR_LANGUAGE_UNAVAILABLE:
            case ERR_CANNOT_CHECK_SUPPORT:
                return new MappedError(
                    "language-not-supported",
                    "Máy chưa hỗ trợ offline ngôn ngữ này — hãy bật mạng hoặc tải gói giọng nói Google.",
                    true
                );
            case ERR_TOO_MANY_REQUESTS:
                return new MappedError(
                    "busy",
                    "Gửi yêu cầu quá nhanh — thử lại sau ít giây.",
                    false
                );
            case ERR_CLIENT:
            default:
                return new MappedError(
                    "unavailable",
                    "Không thể khởi chạy nhận giọng nói trên thiết bị này.",
                    true
                );
        }
    }

    /**
     * Resolves Android runtime permission into Capacitor's 4 canonical states:
     * "granted" | "prompt-with-rationale" | "denied" | "prompt".
     */
    public static String resolvePermissionState(boolean isGranted, boolean shouldShowRationale, String cachedCapState) {
        if (isGranted) return "granted";
        if (shouldShowRationale) return "prompt-with-rationale";
        if ("denied".equals(cachedCapState)) return "denied";
        if ("prompt-with-rationale".equals(cachedCapState)) return "prompt-with-rationale";
        return "prompt";
    }
}
