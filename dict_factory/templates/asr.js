/* Shared Web Speech (ASR) module (Phase E3).
 *
 * Lets the learner dictate the drill sentence with their MIC instead of the
 * keyboard. Mirrors the extension's useBrowserSpeechRecognition:
 * interim results stream live, final results are committed, the language can
 * be switched while listening (restarted inside onend to avoid the Chrome
 * race), and every error is reported with a human message — never silent.
 *
 * Privacy: recognition happens 100% in the browser. Audio is NOT uploaded
 * to our server.
 */
(function (global) {
  'use strict';

  var SUPPORT = (typeof window !== 'undefined')
    ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
    : null;

  // 35 product codes -> BCP-47 tags with good browser STT coverage.
  var BCP47 = {
    en: 'en-US', vi: 'vi-VN', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR',
    hi: 'hi-IN', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR',
    ru: 'ru-RU', ar: 'ar-SA', bn: 'bn-BD', id: 'id-ID', ms: 'ms-MY',
    th: 'th-TH', tr: 'tr-TR', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL',
    uk: 'uk-UA', el: 'el-GR', cs: 'cs-CZ', sv: 'sv-SE', da: 'da-DK',
    fi: 'fi-FI', no: 'nb-NO', hu: 'hu-HU', ro: 'ro-RO', he: 'he-IL',
    fa: 'fa-IR', ur: 'ur-PK', ta: 'ta-IN', te: 'te-IN', sw: 'sw-KE'
  };

  var ERROR_MESSAGES = {
    'not-allowed': 'Từ chối quyền micro — bật quyền micro cho trang web rồi thử lại.',
    'service-not-allowed': 'Trình duyệt chặn nhận giọng nói.',
    'audio-capture': 'Không tìm thấy micro.',
    'network': 'Lỗi mạng khi nhận giọng nói.',
    'no-speech': '' // silent: nothing heard, keep listening
  };

  function bcp47(lang) {
    var code = String(lang || '').toLowerCase().split('-')[0];
    return BCP47[code] || code || '';
  }

  function isSupported() { return SUPPORT !== null; }

  // DICTATES into `input` (an <input type="text">).
  // opts: {onInterim(text), onFinal(text), onState(bool listening), onError(msg)}
  function start(input, lang, opts) {
    opts = opts || {};
    if (!SUPPORT) {
      if (opts.onError) opts.onError('Trình duyệt không hỗ trợ nhận giọng nói.');
      return null;
    }
    var recognition = new SUPPORT();
    var finalText = '';
    var listening = false;
    var pendingLang = null;
    var stopped = false;

    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = function () {
      listening = true;
      if (opts.onState) opts.onState(true);
    };

    recognition.onerror = function (e) {
      var msg = ERROR_MESSAGES[e.error] || ('Lỗi nhận giọng nói: ' + e.error);
      if (e.error !== 'no-speech' && opts.onError) opts.onError(msg);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stop();
    };

    recognition.onend = function () {
      if (stopped) return;
      // language changed while listening: restart the session with the new
      // language inside onend (Chrome aborts the old engine asynchronously)
      if (pendingLang !== null) {
        var next = pendingLang;
        pendingLang = null;
        startWith(next);
        return;
      }
      listening = false;
      if (opts.onState) opts.onState(false);
    };

    recognition.onresult = function (event) {
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var r = event.results[i];
        if (r == null) continue;
        var t = r[0].transcript;
        if (r.isFinal) {
          finalText = (finalText + ' ' + t).trim();
        } else {
          interim = t;
        }
      }
      input.value = (finalText + ' ' + interim).trim();
      if (opts.onInterim) opts.onInterim(interim);
    };

    function configure(langCode) {
      recognition.lang = bcp47(langCode) || recognition.lang;
    }

    function startWith(langCode) {
      try { recognition.abort(); } catch (e) {}
      configure(langCode || lang);
      try {
        recognition.start();
      } catch (e) {
        // already started or ended between abort/start
      }
    }

    function stop() {
      stopped = true;
      try { recognition.stop(); } catch (e) {}
      try { recognition.abort(); } catch (e) {}
      listening = false;
      if (opts.onState) opts.onState(false);
    }

    function restart(langCode) {
      pendingLang = langCode;
      if (listening) {
        try { recognition.stop(); } catch (e) {}
      } else {
        startWith(langCode);
      }
    }

    startWith(lang);
    return { stop: stop, restart: restart, get listening() { return listening; } };
  }

  global.Asr = { bcp47: bcp47, isSupported: isSupported, start: start };
})(typeof window !== 'undefined' ? window : globalThis);
