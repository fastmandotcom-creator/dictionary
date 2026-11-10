/**
 * M2.1: Microphone ASR for mobile Capacitor WebView.
 *
 * Uses the Web Speech Recognition API, which is available on Chromium-based
 * Android WebViews (API 30+) and all desktop browsers. Recognition runs
 * 100% on-device — audio is NEVER uploaded.
 *
 * Exposes window.MicAsr with:
 *   MicAsr.supported          — true if the API is available
 *   MicAsr.start(input, lang, cb) — start dictating into `input` (an <input>)
 *   MicAsr.stop()            — stop the active session
 *
 * `cb` receives { interim, final, state, error } as events.
 */
(function () {
  'use strict';

  var SUPPORT = (typeof window !== 'undefined')
    ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
    : null;

  // BCP-47 tags for the 5 primary target languages
  var BCP47 = { en: 'en-US', vi: 'vi-VN', ja: 'ja-JP', ko: 'ko-KR', de: 'de-DE' };

  var session = null;

  function bcp47(code) {
    return BCP47[String(code || '').toLowerCase()] || String(code || '');
  }

  function start(input, lang, cb) {
    cb = cb || function () {};
    if (!SUPPORT) {
      cb({ error: 'Microphone not supported on this device / WebView.' });
      return;
    }
    if (session) { try { session.recognition.stop(); } catch (e) {} }

    var recognition = new SUPPORT();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = bcp47(lang);

    var finalText = '';

    recognition.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r == null) continue;
        var t = r[0].transcript;
        if (r.isFinal) finalText = (finalText + ' ' + t).trim();
        else interim = t;
      }
      input.value = (finalText + ' ' + interim).trim();
      cb({ interim: interim, final: finalText, state: 'listening' });
    };

    recognition.onerror = function (ev) {
      if (ev.error === 'no-speech') return; // silent
      var msg;
      if (ev.error === 'not-allowed') msg = 'Bật quyền micro cho app rồi thử lại.';
      else if (ev.error === 'audio-capture') msg = 'Không tìm thấy micro.';
      else if (ev.error === 'network') msg = 'Mất mạng khi nhận giọng nói.';
      else msg = 'Lỗi nhận giọng nói: ' + ev.error;
      cb({ error: msg });
      session = null;
    };

    recognition.onend = function () {
      if (session) session = null;
      cb({ state: 'stopped' });
    };

    try { recognition.start(); } catch (e) { return; }
    session = { recognition: recognition };
    cb({ state: 'listening' });
  }

  function stop() {
    if (session) { try { session.recognition.stop(); } catch (e) {} session = null; }
  }

  window.MicAsr = {
    supported: SUPPORT !== null,
    start: start,
    stop: stop,
    bcp47: bcp47,
  };
})();
