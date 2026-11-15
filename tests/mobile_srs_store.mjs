/**
 * M3.1 verification: SrsStore backend behavior.
 * Runs srs-store.js inside isolated vm contexts:
 *   1. No IndexedDB  -> localStorage backend (round-trip + overflow trim)
 *   2. Fake IndexedDB -> indexeddb backend (round-trip + clear)
 * Usage: node tests/mobile_srs_store.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'mobile', 'www', 'srs-store.js'), 'utf8');

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// Minimal in-memory IndexedDB shim (only the surface srs-store.js uses).
function fakeIndexedDB() {
  const tables = new Map(); // key -> value
  function open() {
    const db = {
      objectStoreNames: { contains: () => true },
      transaction() {
        const tx = { objectStore: null, oncomplete: null, onerror: null };
        const complete = () => setImmediate(() => tx.oncomplete && tx.oncomplete());
        tx.objectStore = () => ({
          get(k) {
            const rq = {};
            setImmediate(() => {
              // Real IndexedDB with keyPath:'key' returns the full stored row `{ key, value }`!
              rq.result = tables.has(k) ? tables.get(k) : undefined;
              rq.onsuccess && rq.onsuccess();
            });
            return rq;
          },
          put(obj) { tables.set(obj.key, obj); complete(); return { oncomplete() {}, onerror() {} }; },
          delete(k) { tables.delete(k); complete(); return { oncomplete() {}, onerror() {} }; },
        });
        return tx;
      },
    };
    const req = {};
    req.result = db;
    setImmediate(() => req.onsuccess && req.onsuccess());
    return req;
  }
  return { open, _tables: tables };
}

function runStoreTest(kind) {
  const sandbox = { window: {}, localStorage: makeLocalStorage() };
  sandbox.window = sandbox; // `window.SrsStore` set on the sandbox
  if (kind === 'idb') sandbox.window.indexedDB = fakeIndexedDB();
  else delete sandbox.window.indexedDB;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'srs-store.js' });
  return sandbox.window.SrsStore;
}

(async () => {
  // --- localStorage backend ------------------------------------------------
  {
    const store = runStoreTest('localstorage');
    assert.strictEqual(store.backend, 'localstorage', 'expected localStorage backend');
    const empty = JSON.stringify(await store.get('pair1'));
    assert.strictEqual(empty, '{}', 'empty get -> {}');
    await store.set('pair1', { A: { grade: 'good', due: '2026-11-16' } });
    let s2 = await store.get('pair1');
    assert.strictEqual(JSON.stringify(s2), JSON.stringify({ A: { grade: 'good', due: '2026-11-16' } }), 'round-trip');
    // overflow trim: >4MB blob keeps ~75%
    const big = {};
    for (let i = 0; i < 300000; i++) big['k' + i] = 'x'.repeat(20);
    await store.set('big', big);
    const back = await store.get('big');
    const n = Object.keys(back).length;
    assert.ok(n < 300000 && n > 150000, 'overflow trimmed to ~75% (got ' + n + ')');
    await store.clear('pair1');
    s2 = await store.get('pair1');
    assert.strictEqual(JSON.stringify(s2), '{}', 'clear works');
    console.log('OK  localStorage backend (round-trip, overflow trim, clear)');
  }

  // --- IndexedDB backend ----------------------------------------------------
  {
    const store = runStoreTest('idb');
    assert.strictEqual(store.backend, 'indexeddb', 'expected indexeddb backend');
    await store.set('vi_en', { X: { grade: 'ok', due: '2026-11-12' } });
    const got = await store.get('vi_en');
    assert.strictEqual(JSON.stringify(got), JSON.stringify({ X: { grade: 'ok', due: '2026-11-12' } }), 'idb round-trip');
    await store.clear('vi_en');
    const cleared = await store.get('vi_en');
    assert.strictEqual(JSON.stringify(cleared), '{}', 'idb clear');
    // Recovery from nested `{ key, value }` wrapper rows created by older builds
    const wrapped = { key: 'nested', value: { key: 'nested', value: { A: { grade: 'good' } }, B: { grade: 'ok' } }, C: { grade: 'hard' } };
    await store.set('nested', wrapped);
    const recovered = await store.get('nested');
    assert.strictEqual(recovered.A.grade, 'good', 'recovered deep nested A');
    assert.strictEqual(recovered.B.grade, 'ok', 'recovered mid nested B');
    assert.strictEqual(recovered.C.grade, 'hard', 'recovered outer C');
    assert.strictEqual(recovered.key, undefined, 'stray key stripped');
    assert.strictEqual(recovered.value, undefined, 'stray value stripped');
    console.log('OK  IndexedDB backend (real row shape, legacy wrapper recovery, clear)');
  }

  console.log('srs-store: all tests passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
