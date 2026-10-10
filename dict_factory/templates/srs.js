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
    store[id] = { grade: gradeVal, due: isoFromOffset(INTERVALS[gradeVal]) };
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
    speak: speak
  };
})(typeof window !== 'undefined' ? window : globalThis);
