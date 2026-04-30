// Main-world script: wraps localStorage so we can mirror writes to the
// host's activity log AND the multi-device sync system.
//
// MUST run in the main (page) world, not the preload's isolated world. With
// contextIsolation enabled, a wrapper installed in the preload doesn't see
// writes that originate in the page (React, plugins, devtools console). So
// this script runs in index.html before app.js.
//
// It calls back into the preload via window.__dashboardSyncInternal, which
// the preload exposes through contextBridge.

(function () {
  if (window.__dashboardMirrored) return;
  window.__dashboardMirrored = true;

  // Bypass set: keys to skip mirroring on the next write because they
  // originated as a remote-applied sync event. Lives in the main world so
  // the apply pathway (executeJavaScript from main) can set/clear it.
  if (!window.__dashboardSyncBypass) window.__dashboardSyncBypass = new Set();
  const bypass = window.__dashboardSyncBypass;

  let ls;
  try { ls = window.localStorage; } catch { return; }
  if (!ls) return;

  const origSet = ls.setItem.bind(ls);
  const origRemove = ls.removeItem.bind(ls);
  const origClear = ls.clear.bind(ls);

  const report = (event, key, value) => {
    const api = window.__dashboardSyncInternal;
    if (!api || typeof api.reportLocalWrite !== 'function') return;
    try { api.reportLocalWrite(event, key, value); } catch {}
  };

  // Send a one-time seed of the current localStorage state to main so the
  // sync manager has a baseline. Done after both worlds are wired up; we
  // poll briefly for __dashboardSyncInternal in case preload runs slightly
  // after this script (it shouldn't, but be defensive).
  const seedOnce = () => {
    const api = window.__dashboardSyncInternal;
    if (!api || typeof api.seedSnapshot !== 'function') return false;
    const snapshot = {};
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k) continue;
      try { snapshot[k] = ls.getItem(k); } catch {}
    }
    try { api.seedSnapshot(snapshot); } catch {}
    return true;
  };
  if (!seedOnce()) {
    let tries = 0;
    const id = setInterval(() => {
      if (seedOnce() || ++tries > 20) clearInterval(id);
    }, 100);
  }

  ls.setItem = function (key, value) {
    const r = origSet(key, value);
    if (!bypass.has(key)) report('setItem', key, value);
    return r;
  };
  ls.removeItem = function (key) {
    const r = origRemove(key);
    if (!bypass.has(key)) report('removeItem', key, null);
    return r;
  };
  // Don't sync clear() — too dangerous to wipe both devices because a plugin
  // called clear(). Still log it locally though.
  ls.clear = function () {
    const r = origClear();
    const api = window.__dashboardSyncInternal;
    if (api && typeof api.reportLocalClear === 'function') {
      try { api.reportLocalClear(); } catch {}
    }
    return r;
  };

  // Apply a remote-incoming write WITHOUT echoing it back through the
  // mirror. Called from main via executeJavaScript when a sync event arrives.
  window.__dashboardApplyRemoteWrite = function (key, value, removed) {
    if (typeof key !== 'string' || !key) return;
    const oldVal = (() => { try { return ls.getItem(key); } catch { return null; } })();
    bypass.add(key);
    try {
      if (removed) origRemove(key);
      else origSet(key, value);
    } finally {
      // Clear bypass on next tick — synchronous storage event handlers have
      // fired by then.
      setTimeout(() => bypass.delete(key), 0);
    }
    // Fire a synthetic StorageEvent so plugins that listen for cross-tab
    // writes pick it up.
    try {
      const ev = new StorageEvent('storage', {
        key, oldValue: oldVal, newValue: removed ? null : value,
        storageArea: ls, url: location.href,
      });
      window.dispatchEvent(ev);
    } catch {}
    // Custom event for the App component / fine-grained listeners.
    try {
      window.dispatchEvent(new CustomEvent('dashboard:remote-sync', {
        detail: { key, value: removed ? null : value, removed: !!removed },
      }));
    } catch {}
  };
})();
