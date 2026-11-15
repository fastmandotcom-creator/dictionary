/* dict-learn TTS (text-to-speech) — native Capacitor 8 bridge + Web Speech fallback.
 *
 * Uses window.CapBridge.resolve("DictTTS") so Android APK builds resolve
 * window.Capacitor.Plugins.DictTTS directly without relying on @capacitor/core's
 * bundled registerPlugin helper.
 *
 * Surface:
 *   TTS.speak(text, lang) -> Promise<{ok, cancelled?, result, engine, detail}>
 *   TTS.cancel()
 *   TTS.diagnose()        -> Promise<{engineCount, engineNames, networkOnline, googleResting, cacheCount}>
 *   TTS.openSettings()    -> Promise<...>
 *   TTS.status()          -> Promise<{nativeBound, hasCapacitor, engines?, engineNames?, networkOnline?, googleResting?, cacheCount?, last}>
 *   TTS.available()       -> true when native DictTTS or Web Speech is reachable
 *   TTS.mapLang(lang)
 */
(function () {
  if (typeof window === "undefined") return;

  function resolveNative() {
    if (window.CapBridge && typeof window.CapBridge.resolve === "function") {
      return window.CapBridge.resolve("DictTTS");
    }
    return { cap: null, plugin: null, available: false };
  }

  var TTS = {
    _last: { ok: false, result: "none", engine: "none", detail: "" },

    status: function () {
      var r = resolveNative();
      var s = {
        nativeBound: r.available,
        hasCapacitor: !!r.cap,
        last: TTS._last
      };
      if (r.available && r.plugin && r.plugin.diagnose) {
        return r.plugin.diagnose().then(function (d) {
          if (d) {
            s.engines = d.engineCount;
            s.engineNames = d.engineNames;
            s.networkOnline = d.networkOnline;
            s.googleResting = !!d.googleResting;
            s.cacheCount = d.cacheCount;
          }
          return s;
        }, function () { return s; });
      }
      return Promise.resolve(s);
    },

    available: function () {
      return resolveNative().available || !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    },

    speak: function (text, lang, opts) {
      var r = resolveNative();
      if (!text || (!r.available && !(window.speechSynthesis && window.SpeechSynthesisUtterance))) {
        TTS._last = { ok: false, result: "unavailable", engine: "none", detail: "no TTS engine" };
        return Promise.resolve(TTS._last);
      }
      if (r.available && r.plugin && r.plugin.speak) {
        var req = { text: text, lang: lang || "en" };
        if (opts && typeof opts.speed === "number") req.speed = opts.speed;
        return r.plugin.speak(req)
          .then(function (res) {
            var result = (res && res.result) || "unavailable";
            if (result === "cancelled") {
              TTS._last = {
                ok: false,
                cancelled: true,
                result: "cancelled",
                engine: "none",
                detail: (res && res.detail) || "superseded"
              };
              return TTS._last;
            }
            TTS._last = {
              ok: result === "spoken",
              result: result,
              engine: (res && res.engine) || "none",
              detail: (res && res.detail) || ""
            };
            return TTS._last;
          })
          .catch(function () {
            return TTS.speakWeb(text, lang, opts);
          });
      }
      return TTS.speakWeb(text, lang, opts);
    },

    cancel: function () {
      var r = resolveNative();
      if (r.available && r.plugin && r.plugin.cancel) {
        try { r.plugin.cancel(); } catch (e) {}
      }
      if (window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) {}
      }
    },

    diagnose: function () {
      var r = resolveNative();
      if (r.available && r.plugin && r.plugin.diagnose) {
        return r.plugin.diagnose().catch(function () { return {}; });
      }
      return Promise.resolve({ web: !!(window.speechSynthesis), engineCount: 0 });
    },

    openSettings: function () {
      var r = resolveNative();
      if (r.available && r.plugin && r.plugin.openSettings) {
        return r.plugin.openSettings().catch(function () { return {}; });
      }
      return Promise.resolve({});
    },

    message: function () {
      switch (TTS._last.result) {
        case "no-voice": return "Máy chưa có giọng đọc cho ngôn ngữ này — mở cài đặt giọng nói để tải.";
        case "unavailable": return "Không có engine phát âm thanh nào khả dụng.";
        case "playback-failed": return "Đã ghi âm thanh nhưng không phát được — thử lại.";
        case "cancelled": return "";
        case "none":
        default:
          return TTS._last.detail || "Chưa phát được âm thanh.";
      }
    },

    speakWeb: function (text, lang, opts) {
      var synth = window.speechSynthesis;
      if (synth && window.SpeechSynthesisUtterance) {
        try {
          if (typeof synth.getVoices === "function") {
            var voices = synth.getVoices() || [];
            if (voices.length === 0) {
              TTS._last = {
                ok: false,
                result: "no-voice",
                engine: "web",
                detail: "window.speechSynthesis has no voices on this device"
              };
              return Promise.resolve(TTS._last);
            }
          }
        } catch (e) {}
        var u = new window.SpeechSynthesisUtterance(text);
        u.lang = TTS.mapLang(lang);
        if (opts && typeof opts.speed === "number") u.rate = opts.speed;
        if (opts && opts.awaitEnd) {
          return new Promise(function (resolve) {
            var settled = false;
            var fallbackMs = Math.min(18000, Math.max(1200, (String(text).length * 95) / Math.max(0.65, u.rate || 1)));
            var timer = setTimeout(function () { finish("spoken"); }, fallbackMs);
            function finish(result) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              TTS._last = {
                ok: result === "spoken",
                result: result,
                engine: "web",
                detail: "window.speechSynthesis"
              };
              resolve(TTS._last);
            }
            u.onend = function () { finish("spoken"); };
            u.onerror = function (ev) {
              var err = ev && ev.error;
              finish(err === "canceled" || err === "interrupted" ? "cancelled" : "playback-failed");
            };
            try { synth.cancel(); } catch (e) {}
            synth.speak(u);
          });
        }
        try { synth.cancel(); } catch (e) {}
        synth.speak(u);
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

  function callNativeAudio(method, args) {
    var r = resolveNative();
    if (!r.available || !r.plugin || typeof r.plugin[method] !== "function") {
      return Promise.resolve({ supported: false, status: "idle" });
    }
    try {
      return Promise.resolve(r.plugin[method](args || {})).catch(function () {
        return { supported: false, status: "idle" };
      });
    } catch (e) {
      return Promise.resolve({ supported: false, status: "idle" });
    }
  }

  function addNativeListener(eventName, fn) {
    var r = resolveNative();
    if (!r.available || !r.plugin || typeof r.plugin.addListener !== "function" || typeof fn !== "function") {
      return function () {};
    }
    try {
      var handle = r.plugin.addListener(eventName, fn);
      return function () {
        Promise.resolve(handle).then(function (h) {
          if (h && typeof h.remove === "function") h.remove();
        }).catch(function () {});
      };
    } catch (e) {
      return function () {};
    }
  }

  TTS.audio = {
    available: function () {
      var r = resolveNative();
      return !!(r.available && r.plugin && typeof r.plugin.startAudioQueue === "function");
    },
    ensureNotificationPermission: function () {
      var r = resolveNative();
      if (r.available && r.plugin && typeof r.plugin.requestNotificationPermission === "function") {
        return r.plugin.requestNotificationPermission().catch(function () { return { granted: true }; });
      }
      return Promise.resolve({ granted: true, web: true });
    },
    startQueue: function (payload) { return callNativeAudio("startAudioQueue", payload); },
    pause: function () { return callNativeAudio("pauseAudio"); },
    resume: function () { return callNativeAudio("resumeAudio"); },
    next: function () { return callNativeAudio("nextAudio"); },
    prev: function () { return callNativeAudio("prevAudio"); },
    seek: function (index) { return callNativeAudio("seekAudio", { index: index }); },
    stop: function () { return callNativeAudio("stopAudio"); },
    updateConfig: function (cfg) { return callNativeAudio("updateAudioConfig", cfg); },
    getState: function () { return callNativeAudio("getAudioState"); },
    prefetch: function (payload) { return callNativeAudio("prefetchAudio", payload); },
    cancelPrefetch: function () { return callNativeAudio("cancelPrefetch"); },
    onState: function (fn) { return addNativeListener("audioState", fn); },
    onPrefetch: function (fn) { return addNativeListener("audioPrefetch", fn); }
  };

  window.TTS = TTS;
})();
