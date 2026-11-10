/**
 * M3.1: Durable SRS state for the mobile app.
 *
 * Replaces raw localStorage so the whole 12,000-word progress store survives
 * beyond the ~5MB localStorage ceiling. Picks IndexedDB when available
 * (production APK on Android 6+/all modern WebViews), otherwise falls back to
 * localStorage (dev / very old WebViews) with a best-effort size guard.
 *
 * Window.SrsStore:
 *   SrsStore.available      — true if IndexedDB is present
 *   SrsStore.get(key)       — Promise<{}>  read one pair's SRS blob
 *   SrsStore.set(key, obj)  — Promise<void> persist one pair's SRS blob
 *   SrsStore.clear(key)     — Promise<void>
 *   SrsStore.backend        — "indexeddb" | "localstorage"
 */
(function () {
  'use strict';

  var DB_NAME = 'dict-learn';
  var STORE = 'srs';
  var DBOVERFLOW = 4.0 * 1024 * 1024; // ~4MB, stay under the 5MB localStorage cap

  var hasIDB = (typeof window !== 'undefined') && !!window.indexedDB;
  var db = null;

  function open() {
    if (db || !hasIDB) return Promise.resolve(db);
    return new Promise(function (resolve, reject) {
      var req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return open().then(function (d) {
      if (!d) return Promise.resolve({});
      return new Promise(function (resolve) {
        var tx = d.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result || {}); };
        rq.onerror = function () { resolve({}); };
      });
    });
  }

  function idbSet(key, obj) {
    return open().then(function (d) {
      if (!d) return Promise.reject(new Error('indexeddb unavailable'));
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key: key, value: obj });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbClear(key) {
    return open().then(function (d) {
      if (!d) return Promise.reject(new Error('indexeddb unavailable'));
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // localStorage backend (fallback). Whole blob in one key; guard overflow by
  // dropping the oldest (first-inserted) entries so the app keeps working.
  // localStorage backend (fallback). The whole pair blob lives in one key;
  // guard overflow by dropping the oldest entries so the app keeps working.
  // get/set/clear are wrapped in Promise.resolve so callers treat both
  // backends identically (always .then()).
  function lsGet(key) {
    var obj = {};
    try { obj = JSON.parse(localStorage.getItem('srs_' + key) || '{}') || {}; } catch (e) {}
    return Promise.resolve(obj);
  }
  function lsSet(key, obj) {
    var blob = JSON.stringify(obj);
    if (blob.length > DBOVERFLOW) {
      // drop ~25% of entries (object insertion order) and retry once
      var keys = Object.keys(obj);
      var cut = Math.ceil(keys.length * 0.25);
      for (var i = 0; i < cut; i++) delete obj[keys[i]];
      blob = JSON.stringify(obj);
    }
    localStorage.setItem('srs_' + key, blob);
    return Promise.resolve();
  }
  function lsClear(key) {
    localStorage.removeItem('srs_' + key);
    return Promise.resolve();
  }

  window.SrsStore = {
    available: hasIDB,
    get: hasIDB ? idbGet : lsGet,
    set: hasIDB ? idbSet : lsSet,
    clear: hasIDB ? idbClear : lsClear,
    backend: hasIDB ? 'indexeddb' : 'localstorage'
  };
})();
