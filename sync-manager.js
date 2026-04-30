// sync-manager.js — bidirectional state sync between dashboard instances.
//
// Lives in the main process. Two modes (one instance can be both):
//
//   HUB    — host server is running. Other devices connect to us.
//            We receive their writes, fan them out to all OTHER clients,
//            and apply them to our own renderer.
//
//   CLIENT — we are connected to a remote hub via the Servers plugin.
//            Our local writes get sent to the hub. Hub broadcasts mean we
//            apply to our own renderer. We persist an offline queue so writes
//            made while disconnected get flushed on reconnect.
//
// Sync surface: localStorage (loose mirror — deny-listed keys stay local) +
// the user's notes folder (last-write-wins per file by mtime).
//
// Loop prevention: every event carries a `device` field. A device that sees
// its own device id on an incoming event silently ignores it. A "remote
// apply" in the renderer also bypasses the localStorage→sync mirror so the
// applied write doesn't immediately echo back.
//
// Conflict policy: per-key reconciliation on connect, with three modes:
//   - server-wins  → for dashboard:* keys (theme, layout, plugins, folders).
//                    Server's value is adopted regardless of timestamps.
//   - merge        → for keys whose values are arrays of objects (with `id`)
//                    or objects-of-objects. Both sides' items survive.
//   - lww          → everything else; newer wall-clock timestamp wins.
// Custom themes (dashboard:customThemes:v1) override the server-wins rule
// because the user wants them to accumulate across devices.
//
// Once initial reconciliation has run, ongoing sync remains LWW for live
// edits, with the offline queue stale-checked against the current localState
// so reconciled keys don't get clobbered by stale queued events.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ---- Deny list ----
// localStorage keys matching any prefix here NEVER sync. Add new ones here
// when shipping plugins whose state is machine-specific.
const DEFAULT_DENY_PATTERNS = [
  // Internal sync metadata + state we obviously don't replicate
  '__dashboard:sync:',
  'dashboard:minimized:',       // ephemeral UI state — minimize per device
  'dashboard:firstRunComplete:',
  'dashboard:pendingDisableAllPlugins:',

  // Plugins that operate on this machine's specifics
  'plugin:file-explorer:',
  'plugin:terminal:',
  'plugin:browser:',
  'plugin:hardware:',
  'plugin:gpu-stats:',
  'plugin:battery:',
  'plugin:process-monitor:',
  'plugin:network-stats:',
  'plugin:system-stats:',
  'plugin:taskbar:',
  'plugin:launcher:',
  'plugin:audio-visualizer:',  // device IDs
  'plugin:voice recorder:',
  'plugin:disk-usage:',
  'plugin:focus-noise:',       // audio device + volumes are per-device

  // Sync infra — server connections, saved server view state, etc.
  'plugin:servers:',

  // Remote-control plugins — consent, selected device, session ids are local
  'plugin:remote-host:',
  'plugin:remote-viewer:',

  // Cognicore: ephemeral per-device UI state (which note is open, which
  // folders are expanded, which sidebar tab is active). Files themselves
  // sync via the central 'cognicore' vault, not localStorage.
  'plugin:cognicore:last:',
  'plugin:cognicore:expanded:',
  'plugin:cognicore:rightTab:',
  'plugin:cognicore:vault:', // legacy key from before vault migration
];

// ---- Merge helpers (used during reconnect reconciliation) ----
// We try to detect mergeable shapes (array of {id,...} or object-of-objects)
// and combine them so neither device's items get lost when both diverge.

function _isObjectOfObjects(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  return keys.every((k) =>
    typeof v[k] === 'object' && v[k] !== null && !Array.isArray(v[k]));
}

function _idFieldFor(arr) {
  for (const f of ['id', '_id', 'uuid', 'key']) {
    if (arr.length > 0 && typeof arr[0][f] !== 'undefined') return f;
  }
  return null;
}

function _itemTs(item) {
  if (!item || typeof item !== 'object') return 0;
  return Number(item.mtime || item.updatedAt || item.modifiedAt || 0) || 0;
}

function _mergeArrays(local, remote) {
  if (!Array.isArray(local) || !Array.isArray(remote)) return null;
  if (local.length === 0) return remote;
  if (remote.length === 0) return local;
  // Both arrays of objects, with a common id-like field.
  const idField = _idFieldFor(local) || _idFieldFor(remote);
  if (!idField) return null;
  const map = new Map();
  for (const item of remote) {
    if (!item || typeof item !== 'object' || item[idField] == null) continue;
    map.set(item[idField], item);
  }
  for (const item of local) {
    if (!item || typeof item !== 'object' || item[idField] == null) continue;
    const existing = map.get(item[idField]);
    if (!existing) { map.set(item[idField], item); continue; }
    // Both have this id — pick newer if there's a timestamp field.
    if (_itemTs(item) > _itemTs(existing)) map.set(item[idField], item);
  }
  return Array.from(map.values());
}

function _mergeObjects(local, remote) {
  if (!_isObjectOfObjects(local) || !_isObjectOfObjects(remote)) return null;
  const out = { ...remote };
  for (const [k, v] of Object.entries(local)) {
    const existing = out[k];
    if (!existing) { out[k] = v; continue; }
    if (_itemTs(v) > _itemTs(existing)) out[k] = v;
  }
  return out;
}

// Returns merged JSON string, or null if not mergeable.
function tryMergeValues(localStr, remoteStr) {
  if (typeof localStr !== 'string' || typeof remoteStr !== 'string') return null;
  let local, remote;
  try { local = JSON.parse(localStr); remote = JSON.parse(remoteStr); }
  catch { return null; }
  let merged = _mergeArrays(local, remote);
  if (merged == null) merged = _mergeObjects(local, remote);
  if (merged == null) return null;
  try { return JSON.stringify(merged); }
  catch { return null; }
}

// Decide what to do when both devices have a value for the same key.
// Returns one of: { kind: 'server-wins' } | { kind: 'merge', merged } | { kind: 'lww' }
function decidePolicy(key, localVal, remoteVal) {
  // Custom themes — always merge (user wants themes from both devices to accumulate)
  if (key === 'dashboard:customThemes:v1') {
    const m = tryMergeValues(localVal, remoteVal);
    if (m != null) return { kind: 'merge', merged: m };
  }
  // dashboard:* — server wins on every reconnect
  if (/^dashboard:/.test(key)) return { kind: 'server-wins' };
  // plugin:* — merge if values are mergeable (arrays of {id} or object-of-objects)
  if (/^plugin:/.test(key)) {
    const m = tryMergeValues(localVal, remoteVal);
    if (m != null) return { kind: 'merge', merged: m };
  }
  // Everything else: standard last-write-wins
  return { kind: 'lww' };
}

function isDenied(key, patterns) {
  if (!key) return true;
  const list = patterns || DEFAULT_DENY_PATTERNS;
  for (const p of list) if (key.indexOf(p) === 0) return true;
  return false;
}

// ---- Sync manager ----
class SyncManager extends EventEmitter {
  constructor({ stateDir, onApplyToRenderer, onApplyNoteWrite, onApplyNoteRename, onApplyNoteDelete, log }) {
    super();
    this.stateDir = stateDir;
    this.onApplyToRenderer = onApplyToRenderer || (() => {});
    this.onApplyNoteWrite = onApplyNoteWrite || (() => {});
    this.onApplyNoteRename = onApplyNoteRename || (() => {});
    this.onApplyNoteDelete = onApplyNoteDelete || (() => {});
    this.log = log || (() => {});

    fs.mkdirSync(this.stateDir, { recursive: true });

    // Stable device identity
    this.idFile = path.join(this.stateDir, 'device-id');
    this.deviceId = this._loadOrCreateDeviceId();

    // Per-key last-modified timestamp tracker (used both for our local state
    // and for "what timestamp did we last record for this key from any source")
    this.tsFile = path.join(this.stateDir, 'sync-timestamps.json');
    this.timestamps = this._loadJsonSafe(this.tsFile, {});

    // Per-note-path last-modified timestamp tracker
    this.noteTsFile = path.join(this.stateDir, 'sync-note-timestamps.json');
    this.noteTimestamps = this._loadJsonSafe(this.noteTsFile, {});

    // Snapshot of localStorage owned by this device — populated by the
    // renderer at boot and on every write. Used to answer GET /sync/snapshot.
    this.localState = this._loadJsonSafe(path.join(this.stateDir, 'sync-snapshot.json'), {});

    // Offline queue — events to send to the hub when reconnected.
    // Each entry: { kind: 'storage'|'note-write'|'note-rename'|'note-delete', ts, ... }
    this.queueFile = path.join(this.stateDir, 'sync-queue.jsonl');

    // Bypass set: keys for which the next observed local write is actually
    // a remote-applied write that we just routed through the renderer. We
    // skip re-broadcasting it in that case to avoid loops.
    this.bypassKeys = new Set();
    this.bypassNotes = new Set();

    // Hub side: connected client info — populated by activity-server
    this.hubBroadcast = null; // function(event) — set by main when server starts

    // Client side: function to push an event to the hub (provided by main)
    this.clientPush = null;
    this.clientConnected = false;

    this._tsSaveTimer = null;
    this._snapSaveTimer = null;
  }

  // ---- low-level persistence ----
  _loadJsonSafe(file, dflt) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return dflt; }
  }
  _writeJsonDebounced(file, value, ref) {
    clearTimeout(this[ref]);
    this[ref] = setTimeout(() => {
      try { fs.writeFileSync(file, JSON.stringify(value)); } catch {}
    }, 200);
  }
  _persistTimestamps() { this._writeJsonDebounced(this.tsFile, this.timestamps, '_tsSaveTimer'); }
  _persistNoteTimestamps() { this._writeJsonDebounced(this.noteTsFile, this.noteTimestamps, '_ntsSaveTimer'); }
  _persistSnapshot() { this._writeJsonDebounced(path.join(this.stateDir, 'sync-snapshot.json'), this.localState, '_snapSaveTimer'); }

  _loadOrCreateDeviceId() {
    try {
      const id = fs.readFileSync(this.idFile, 'utf8').trim();
      if (id) return id;
    } catch {}
    const id = crypto.randomBytes(8).toString('hex');
    try { fs.writeFileSync(this.idFile, id); } catch {}
    return id;
  }

  // ---- queue ----
  _appendQueue(entry) {
    try {
      fs.appendFileSync(this.queueFile, JSON.stringify(entry) + '\n');
    } catch {}
  }
  async _drainQueue() {
    if (!this.clientConnected || !this.clientPush) return;
    let lines = [];
    try { lines = fs.readFileSync(this.queueFile, 'utf8').split('\n').filter(Boolean); }
    catch { return; }
    if (!lines.length) return;
    this.log('sync', 'queue:drain', { count: lines.length });
    let pushed = 0, skipped = 0;
    for (const line of lines) {
      try {
        const ent = JSON.parse(line);
        // Stale check: if reconciliation overrode our local value (e.g.
        // server-wins or merge), the queued event no longer reflects the
        // current truth. Pushing it would clobber the reconciled value.
        if (ent.kind === 'storage' && ent.key) {
          const cur = this.localState[ent.key];
          const queuedVal = ent.removed ? null : ent.value;
          const curVal = cur == null ? null : cur;
          if (queuedVal !== curVal) { skipped++; continue; }
        }
        await this.clientPush(ent);
        pushed++;
      } catch (err) {
        this.log('sync', 'queue:drain-error', { error: err.message });
        return; // bail; keep the queue file
      }
    }
    this.log('sync', 'queue:drained', { pushed, skipped });
    try { fs.unlinkSync(this.queueFile); } catch {}
  }

  // ---- hub helpers ----
  setHubBroadcast(fn) { this.hubBroadcast = fn; }

  // ---- client helpers ----
  setClientPush(fn) { this.clientPush = fn; }
  setClientConnected(connected) {
    // Note: queue drain is no longer triggered here. The connect flow runs
    // applyAndDiffSnapshot first (which reconciles server-wins / merge / lww
    // per key) and that drains the queue at its end with stale-checks.
    this.clientConnected = !!connected;
  }

  // ---- LOCAL renderer wrote to localStorage ----
  // Called from main when the renderer's preload proxy reports a setItem/removeItem.
  // Returns true if the event was sync-eligible and we routed it.
  recordLocalWrite({ key, value, removed }) {
    if (isDenied(key)) return false;

    // Skip bypass: this write was originated by a remote apply.
    if (this.bypassKeys.has(key)) {
      this.bypassKeys.delete(key);
      return false;
    }

    // Lamport-style timestamp: max(wall clock, lastSeenForKey + 1). This
    // guarantees that a write FOLLOWING a remote write we just received
    // strictly beats it — even if our wall clock is behind the remote's.
    // Without this, two-way sync silently fails on machines with skewed clocks.
    const ts = Math.max(Date.now(), (this.timestamps[key] || 0) + 1);
    this.timestamps[key] = ts;
    this._persistTimestamps();

    if (removed) delete this.localState[key];
    else this.localState[key] = value;
    this._persistSnapshot();

    const event = {
      kind: 'storage',
      device: this.deviceId,
      ts,
      key,
      value: removed ? null : value,
      removed: !!removed,
    };

    // If we are a hub, fan out to clients (other than ourselves — n/a, we're main).
    if (this.hubBroadcast) this.hubBroadcast(event);

    // If we are connected to a remote hub, push to it (or queue).
    if (this.clientPush) {
      if (this.clientConnected) {
        this.clientPush(event).catch(() => this._appendQueue(event));
      } else {
        this._appendQueue(event);
      }
    }
    return true;
  }

  // Bulk seed: called once when renderer mounts so we have a fresh snapshot
  // of its localStorage. Doesn't broadcast — just records.
  seedLocalState(stateMap) {
    if (!stateMap || typeof stateMap !== 'object') return;
    let changed = false;
    for (const [k, v] of Object.entries(stateMap)) {
      if (isDenied(k)) continue;
      if (this.localState[k] !== v) {
        this.localState[k] = v;
        changed = true;
      }
      if (this.timestamps[k] == null) {
        this.timestamps[k] = 0; // unknown — anything from elsewhere will win
      }
    }
    if (changed) this._persistSnapshot();
    this._persistTimestamps();
  }

  // ---- INCOMING event from the network (hub received from client, OR
  //      client received from hub). Apply to our renderer if newer.
  async applyIncoming(event) {
    if (!event || event.device === this.deviceId) return; // loop guard

    if (event.kind === 'storage') {
      const key = event.key;
      if (!key || isDenied(key)) return;
      const localTs = this.timestamps[key] || 0;
      if (event.ts && event.ts <= localTs) return; // stale

      // Bypass next observed local write so the renderer applying this
      // doesn't echo it back.
      this.bypassKeys.add(key);
      this.timestamps[key] = event.ts || Date.now();
      this._persistTimestamps();
      if (event.removed) delete this.localState[key];
      else this.localState[key] = event.value;
      this._persistSnapshot();

      this.onApplyToRenderer({
        kind: 'storage',
        key,
        value: event.value,
        removed: !!event.removed,
        ts: event.ts,
      });
    } else if (event.kind === 'note-write') {
      const p = event.path;
      if (!p) return;
      const localTs = this.noteTimestamps[p] || 0;
      if (event.ts && event.ts <= localTs) return;
      this.noteTimestamps[p] = event.ts || Date.now();
      this._persistNoteTimestamps();
      this.bypassNotes.add(p);
      try { await this.onApplyNoteWrite(p, event.body); }
      catch (err) { this.log('sync', 'note-apply-error', { path: p, error: err.message }); }
    } else if (event.kind === 'note-rename') {
      const from = event.from, to = event.to;
      if (!from || !to) return;
      const localTs = this.noteTimestamps[from] || 0;
      if (event.ts && event.ts <= localTs) return;
      this.noteTimestamps[to] = event.ts || Date.now();
      delete this.noteTimestamps[from];
      this._persistNoteTimestamps();
      this.bypassNotes.add(from); this.bypassNotes.add(to);
      try { await this.onApplyNoteRename(from, to); }
      catch (err) { this.log('sync', 'note-rename-error', { from, to, error: err.message }); }
    } else if (event.kind === 'note-delete') {
      const p = event.path;
      if (!p) return;
      this.noteTimestamps[p] = event.ts || Date.now();
      this._persistNoteTimestamps();
      this.bypassNotes.add(p);
      try { await this.onApplyNoteDelete(p); }
      catch (err) { this.log('sync', 'note-delete-error', { path: p, error: err.message }); }
    }

    // Re-broadcast on the hub side so other clients see it too.
    if (this.hubBroadcast) this.hubBroadcast(event);
  }

  // ---- LOCAL note operations on this device ----
  // Called by main.js after a local notes:write/rename/delete IPC
  // succeeds. Generates an event, broadcasts/queues it.
  recordNoteOp(kind, payload) {
    // Lamport-style: see recordLocalWrite for the reasoning.
    const stamp = (path) => {
      const t = Math.max(Date.now(), (this.noteTimestamps[path] || 0) + 1);
      return t;
    };
    if (kind === 'write') {
      const p = payload.path;
      if (this.bypassNotes.has(p)) { this.bypassNotes.delete(p); return; }
      const ts = stamp(p);
      this.noteTimestamps[p] = ts;
      this._persistNoteTimestamps();
      const ev = { kind: 'note-write', device: this.deviceId, ts, path: p, body: payload.body };
      this._dispatchOutgoing(ev);
    } else if (kind === 'rename') {
      const from = payload.from, to = payload.to;
      if (this.bypassNotes.has(from) || this.bypassNotes.has(to)) {
        this.bypassNotes.delete(from); this.bypassNotes.delete(to);
        return;
      }
      const ts = Math.max(stamp(from), stamp(to));
      this.noteTimestamps[to] = ts;
      delete this.noteTimestamps[from];
      this._persistNoteTimestamps();
      const ev = { kind: 'note-rename', device: this.deviceId, ts, from, to };
      this._dispatchOutgoing(ev);
    } else if (kind === 'delete') {
      const p = payload.path;
      if (this.bypassNotes.has(p)) { this.bypassNotes.delete(p); return; }
      const ts = stamp(p);
      this.noteTimestamps[p] = ts;
      this._persistNoteTimestamps();
      const ev = { kind: 'note-delete', device: this.deviceId, ts, path: p };
      this._dispatchOutgoing(ev);
    }
  }

  _dispatchOutgoing(event) {
    if (this.hubBroadcast) this.hubBroadcast(event);
    if (this.clientPush) {
      if (this.clientConnected) {
        this.clientPush(event).catch(() => this._appendQueue(event));
      } else {
        this._appendQueue(event);
      }
    }
  }

  // ---- SNAPSHOT (used by hub to answer /sync/snapshot, and by client to
  //      pull on first connect) ----
  // Includes localStorage state + per-key timestamps + per-note timestamps.
  // The receiver merges using last-write-wins.
  buildSnapshot() {
    return {
      device: this.deviceId,
      ts: Date.now(),
      storage: { ...this.localState },
      timestamps: { ...this.timestamps },
      noteTimestamps: { ...this.noteTimestamps },
    };
  }

  // Reconcile local state against a freshly-pulled server snapshot.
  // For each key (union of local + remote):
  //   - only-remote: pull
  //   - only-local: push
  //   - both: apply policy (server-wins / merge / lww)
  // After reconciliation, drain the offline queue with stale-checking.
  async applyAndDiffSnapshot(snapshot, getNoteList, readNote) {
    if (!snapshot || snapshot.device === this.deviceId) return;

    const remoteStorage = snapshot.storage || {};
    const remoteTs = snapshot.timestamps || {};
    const allKeys = new Set([
      ...Object.keys(remoteStorage),
      ...Object.keys(this.localState),
    ]);

    let mergedCount = 0, serverWinsCount = 0, pushedCount = 0, pulledCount = 0;

    const pushNow = async (ev) => {
      if (!this.clientPush) return;
      try { await this.clientPush(ev); }
      catch { this._appendQueue(ev); }
    };

    for (const k of allKeys) {
      if (isDenied(k)) continue;
      const remoteHas = Object.prototype.hasOwnProperty.call(remoteStorage, k);
      const localHas  = Object.prototype.hasOwnProperty.call(this.localState, k);
      const remoteVal = remoteHas ? remoteStorage[k] : undefined;
      const localVal  = localHas  ? this.localState[k]  : undefined;
      const rTs = remoteTs[k] || 0;
      const lTs = this.timestamps[k] || 0;

      if (remoteHas && !localHas) {
        // Pull from remote
        await this.applyIncoming({
          kind: 'storage', device: snapshot.device, ts: rTs || Date.now(),
          key: k, value: remoteVal, removed: false,
        });
        pulledCount++;
        continue;
      }

      if (localHas && !remoteHas) {
        // Push to remote — laptop's value populates the server
        const ts = lTs || Date.now();
        await pushNow({
          kind: 'storage', device: this.deviceId, ts,
          key: k, value: localVal, removed: false,
        });
        pushedCount++;
        continue;
      }

      // Both have values — decide policy
      if (localVal === remoteVal) continue; // already in sync

      const policy = decidePolicy(k, localVal, remoteVal);

      if (policy.kind === 'server-wins') {
        // Adopt server's value regardless of timestamps
        const newTs = Math.max(rTs, lTs) + 1;
        await this.applyIncoming({
          kind: 'storage', device: snapshot.device, ts: newTs,
          key: k, value: remoteVal, removed: false,
        });
        serverWinsCount++;
      } else if (policy.kind === 'merge') {
        const newTs = Math.max(rTs, lTs) + 1;
        // Apply merged value locally
        await this.applyIncoming({
          kind: 'storage', device: snapshot.device, ts: newTs,
          key: k, value: policy.merged, removed: false,
        });
        // Push merged value to server so it has the same merged result
        await pushNow({
          kind: 'storage', device: this.deviceId, ts: newTs,
          key: k, value: policy.merged, removed: false,
        });
        mergedCount++;
      } else {
        // LWW
        if (rTs > lTs) {
          await this.applyIncoming({
            kind: 'storage', device: snapshot.device, ts: rTs,
            key: k, value: remoteVal, removed: false,
          });
          pulledCount++;
        } else if (lTs > rTs) {
          await pushNow({
            kind: 'storage', device: this.deviceId, ts: lTs,
            key: k, value: localVal, removed: false,
          });
          pushedCount++;
        }
        // equal timestamps: leave as-is
      }
    }

    if (mergedCount + serverWinsCount + pushedCount + pulledCount > 0) {
      this.log('sync', 'reconcile-summary', {
        merged: mergedCount, serverWins: serverWinsCount,
        pushed: pushedCount, pulled: pulledCount,
      });
    }

    // ---- notes merge ----
    if (typeof getNoteList === 'function' && typeof readNote === 'function') {
      const remoteNoteTs = snapshot.noteTimestamps || {};
      // We only know about the remote's note paths via timestamps —
      // but the snapshot doesn't ship full note bodies (notes can be large).
      // The client requests bodies for paths it doesn't have or has older
      // versions of via /sync/note?path=…
      for (const [p, rTs] of Object.entries(remoteNoteTs)) {
        const localTs = this.noteTimestamps[p] || 0;
        if (rTs > localTs) {
          // Caller should fetch and apply via applyIncoming({kind:'note-write'})
          this.emit('snapshot:want-note', p);
        }
      }
      // Push our local notes that the remote doesn't have or has older
      let localNotes;
      try { localNotes = await getNoteList(); } catch { localNotes = []; }
      for (const n of localNotes) {
        const p = n.path;
        const localTs = this.noteTimestamps[p] || n.mtime || 0;
        if (this.noteTimestamps[p] == null) {
          this.noteTimestamps[p] = localTs;
        }
        const rTs = remoteNoteTs[p] || 0;
        if (localTs > rTs) {
          let body;
          try { body = await readNote(p); } catch { continue; }
          const ev = { kind: 'note-write', device: this.deviceId, ts: localTs, path: p, body };
          if (this.clientPush && this.clientConnected) {
            try { await this.clientPush(ev); } catch { this._appendQueue(ev); }
          }
        }
      }
      this._persistNoteTimestamps();
    }

    // After reconciliation, drain any offline-queued events. Events whose
    // value no longer matches our (post-reconcile) localState are skipped
    // so reconciled values aren't clobbered by stale queued writes.
    await this._drainQueue();
  }
}

module.exports = { SyncManager, DEFAULT_DENY_PATTERNS, isDenied };
