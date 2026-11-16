/**
 * Unified Microphone ASR Adapter for Android APK (Capacitor DictASR) + Chrome Web Speech.
 *
 * Zero-cost Google / OS engines only (no API keys, no paid cloud calls):
 *   - Android APK: Capacitor plugin `DictASR` -> android.speech.SpeechRecognizer
 *     (prefers API 31+ free on-device recognition, with standard SpeechRecognizer fallback)
 *     + standard Android RECORD_AUDIO runtime permission & App Settings recovery.
 *   - Chrome / PWA Web: W3C Web Speech API (SpeechRecognition / webkitSpeechRecognition).
 *
 * Surface:
 *   MicAsr.supported              — boolean (true if native DictASR or Web Speech exists)
 *   MicAsr.engine()               — "native" | "web" | "none"
 *   MicAsr.bcp47(code)            — maps 35 product codes to BCP-47 speech tags
 *   MicAsr.checkSupport()         — Promise<{ supported, engine, onDevice?, permission?, reason? }>
 *   MicAsr.getPermissionState()   — Promise<{ state, granted, platform }>
 *   MicAsr.requestPermission()    — Promise<{ state, granted, platform }>
 *   MicAsr.openAppSettings()      — Promise<{ opened, platform }>
 *   MicAsr.start(input, lang, cb) — dictates into `input`; `cb` receives
 *                                   { interim?, final?, matches?, rmsdB?, done?, state?, error?, errorCode? }
 *   MicAsr.stop()                 — stops any active session cleanly
 */
(function () {
  'use strict';

  // Full 35-language BCP-47 table (aligned with dict_factory/templates/asr.js).
  var BCP47 = {
    en: 'en-US', vi: 'vi-VN', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR',
    hi: 'hi-IN', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR',
    ru: 'ru-RU', ar: 'ar-SA', bn: 'bn-BD', id: 'id-ID', ms: 'ms-MY',
    th: 'th-TH', tr: 'tr-TR', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL',
    uk: 'uk-UA', el: 'el-GR', cs: 'cs-CZ', sv: 'sv-SE', da: 'da-DK',
    fi: 'fi-FI', no: 'nb-NO', nb: 'nb-NO', hu: 'hu-HU', ro: 'ro-RO',
    he: 'he-IL', iw: 'he-IL', fa: 'fa-IR', ur: 'ur-PK', ta: 'ta-IN',
    te: 'te-IN', sw: 'sw-KE'
  };

  var WEB_ERROR_MESSAGES = {
    'not-allowed': 'Quyền Micro đang bị tắt — hãy bật quyền Micro cho trình duyệt/app rồi thử lại.',
    'service-not-allowed': 'Trình duyệt đang chặn nhận giọng nói (cần HTTPS hoặc bật trong Chrome).',
    'audio-capture': 'Không tìm thấy Micro trên thiết bị.',
    'network': 'Cần mạng để Chrome nhận giọng nói (hoặc thử gõ tay).',
    'language-not-supported': 'Trình duyệt chưa hỗ trợ nhận giọng nói cho ngôn ngữ này.',
    'aborted': ''
  };

  var sessionToken = 0;
  var activeSession = null;

  function webSupportCtor() {
    if (typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function resolveNative() {
    if (typeof window !== 'undefined' && window.CapBridge && typeof window.CapBridge.resolve === 'function') {
      return window.CapBridge.resolve('DictASR');
    }
    return { cap: null, plugin: null, available: false };
  }

  function getEngine() {
    var nat = resolveNative();
    if (nat.available && nat.plugin && typeof nat.plugin.startListening === 'function') {
      return 'native';
    }
    if (webSupportCtor()) return 'web';
    return 'none';
  }

  function bcp47(code) {
    var raw = String(code || '').trim();
    if (!raw) return 'en-US';
    if (raw.indexOf('-') !== -1) return raw;
    var lower = raw.toLowerCase();
    return BCP47[lower] || raw;
  }

  function clearActiveSession(matchToken) {
    if (matchToken != null && (!activeSession || activeSession.token !== matchToken)) return;
    if (activeSession && typeof activeSession.cleanup === 'function') {
      try { activeSession.cleanup(); } catch (e) {}
    }
    activeSession = null;
  }

  function stop() {
    sessionToken += 1;
    var prev = activeSession;
    activeSession = null;
    if (prev && typeof prev.stop === 'function') {
      try { prev.stop(); } catch (e) {}
    }
  }

  function checkSupport() {
    var eng = getEngine();
    if (eng === 'native') {
      var plugin = resolveNative().plugin;
      if (typeof plugin.isAvailable !== 'function') {
        return Promise.resolve({ supported: true, engine: 'native', onDevice: false, permission: 'prompt', reason: '' });
      }
      return Promise.resolve(plugin.isAvailable()).then(function (r) {
        var avail = !!(r && r.available !== false);
        return {
          supported: avail,
          engine: 'native',
          onDevice: !!(r && r.onDeviceAvailable),
          permission: (r && r.permission) || 'prompt',
          reason: avail ? '' : 'Thiết bị chưa cài dịch vụ nhận giọng nói Google (Speech Services).'
        };
      }, function () {
        return { supported: false, engine: 'native', permission: 'prompt', reason: 'Không kiểm tra được dịch vụ Micro.' };
      });
    }
    if (eng === 'web') {
      return Promise.resolve({ supported: true, engine: 'web', onDevice: false, reason: '' });
    }
    return Promise.resolve({
      supported: false,
      engine: 'none',
      permission: 'unsupported',
      reason: 'Thiết bị này không hỗ trợ nhận giọng nói — hãy gõ tay nhé.'
    });
  }

  function getPermissionState() {
    var eng = getEngine();
    if (eng === 'native') {
      var plugin = resolveNative().plugin;
      if (typeof plugin.checkMicPermission === 'function') {
        return Promise.resolve(plugin.checkMicPermission()).then(function (r) {
          var st = (r && r.state) || 'prompt';
          return { state: st, granted: st === 'granted', platform: 'native' };
        }, function () {
          return { state: 'prompt', granted: false, platform: 'native' };
        });
      }
      return Promise.resolve({ state: 'prompt', granted: false, platform: 'native' });
    }
    if (eng === 'web') {
      if (typeof navigator !== 'undefined' && navigator.permissions && typeof navigator.permissions.query === 'function') {
        try {
          return navigator.permissions.query({ name: 'microphone' }).then(function (status) {
            var s = status && status.state;
            var mapped = s === 'granted' ? 'granted' : (s === 'denied' ? 'denied' : 'prompt');
            return { state: mapped, granted: mapped === 'granted', platform: 'web' };
          }, function () {
            return { state: 'prompt', granted: false, platform: 'web' };
          });
        } catch (e) {
          return Promise.resolve({ state: 'prompt', granted: false, platform: 'web' });
        }
      }
      return Promise.resolve({ state: 'prompt', granted: false, platform: 'web' });
    }
    return Promise.resolve({ state: 'unsupported', granted: false, platform: 'none' });
  }

  function requestPermission() {
    var eng = getEngine();
    if (eng === 'native') {
      var plugin = resolveNative().plugin;
      if (typeof plugin.requestMicPermission === 'function') {
        return Promise.resolve(plugin.requestMicPermission()).then(function (r) {
          var st = (r && r.state) || 'denied';
          return { state: st, granted: !!(r && r.granted) || st === 'granted', platform: 'native' };
        }, function () {
          return { state: 'denied', granted: false, platform: 'native' };
        });
      }
      return getPermissionState();
    }
    if (eng === 'web') {
      // Browsers prompt inside the direct user-gesture recognition.start() call;
      // querying permissions.query avoids redundant double prompts.
      return getPermissionState();
    }
    return Promise.resolve({ state: 'unsupported', granted: false, platform: 'none' });
  }

  function openAppSettings() {
    var eng = getEngine();
    if (eng === 'native') {
      var plugin = resolveNative().plugin;
      if (typeof plugin.openAppSettings === 'function') {
        return Promise.resolve(plugin.openAppSettings()).then(function (r) {
          return { opened: !!(r && r.opened), platform: 'native' };
        }, function () {
          return { opened: false, platform: 'native' };
        });
      }
    }
    return Promise.resolve({ opened: false, platform: eng });
  }

  function startNative(plugin, input, lang, cb, token) {
    var listenerHandle = null;
    var settled = false;

    function detachListener() {
      if (!listenerHandle) return;
      var h = listenerHandle;
      listenerHandle = null;
      Promise.resolve(h).then(function (resolved) {
        if (resolved && typeof resolved.remove === 'function') resolved.remove();
      }).catch(function () {});
    }

    function finish(payload) {
      if (settled) return;
      settled = true;
      clearActiveSession(token);
      cb(payload);
    }

    if (typeof plugin.addListener === 'function') {
      listenerHandle = plugin.addListener('asrEvent', function (ev) {
        if (token !== sessionToken || !ev || settled) return;
        if (ev.type === 'ready') {
          cb({ state: 'listening' });
        } else if (ev.type === 'rms') {
          cb({ rmsdB: ev.rmsdB });
        } else if (ev.type === 'partial') {
          var partial = ev.text || '';
          if (input) input.value = partial;
          cb({ interim: partial, state: 'listening' });
        } else if (ev.type === 'result') {
          var finalText = ev.text || '';
          if (input) input.value = finalText;
          finish({
            final: finalText,
            matches: ev.matches || [],
            done: true,
            state: 'stopped'
          });
        } else if (ev.type === 'error') {
          finish({
            error: ev.message || 'Lỗi nhận giọng nói.',
            errorCode: ev.code || 'unavailable',
            done: true,
            state: 'stopped'
          });
        } else if (ev.type === 'state' && ev.state === 'stopped') {
          finish({ done: true, state: 'stopped' });
        }
      });
    }

    activeSession = {
      token: token,
      cleanup: detachListener,
      stop: function () {
        settled = true;
        detachListener();
        if (typeof plugin.stopListening === 'function') {
          try { plugin.stopListening(); } catch (e) {}
        }
      }
    };

    Promise.resolve(plugin.startListening({
      lang: bcp47(lang),
      preferOffline: true
    })).then(function (res) {
      if (token !== sessionToken || settled) return;
      if (res && res.started === false) {
        finish({
          error: res.error || 'Không bật được Micro.',
          errorCode: res.errorCode || 'unavailable',
          permissionState: res.permissionState,
          done: true,
          state: 'stopped'
        });
      }
    }, function () {
      if (token !== sessionToken || settled) return;
      finish({
        error: 'Không gọi được dịch vụ Micro trên máy.',
        errorCode: 'unavailable',
        done: true,
        state: 'stopped'
      });
    });

    cb({ state: 'listening' });
  }

  function startWeb(Ctor, input, lang, cb, token) {
    var recognition = new Ctor();
    // Single-sentence dictation drill: stops cleanly once utterance ends
    // instead of leaking background mic open across sentences.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.lang = bcp47(lang);

    var finalText = '';
    var settled = false;
    var emittedError = false;

    function finish(payload) {
      if (settled) return;
      settled = true;
      clearActiveSession(token);
      cb(payload);
    }

    recognition.onstart = function () {
      if (token !== sessionToken || settled) return;
      cb({ state: 'listening' });
    };

    recognition.onresult = function (ev) {
      if (token !== sessionToken || settled) return;
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r == null) continue;
        var t = (r[0] && r[0].transcript) || '';
        if (r.isFinal) finalText = (finalText + ' ' + t).trim();
        else interim = t;
      }
      var merged = (finalText + ' ' + interim).trim();
      if (input) input.value = merged;
      if (interim) {
        cb({ interim: interim, state: 'listening' });
      }
    };

    recognition.onerror = function (ev) {
      if (token !== sessionToken || settled) return;
      var code = (ev && ev.error) || 'unknown';
      if (code === 'no-speech' || code === 'aborted') {
        return; // onend handles silent completion cleanly
      }
      emittedError = true;
      var msg = WEB_ERROR_MESSAGES[code] || ('Lỗi nhận giọng nói: ' + code);
      try { recognition.abort(); } catch (e) {}
      finish({ error: msg, errorCode: code, done: true, state: 'stopped' });
    };

    recognition.onend = function () {
      if (token !== sessionToken) return;
      if (!settled && !emittedError) {
        finish({
          final: finalText,
          done: true,
          state: 'stopped',
          noSpeech: !finalText
        });
      }
    };

    activeSession = {
      token: token,
      cleanup: null,
      stop: function () {
        if (!settled) {
          try { recognition.stop(); } catch (e) {
            try { recognition.abort(); } catch (e2) {}
          }
        }
      }
    };

    try {
      recognition.start();
    } catch (e) {
      finish({
        error: 'Không bật được Micro — vui lòng chạm lại.',
        errorCode: 'start-failed',
        done: true,
        state: 'stopped'
      });
      return;
    }

    cb({ state: 'listening' });
  }

  function start(input, lang, cb) {
    cb = typeof cb === 'function' ? cb : function () {};
    stop();
    sessionToken += 1;
    var token = sessionToken;
    var eng = getEngine();

    if (eng === 'native') {
      startNative(resolveNative().plugin, input, lang, cb, token);
      return;
    }
    if (eng === 'web') {
      startWeb(webSupportCtor(), input, lang, cb, token);
      return;
    }
    cb({
      error: 'Thiết bị này không hỗ trợ nhận giọng nói — gõ tay nhé.',
      errorCode: 'unsupported',
      done: true,
      state: 'stopped'
    });
  }

  var api = {
    engine: getEngine,
    bcp47: bcp47,
    checkSupport: checkSupport,
    getPermissionState: getPermissionState,
    requestPermission: requestPermission,
    openAppSettings: openAppSettings,
    start: start,
    stop: stop
  };
  Object.defineProperty(api, 'supported', {
    get: function () { return getEngine() !== 'none'; },
    enumerable: true
  });

  window.MicAsr = api;
})();
