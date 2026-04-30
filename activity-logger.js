// activity-logger.js — append-only JSONL log of everything the user does
// in the dashboard. Lives in userData/activity/, one file per UTC day.
// Writes are non-blocking (queued); readers stream live via subscribe().
//
// Event shape:
//   { ts, source, channel, event, payload, ok, ms, error? }
//
// `source` is one of: ipc | localStorage | activity | system
// `channel` is the IPC channel name or the localStorage key, etc.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');

class ActivityLogger {
  constructor(dir) {
    this.dir = dir;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(50);
    this.queue = [];
    this.flushing = false;
    this.currentDay = null;
    this.currentStream = null;
    this.tail = []; // last N events for the live UI feed
    this.tailMax = 100;
    this.enabled = true;
    this.redactKeys = ['password', 'token', 'authorization', 'secret', 'apiKey', 'api_key', 'auth'];
    fs.mkdirSync(this.dir, { recursive: true });
  }

  setEnabled(v) { this.enabled = !!v; }

  // Truncate large strings/buffers and redact obvious secrets so the log
  // stays readable and doesn't accidentally capture credentials.
  sanitize(value, depth) {
    if (depth > 4) return '[depth]';
    if (value == null) return value;
    const t = typeof value;
    if (t === 'string') return value.length > 4096 ? value.slice(0, 4096) + `…[+${value.length - 4096}]` : value;
    if (t === 'number' || t === 'boolean') return value;
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length}b]`;
    if (Array.isArray(value)) {
      if (value.length > 50) return value.slice(0, 50).map((v) => this.sanitize(v, depth + 1)).concat([`…[+${value.length - 50}]`]);
      return value.map((v) => this.sanitize(v, depth + 1));
    }
    if (t === 'object') {
      const out = {};
      let i = 0;
      for (const k of Object.keys(value)) {
        if (i++ > 50) { out['…'] = `[+${Object.keys(value).length - 50} keys]`; break; }
        const lower = String(k).toLowerCase();
        if (this.redactKeys.some((r) => lower.includes(r.toLowerCase()))) {
          out[k] = '[redacted]';
        } else {
          out[k] = this.sanitize(value[k], depth + 1);
        }
      }
      return out;
    }
    return String(value);
  }

  fileFor(date) {
    const d = date || new Date();
    const day = d.toISOString().slice(0, 10); // YYYY-MM-DD
    return { day, file: path.join(this.dir, `activity-${day}.jsonl`) };
  }

  async getStream() {
    const { day, file } = this.fileFor();
    if (this.currentDay === day && this.currentStream && !this.currentStream.destroyed) {
      return this.currentStream;
    }
    if (this.currentStream && !this.currentStream.destroyed) {
      try { this.currentStream.end(); } catch {}
    }
    this.currentDay = day;
    this.currentStream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    return this.currentStream;
  }

  log(source, channel, payload, extras) {
    if (!this.enabled) return;
    const entry = {
      ts: Date.now(),
      source: String(source || 'unknown'),
      channel: String(channel || ''),
      ...(extras || {}),
      payload: this.sanitize(payload, 0),
    };

    // Live feed for the Host tab
    this.tail.push(entry);
    if (this.tail.length > this.tailMax) this.tail.shift();
    try { this.bus.emit('event', entry); } catch {}

    this.queue.push(entry);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushing) return;
    this.flushing = true;
    // microtask + small delay to batch bursts of events into one write
    setTimeout(() => this.flush().catch((err) => {
      console.error('[activity] flush error:', err.message);
      this.flushing = false;
    }), 50);
  }

  async flush() {
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.queue.length);
        const lines = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
        const stream = await this.getStream();
        await new Promise((resolve, reject) => {
          stream.write(lines, (err) => err ? reject(err) : resolve());
        });
      }
    } finally {
      this.flushing = false;
    }
  }

  subscribe(cb) {
    this.bus.on('event', cb);
    return () => this.bus.off('event', cb);
  }

  getTail(limit) {
    const n = Math.max(0, Math.min(this.tailMax, Number(limit) || this.tailMax));
    return this.tail.slice(-n);
  }

  // List available log files (day -> file path + size)
  async listDays() {
    try {
      const names = await fsp.readdir(this.dir);
      const days = [];
      for (const n of names) {
        const m = n.match(/^activity-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m) continue;
        const full = path.join(this.dir, n);
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch {}
        days.push({ day: m[1], file: full, size });
      }
      days.sort((a, b) => a.day.localeCompare(b.day));
      return days;
    } catch {
      return [];
    }
  }

  // Read events from one or more days, optionally filtered by `since` (ms).
  async readEvents(opts) {
    const o = opts || {};
    const sinceMs = Number(o.since) || 0;
    const limit = Math.min(10000, Number(o.limit) || 1000);
    const days = await this.listDays();
    const out = [];
    // newest day last; we may need to read multiple days for large since/limit
    for (const d of days) {
      // Skip whole days that end before `since`
      if (sinceMs) {
        // The date string is UTC midnight; events may extend into next day,
        // so we conservatively read any day whose midnight isn't already past `since` by >24h.
        const dayEnd = Date.parse(d.day + 'T23:59:59.999Z');
        if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue;
      }
      let text;
      try { text = await fsp.readFile(d.file, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (sinceMs && ev.ts < sinceMs) continue;
          out.push(ev);
          if (out.length > limit + 1) out.shift();
        } catch { /* skip malformed */ }
      }
    }
    return out.slice(-limit);
  }

  async clear() {
    try {
      if (this.currentStream) { try { this.currentStream.end(); } catch {} this.currentStream = null; this.currentDay = null; }
      const days = await this.listDays();
      for (const d of days) { try { await fsp.unlink(d.file); } catch {} }
      this.tail = [];
      return { ok: true, removed: days.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = { ActivityLogger };
