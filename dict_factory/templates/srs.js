/* Shared SRS store for the Dict Learn web UI.
 * Single source of truth for the client side; the server side keeps a
 * mirror module in Python (same intervals, same key scheme).
 *
 * Storage:
 *   key   = srsKey(base, target)  -> { conceptId: { grade, due } }
 *   grade in INTERVALS, due = ISO date 'YYYY-MM-DD' of the next review.
 */
(function (global) {
  'use strict';

  var INTERVALS = { hard: 1, ok: 3, good: 7 };

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function isoFromOffset(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function srsKey(base, target) {
    return 'dict_srs_v2_' + base + '_' + target;
  }

  function legacyKey(base, target) {
    return 'dict_learn_progress_' + base + '_' + target;
  }

  function readSrs(base, target) {
    try {
      return JSON.parse(localStorage.getItem(srsKey(base, target)) || '{}');
    } catch (e) {
      return {};
    }
  }

  function readLegacy(base, target) {
    try {
      return JSON.parse(localStorage.getItem(legacyKey(base, target)) || '{}');
    } catch (e) {
      return {};
    }
  }

  function writeSrs(base, target, store) {
    localStorage.setItem(srsKey(base, target), JSON.stringify(store));
  }

  function grade(id, gradeVal, base, target) {
    var store = readSrs(base, target);
    store[id] = { grade: gradeVal, due: isoFromOffset(INTERVALS[gradeVal]), updated_at: nowIso() };
    writeSrs(base, target, store);
    return store[id];
  }

  // A card is "learned" once graded ok/good; hard stays pending; v1 legacy
  // only had 'good'.
  function isDone(entry, legacyValue) {
    if (entry && entry.grade) return entry.grade !== 'hard';
    return legacyValue === 'good';
  }

  // One-pass due lookup for hot loops (list pages walk thousands of ids and
  // must not re-parse both localStorage stores per card).
  function dueSet(base, target, todayIso) {
    var srsStore = readSrs(base, target);
    var legacyStore = readLegacy(base, target);
    var t = todayIso || isoFromOffset(0);
    var set = {};
    var keys = Object.keys(srsStore);
    for (var i = 0; i < keys.length; i++) {
      var id = keys[i];
      var e = srsStore[id];
      if (e && e.grade) {
        if (e.grade === 'hard' || !e.due || e.due <= t) set[id] = true;
      }
    }
    for (var l in legacyStore) set[l] = true;
    return set;
  }

  // "Due" = already learned and its review date arrived (or graded hard,
  // which resurfaces tomorrow). A card that was NEVER learned is "new", not
  // due — otherwise every unlearned word floods the review pool and the same
  // card repeats inside one session.
  // Legacy v1 entries (no due date) come back for one pass.
  function isDue(id, base, target, todayIso) {
    return !!dueSet(base, target, todayIso)[id];
  }

  // Fisher-Yates; returns a new array.
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  // ---- TTS settings (Phase E5): provider priority, speed, per-language
  // voice, mic visibility. Stored locally; read on every speak().
  var TTS_SETTINGS_KEY = 'dict_tts_settings_v1';
  var TTS_DEFAULTS = { provider: 'auto', rate: 'normal', voiceMap: {}, micEnabled: true };

  function readTtsSettings() {
    var s = Object.assign({}, TTS_DEFAULTS);
    try {
      var raw = localStorage.getItem(TTS_SETTINGS_KEY);
      if (raw) {
        var stored = JSON.parse(raw);
        if (stored && typeof stored === 'object') {
          s = Object.assign(s, stored);
          s.voiceMap = stored.voiceMap && typeof stored.voiceMap === 'object' ? stored.voiceMap : {};
        }
      }
    } catch (e) {}
    s.voiceMap = s.voiceMap || {};
    return s;
  }

  function saveTtsSettings(patch) {
    var s = readTtsSettings();
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] !== undefined) s[k] = patch[k];
    });
    s.voiceMap = s.voiceMap || {};
    try { localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
    return s;
  }

  // Speaks `text` with a voice for `langCode`.
  //
  // Ladder (Phase E2, mirrors the extension architecture):
  //   1. /api/tts  -> the server's standard neural voice for the language
  //      (free-online, cached). Reported as source 'standard'.
  //   2. Web Speech API browser voice (the floor) -> source 'browser'.
  //   3. no usable voice at all -> source 'none'.
  // `notify` receives a message when playback was NOT the standard voice.
  // `onSource` (optional) receives 'standard' | 'browser' | 'none' as soon as
  // the source is decided, so callers can show a "giọng: ..." label.
  var _ttsAudio = null;
  var _ttsSource = 'none';
  function ttsSource() { return _ttsSource; }

  function speak(text, langCode, notify, onSource) {
    if (!text) return;
    var s = readTtsSettings();
    var lang = String(langCode || '').toLowerCase().split('-')[0];
    var usedStandard = false;
    // Settings override: "browser only" skips the server ladder entirely.
    var useServer = s.provider !== 'browser' && typeof fetch === 'function';
    if (useServer) {
      var rate = s.rate === 'slow' ? 0.7 : 1.0;
      var voice = s.voiceMap[lang] || '';
      var qs = 'lang=' + encodeURIComponent(lang) +
        '&text=' + encodeURIComponent(text) +
        '&rate=' + rate +
        (voice ? '&voice=' + encodeURIComponent(voice) : '');
      fetch('/api/tts?' + qs)
        .then(function (r) {
          if (!r.ok) throw new Error('tts ' + r.status);
          return r.blob();
        })
        .then(function (blob) {
          usedStandard = true;
          _ttsSource = 'standard';
          if (onSource) onSource('standard');
          playAudioBlob(blob, lang, text, rate);
        })
        .catch(function () {
          if (usedStandard) return;
          // 2) browser floor
          var fell = webSpeechSpeak(text, langCode, notify, rate);
          _ttsSource = fell ? 'browser' : 'none';
          if (onSource) onSource(_ttsSource);
        });
      return;
    }
    // server tier disabled (or no fetch) -> straight to the floor
    var ok = webSpeechSpeak(text, langCode, notify, s.rate === 'slow' ? 0.7 : 1.0);
    _ttsSource = ok ? 'browser' : 'none';
    if (onSource) onSource(_ttsSource);
  }

  function webSpeechSpeak(text, langCode, notify, rate) {
    if (!('speechSynthesis' in window)) {
      if (notify) notify('Thiết bị không hỗ trợ đọc văn bản.');
      return false;
    }
    var voices = window.speechSynthesis.getVoices();
    var prefix = String(langCode || '').toLowerCase().split('-')[0];
    var match = null;
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if (v.lang && v.lang.toLowerCase().indexOf(prefix) === 0) {
        match = v;
        break;
      }
    }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = langCode;
    u.rate = rate || 1;
    if (match) u.voice = match;
    window.speechSynthesis.speak(u);
    if (!match && notify) {
      notify('Giọng trình duyệt không có ngôn ngữ này — bật đọc thử không khả dụng.');
    }
    return true;
  }

  function playAudioBlob(blob, lang, text, rate) {
    stopTtsAudio();
    var url = URL.createObjectURL(blob);
    _ttsAudio = new Audio(url);
    var onError = function () {
      // standard voice failed at playback time: fall back to the floor
      if (_ttsSource === 'standard') {
        _ttsSource = 'browser';
        webSpeechSpeak(text || '', lang, null, rate || 1);
      }
      URL.revokeObjectURL(url);
    };
    _ttsAudio.onerror = onError;
    _ttsAudio.play().catch(onError);
  }
  function stopTtsAudio() {
    if (_ttsAudio) {
      try { _ttsAudio.pause(); } catch (e) {}
      _ttsAudio = null;
    }
  }

  // ---- Phase 2: device-token sync + export/import --------------------------
  var DEVICE_KEY = 'dict_device_token';

  function nowIso() {
    var d = new Date();
    return d.toISOString().slice(0, 19) + 'Z';
  }

  // Stamp + write (same as grade, kept for readability at call sites).
  function touch(id, gradeVal, base, target) {
    return grade(id, gradeVal, base, target);
  }

  function getDeviceToken() {
    try { return localStorage.getItem(DEVICE_KEY) || ''; } catch (e) { return ''; }
  }
  function setDeviceToken(t) {
    try { localStorage.setItem(DEVICE_KEY, t); } catch (e) {}
  }

  // Register (or re-register) the device; idempotent. Resolves to the device
  // token, or '' when offline (never rejects — callers may rely on that).
  function ensureDevice() {
    if (getDeviceToken()) return Promise.resolve(getDeviceToken());
    return fetch('/api/sync/device')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // token travels in the httponly cookie; remember the device id locally
        setDeviceToken(d.device_id || 'device');
        return d.device_id;
      })
      .catch(function () { return ''; });
  }

  // Push local entries to the server, then pull back the merged state and
  // re-store it locally. Always resolves (never rejects); reports the
  // outcome to onStatus: 'synced' | 'pending'.
  function sync(base, target, onStatus) {
    var localCount = Object.keys(readSrs(base, target)).length;
    return ensureDevice().then(function (token) {
      if (!token) {
        if (onStatus) onStatus('pending', localCount);
        return 0;
      }
      var local = readSrs(base, target);
      var out = {};
      for (var k in local) out[k] = local[k];
      var entries = Object.keys(local).map(function (id) {
        var e = local[id] || {};
        return {
          concept_id: id,
          grade: e.grade || '',
          due: e.due || '',
          updated_at: e.updated_at || nowIso()
        };
      });
      // chunked upsert: the server caps one POST at MAX_SYNC_BATCH entries,
      // so a store grown past that cap must not dead-lock device sync.
      var BATCH = 2000;
      var chain = Promise.resolve();
      for (var i = 0; i < entries.length; i += BATCH) {
        var start = i;
        chain = chain.then(function () {
          var chunk = entries.slice(start, start + BATCH);
          return fetch('/api/srs/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base: base, target: target, entries: chunk })
          }).then(function (r) {
            if (!r.ok) throw new Error('sync failed ' + r.status);
            return r;
          });
        });
      }
      return chain.then(function () {
        return fetch('/api/srs?base=' + encodeURIComponent(base) +
          '&target=' + encodeURIComponent(target));
      }).then(function (r) {
        if (!r.ok) throw new Error('sync pull failed ' + r.status);
        return r.json();
      }).then(function (data) {
        // keep the union: local-only entries stay, server entries fill in
        var server = data.entries || {};
        for (var k2 in server) {
          var lts = (out[k2] && out[k2].updated_at) || '';
          var sts = server[k2].updated_at || '';
          if (!(k2 in out) || sts >= lts) out[k2] = server[k2];
        }
        writeSrs(base, target, out);
        if (onStatus) onStatus('synced', Object.keys(out).length);
        return Object.keys(out).length;
      });
    }).catch(function () {
      // offline: keep local state, surface "pending"
      if (onStatus) onStatus('pending', localCount);
      return 0;
    });
  }

  function exportPayload(base, target) {
    return {
      version: 2,
      base: base,
      target: target,
      srs: readSrs(base, target),
      legacy: readLegacy(base, target),
      exported_at: nowIso()
    };
  }

  // Import a previously-exported payload. Per-concept merge: newer updated_at
  // wins; legacy entries are adopted as-is when absent locally.
  function importPayload(base, target, payload) {
    if (!payload || typeof payload !== 'object') return 0;
    var srs = payload.srs || {};
    var legacy = payload.legacy || {};
    var localSrs = readSrs(base, target);
    var localLegacy = readLegacy(base, target);
    for (var k in srs) {
      var lts = (localSrs[k] && localSrs[k].updated_at) || '';
      var sts = srs[k].updated_at || '';
      if (!(k in localSrs) || sts >= lts) localSrs[k] = srs[k];
    }
    for (var k2 in legacy) {
      if (!(k2 in localLegacy)) localLegacy[k2] = legacy[k2];
    }
    writeSrs(base, target, localSrs);
    try { localStorage.setItem(legacyKey(base, target), JSON.stringify(localLegacy)); } catch (e) {}
    return Object.keys(localSrs).length;
  }

  global.Srs = {
    INTERVALS: INTERVALS,
    srsKey: srsKey,
    legacyKey: legacyKey,
    isoFromOffset: isoFromOffset,
    readSrs: readSrs,
    readLegacy: readLegacy,
    writeSrs: writeSrs,
    grade: grade,
    isDone: isDone,
    isDue: isDue,
    dueSet: dueSet,
    shuffle: shuffle,
    speak: speak,
    ttsSource: ttsSource,
    readTtsSettings: readTtsSettings,
    saveTtsSettings: saveTtsSettings,
    // Phase 2
    nowIso: nowIso,
    touch: touch,
    getDeviceToken: getDeviceToken,
    ensureDevice: ensureDevice,
    sync: sync,
    exportPayload: exportPayload,
    importPayload: importPayload
  };
})(typeof window !== 'undefined' ? window : globalThis);
