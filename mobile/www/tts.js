/* dict-learn TTS (text-to-speech) — native bridge, ported from duosub-study's
 * Android TextToSpeech + Google web-TTS design.
 *
 * WHY: the Android WebView ships no working Web Speech voice, so
 * window.speechSynthesis stays silent there — that's why "Nghe" was dead.
 * This module talks to the native DictTTS plugin (com.dict.learn.tts), a
 * faithful port of duosub-study's WordPronouncer + AndroidPronunciationEngine
 * + GoogleWebSpeech:
 *   - plays a cached recording first;
 *   - tries every installed on-device TTS engine (the user's default first),
 *     recording with synthesizeToFile and amplifying quiet WAVs;
 *   - falls back to Google's online MP3 voice (translate_tts, health/backoff);
 *   - a last-resort direct utterance; and always reports WHY it could not
 *     speak, plus the settings screen to install the missing voices.
 *
 * On pure-web / PWA installs where the native plugin is absent, it falls back
 * to window.speechSynthesis so desktop and Chrome (real voices) still speak.
 *
 * Surface:
 *   TTS.speak(text, lang) -> Promise<{ok, result, engine, detail}>
 *                          (ok=true when the audio actually played)
 *   TTS.cancel()
 *   TTS.diagnose()        -> Promise<{engineCount, googleResting, cacheCount}>
 *   TTS.openSettings()    -> Promise<...> (system TTS data/settings screen)
 *   TTS.available()       -> true when any engine is reachable
 *   TTS.mapLang(lang)
 *
 * Defensive: registers on Android via window.Capacitor, no-ops otherwise, so
 * app.js (and the DOM test harness) boot cleanly everywhere.
 */
(function () {
  if (typeof window === "undefined") return;

  var cap = (typeof window.Capacitor !== "undefined") ? window.Capacitor : null;
  var proxy = null;
  if (cap && typeof cap.registerPlugin === "function") {
    try { proxy = cap.registerPlugin("DictTTS"); } catch (e) { proxy = null; }
  }
  var nativeOk = !!(proxy && cap && cap.isPluginAvailable && cap.isPluginAvailable("DictTTS"));

  var TTS = {
    _last: { ok: false, result: "none", engine: "none", detail: "" },

    available: function () {
      return nativeOk || !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    },

    // Speak and resolve with the outcome (duosub's PronunciationResult).
    speak: function (text, lang) {
      if (!text || !TTS.available()) {
        TTS._last = { ok: false, result: "unavailable", engine: "none", detail: "no TTS engine" };
        return Promise.resolve(TTS._last);
      }
      if (nativeOk && proxy.speak) {
        return proxy.speak({ text: text, lang: lang || "en" })
          .then(function (r) {
            TTS._last = {
              ok: !!(r && r.result === "spoken"),
              result: (r && r.result) || "unavailable",
              engine: (r && r.engine) || "none",
              detail: (r && r.detail) || ""
            };
            return TTS._last;
          })
          .catch(function (e) {
            // Native bridge error: try the web engine before giving up.
            return TTS.speakWeb(text, lang);
          });
      }
      return TTS.speakWeb(text, lang);
    },

    cancel: function () {
      if (nativeOk && proxy.cancel) { try { proxy.cancel(); } catch (e) {} }
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    },

    diagnose: function () {
      if (nativeOk && proxy.diagnose) return proxy.diagnose().catch(function () { return {}; });
      return Promise.resolve({ web: !!(window.speechSynthesis), engineCount: 0 });
    },

    openSettings: function () {
      if (nativeOk && proxy.openSettings) return proxy.openSettings().catch(function () { return {}; });
      return Promise.resolve({});
    },

    // duosub's human-readable failure message for the app to toast.
    message: function () {
      var r = TTS._last.result;
      switch (r) {
        case "no-voice":  return "Máy chưa có giọng đọc cho ngôn ngữ này — mở cài đặt giọng nói để tải.";
        case "unavailable": return "Không có engine phát âm thanh nào khả dụng.";
        case "playback-failed": return "Đã ghi âm thanh nhưng không phát được — thử lại.";
        case "none":
        default:
          return TTS._last.detail || "Chưa phát được âm thanh.";
      }
    },

    speakWeb: function (text, lang) {
      if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
        var u = new window.SpeechSynthesisUtterance(text);
        u.lang = TTS.mapLang(lang);
        try { window.speechSynthesis.cancel(); } catch (e) {}
        window.speechSynthesis.speak(u);
        TTS._last = { ok: true, result: "spoken", engine: "web", detail: "window.speechSynthesis" };
        return Promise.resolve(TTS._last);
      }
      TTS._last = { ok: false, result: "unavailable", engine: "none", detail: "no speech engine" };
      return Promise.resolve(TTS._last);
    },

    mapLang: function (lang) {
      switch (lang) {
        case "zh": return "zh-CN";
        case "pt": return "pt-BR";
        case "vi": return "vi-VN";
        default: return lang;
      }
    }
  };

  window.TTS = TTS;
})();
