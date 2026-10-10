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

  // A card is due when new, hard (always resurfaces), or its due date has
  // arrived. Legacy-migrated and never-graded cards are due.
  function isDue(id, base, target, todayIso) {
    var srs = readSrs(base, target);
    var legacy = readLegacy(base, target);
    var entry = srs[id];
    var t = todayIso || isoFromOffset(0);
    if (entry && entry.grade) {
      if (entry.grade === 'hard') return true;
      return !entry.due || entry.due <= t;
    }
    if (legacy[id]) return true;
    return true;
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

  // Speaks `text` with a voice for `langCode`. Shows a visible note instead
  // of failing silently when the device has no voice for that language.
  // `notify` receives the message string when speech cannot be played.
  function speak(text, langCode, notify) {
    if (!text) return;
    if (!('speechSynthesis' in window)) {
      if (notify) notify('Thiết bị không hỗ trợ đọc văn bản.');
      return;
    }
    var voices = window.speechSynthesis.getVoices();
    var prefix = String(langCode || '').toLowerCase();
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
    if (match) u.voice = match;
    window.speechSynthesis.speak(u);
    if (!match && notify) {
      notify('Thiết bị chưa có giọng cho ngôn ngữ này — bật đọc thử không khả dụng.');
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

  // Register (or re-register) the device; idempotent. Returns a Promise that
  // resolves when the token is ready.
  function ensureDevice() {
    if (getDeviceToken()) return Promise.resolve(getDeviceToken());
    return fetch('/api/sync/device')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // token travels in the httponly cookie; store the device_id for display
        setDeviceToken(d.device_id || 'device');
        return d.device_id;
      });
  }

  // Push local entries to the server, then pull back the merged state and
  // re-store it locally. Returns a Promise resolving to the entry count.
  function sync(base, target, onStatus) {
    return ensureDevice().then(function () {
      var local = readSrs(base, target);
      var entries = Object.keys(local).map(function (id) {
        var e = local[id] || {};
        return {
          concept_id: id,
          grade: e.grade || '',
          due: e.due || '',
          updated_at: e.updated_at || nowIso()
        };
      });
      return fetch('/api/srs/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: base, target: target, entries: entries })
      }).then(function (r) {
        if (!r.ok) throw new Error('sync failed ' + r.status);
        return r.json();
      }).then(function (data) {
        var merged = data.entries || {};
        // keep the union: local-only entries stay, server entries fill in
        var out = {};
        for (var k in local) out[k] = local[k];
        for (var k2 in merged) {
          var lts = (local[k2] && local[k2].updated_at) || '';
          var sts = merged[k2].updated_at || '';
          if (!(k2 in local) || sts >= lts) out[k2] = merged[k2];
        }
        writeSrs(base, target, out);
        if (onStatus) onStatus('synced', Object.keys(out).length);
        return Object.keys(out).length;
      }).catch(function (e) {
        // offline: keep local state, surface "pending"
        if (onStatus) onStatus('pending', Object.keys(readSrs(base, target)).length);
      });
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
    shuffle: shuffle,
    speak: speak,
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
