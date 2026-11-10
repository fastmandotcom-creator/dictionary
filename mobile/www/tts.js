/* dict-learn TTS (text-to-speech) — native bridge, ported from duosub-study's
 * Android TextToSpeech + Google web-TTS design.
 *
 * WHY: the Android WebView ships no working Web Speech voice, so
 * window.speechSynthesis stays silent there — that's why "Nghe" was dead.
 * This module talks to the native DictTTS plugin (com.dict.learn.tts) which
 * speaks with the phone's on-device TTS (offline) and falls back to Google's
 * web TTS MP3 (online). On pure-web / PWA installs where the native plugin
 * is absent, it transparently falls back to window.speechSynthesis so desktop
 * and browser Chrome (which have real voices) still speak.
 *
 * Surface:
 *   TTS.available()        -> true when a working engine is reachable
 *   TTS.speak(text, lang) -> fire-and-forget; cancels the previous utterance
 *   TTS.cancel()
 *   TTS.engine()           -> "native" | "google-web" | "web" | "none"
 *
 * The module is defensive: it registers on Android via window.Capacitor and
 * no-ops on the DOM test harness, so app.js boots cleanly everywhere.
 */
(function () {
  if (typeof window === "undefined") return;

  var cap = (typeof window.Capacitor !== "undefined") ? window.Capacitor : null;
  var proxy = null;

  // On Android the Capacitor runtime is injected by native-bridge.js before the
  // page loads; registerPlugin('DictTTS') resolves to the native plugin whose
  // header is exported by the bridge. On web there is no header, so we probe.
  if (cap && typeof cap.registerPlugin === "function") {
    try {
      proxy = cap.registerPlugin("DictTTS");
    } catch (e) {
      proxy = null;
    }
  }

  var nativeOk = !!(proxy && cap && cap.isPluginAvailable && cap.isPluginAvailable("DictTTS"));

  var TTS = {
    _engine: "none",
    available: function () {
      return nativeOk || !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    },
    engine: function () {
      return nativeOk ? "native" : (window.speechSynthesis ? "web" : "none");
    },
    speak: function (text, lang) {
      if (!text || !TTS.available()) return;
      if (nativeOk) {
        try {
          proxy.speak({ text: text, lang: lang || "en" });
          TTS._engine = "native";
          return;
        } catch (e) { /* fall through to web */ }
      }
      TTS.speakWeb(text, lang);
    },
    cancel: function () {
      if (nativeOk) {
        try { proxy.cancel && proxy.cancel(); } catch (e) {}
      }
      if (window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) {}
      }
    },
    speakWeb: function (text, lang) {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = TTS.mapLang(lang);
      try { window.speechSynthesis.cancel(); } catch (e) {}
      window.speechSynthesis.speak(u);
      TTS._engine = "web";
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
