// activity-server.js — HTTP+SSE server with password + session auth.
// Bound to 127.0.0.1 by default; toggle `lan` to bind to 0.0.0.0.
// Designed to be reachable over a Tailscale tailnet (or LAN) — auth must
// hold up assuming a determined attacker can reach the port.
//
// Endpoints:
//   GET  /                 — plaintext "ok" (no auth)
//   GET  /status           — JSON status (no auth)
//   POST /login            — body {password}, returns {token, expiresAt}
//                            rate-limited: 5 attempts / 15 min per IP
//   POST /logout           — invalidates current session (auth)
//   GET  /events           — historical events (auth) ?since=<ms>&limit=<n>
//   GET  /stream           — SSE live feed (auth)
//   GET  /tail             — recent in-memory events (auth)
//   GET  /export           — full JSONL dump (auth)
//   POST /log              — accept an external event (auth)
//
// Auth: `Authorization: Bearer <session-token>` header, OR `?token=<>` query.
// Sessions live in memory only and expire after SESSION_TTL_MS.

const http = require('http');
const url = require('url');
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;            // 15 minutes
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
    }, (err, key) => err ? reject(err) : resolve(key));
  });
}

function ctEq(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

class ActivityServer {
  constructor(logger) {
    this.logger = logger;
    this.server = null;
    this.port = 7878;
    this.lan = false;
    this.startedAt = 0;
    this.connections = new Set();
    this.sseClients = new Set();
    this.unsubLogger = null;
    // Optional sync hooks — set by main when SyncManager is wired up.
    // sync.handler({event}) processes incoming events from a client.
    // sync.snapshot() returns a snapshot object.
    // sync.readNoteBody(path) returns the body of a note for /sync/note.
    this.sync = null;

    // Auth state — set via setCredentials() before start()
    this.passwordHashHex = null;
    this.passwordSaltHex = null;

    // In-memory session table: token -> { expiresAt }
    this.sessions = new Map();
    // Per-IP failed-login state: ip -> { fails, lockedUntil }
    this.loginFails = new Map();
  }

  isRunning() { return !!this.server && this.server.listening; }

  status() {
    return {
      running: this.isRunning(),
      port: this.port,
      lan: this.lan,
      bind: this.lan ? '0.0.0.0' : '127.0.0.1',
      passwordSet: !!this.passwordHashHex,
      startedAt: this.startedAt,
      sseClients: this.sseClients.size,
      sessions: this.sessions.size,
    };
  }

  setCredentials({ passwordHashHex, passwordSaltHex }) {
    this.passwordHashHex = passwordHashHex || null;
    this.passwordSaltHex = passwordSaltHex || null;
    // New password = wipe all existing sessions
    this.sessions.clear();
  }

  async verifyPassword(password) {
    if (!this.passwordHashHex || !this.passwordSaltHex) return false;
    if (typeof password !== 'string' || !password) return false;
    const salt = Buffer.from(this.passwordSaltHex, 'hex');
    const computed = await scryptHash(password, salt);
    const stored = Buffer.from(this.passwordHashHex, 'hex');
    if (computed.length !== stored.length) return false;
    return crypto.timingSafeEqual(computed, stored);
  }

  issueSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { expiresAt });
    return { token, expiresAt };
  }

  validateSession(token) {
    if (!token) return false;
    const s = this.sessions.get(token);
    if (!s) return false;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  // Periodic cleanup of expired sessions and lockouts
  reap() {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(t);
    for (const [ip, f] of this.loginFails) {
      if (f.lockedUntil && f.lockedUntil < now) this.loginFails.delete(ip);
    }
  }

  rateLimitCheck(ip) {
    const f = this.loginFails.get(ip);
    if (!f) return { ok: true };
    if (f.lockedUntil && f.lockedUntil > Date.now()) {
      return { ok: false, retryAfterMs: f.lockedUntil - Date.now() };
    }
    return { ok: true };
  }

  recordLoginFailure(ip) {
    const f = this.loginFails.get(ip) || { fails: 0, lockedUntil: 0 };
    f.fails += 1;
    if (f.fails >= LOGIN_MAX_FAILS) {
      f.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
      f.fails = 0;
    }
    this.loginFails.set(ip, f);
  }

  recordLoginSuccess(ip) {
    this.loginFails.delete(ip);
  }

  async start({ port, lan } = {}) {
    if (this.isRunning()) await this.stop();
    if (typeof port === 'number') this.port = port;
    if (typeof lan === 'boolean') this.lan = lan;
    if (!this.passwordHashHex) throw new Error('password not set');

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.on('connection', (sock) => {
        this.connections.add(sock);
        sock.on('close', () => this.connections.delete(sock));
      });
      srv.on('error', (err) => reject(err));
      srv.listen(this.port, this.lan ? '0.0.0.0' : '127.0.0.1', () => {
        this.server = srv;
        this.startedAt = Date.now();
        this.unsubLogger = this.logger.subscribe((ev) => this.broadcast(ev));
        this.reapTimer = setInterval(() => this.reap(), 60_000);
        resolve(this.status());
      });
    });
  }

  async stop() {
    if (this.unsubLogger) { try { this.unsubLogger(); } catch {} this.unsubLogger = null; }
    if (this.reapTimer) { clearInterval(this.reapTimer); this.reapTimer = null; }
    for (const c of this.sseClients) { try { c.end(); } catch {} }
    this.sseClients.clear();
    for (const sock of this.connections) { try { sock.destroy(); } catch {} }
    this.connections.clear();
    this.sessions.clear();
    if (!this.server) return this.status();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.startedAt = 0;
    return this.status();
  }

  authOk(req, parsed) {
    const header = req.headers['authorization'] || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    const fromHeader = m ? m[1].trim() : '';
    const fromQuery = parsed.query && parsed.query.token ? String(parsed.query.token) : '';
    const presented = fromHeader || fromQuery;
    return this.validateSession(presented);
  }

  send(res, status, body, headers) {
    const isString = typeof body === 'string';
    const buf = isString ? Buffer.from(body, 'utf8') : Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'Content-Type': isString ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      ...(headers || {}),
    });
    res.end(buf);
  }

  broadcast(ev) {
    if (!this.sseClients.size) return;
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(line); } catch { /* cleaned up on close */ }
    }
  }

  // Send a sync event over the same SSE stream, marked with a different
  // top-level kind so clients can route it.
  broadcastSync(syncEvent) {
    if (!this.sseClients.size) return;
    const wrapped = { __dashboard_sync: true, ...syncEvent };
    const line = `data: ${JSON.stringify(wrapped)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(line); } catch {}
    }
  }

  setSync(hooks) { this.sync = hooks || null; }

  readBody(req, max = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > max) { req.destroy(); reject(new Error('body too large')); }
      });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
  }

  clientIp(req) {
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  async handle(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    if (pathname === '/' && method === 'GET') {
      return this.send(res, 200, 'dashboard activity server: ok\n');
    }
    if (pathname === '/status' && method === 'GET') {
      return this.send(res, 200, this.status());
    }

    // ---- /login ----
    if (pathname === '/login' && method === 'POST') {
      const ip = this.clientIp(req);
      const rl = this.rateLimitCheck(ip);
      if (!rl.ok) {
        return this.send(res, 429, {
          error: 'too_many_attempts',
          retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
        });
      }
      let body;
      try { body = await this.readBody(req); }
      catch (err) { return this.send(res, 400, { error: 'bad_request' }); }
      let password = '';
      try {
        const o = body ? JSON.parse(body) : {};
        password = String(o.password || '');
      } catch { return this.send(res, 400, { error: 'bad_json' }); }
      if (!password) {
        this.recordLoginFailure(ip);
        return this.send(res, 401, { error: 'invalid_password' });
      }
      const ok = await this.verifyPassword(password);
      if (!ok) {
        this.recordLoginFailure(ip);
        this.logger.log('system', 'host:login-failed', { ip });
        return this.send(res, 401, { error: 'invalid_password' });
      }
      this.recordLoginSuccess(ip);
      const sess = this.issueSession();
      this.logger.log('system', 'host:login-ok', { ip, expiresAt: sess.expiresAt });
      return this.send(res, 200, sess);
    }

    // ---- /logout ----
    if (pathname === '/logout' && method === 'POST') {
      const header = req.headers['authorization'] || '';
      const m = header.match(/^Bearer\s+(.+)$/i);
      const tok = m ? m[1].trim() : (parsed.query.token || '');
      if (tok) this.sessions.delete(tok);
      return this.send(res, 200, { ok: true });
    }

    // Everything below requires a valid session
    if (!this.authOk(req, parsed)) {
      return this.send(res, 401, { error: 'unauthorized' });
    }

    if (pathname === '/events' && method === 'GET') {
      try {
        const events = await this.logger.readEvents({
          since: parsed.query.since,
          limit: parsed.query.limit,
        });
        return this.send(res, 200, { events });
      } catch (err) {
        return this.send(res, 500, { error: err.message });
      }
    }

    if (pathname === '/tail' && method === 'GET') {
      const limit = Number(parsed.query.limit) || undefined;
      return this.send(res, 200, { events: this.logger.getTail(limit) });
    }

    if (pathname === '/stream' && method === 'GET') {
      // Disable Nagle on this socket so each event flushes immediately
      // instead of waiting for ~40ms or a full segment to fill.
      try { req.socket.setNoDelay(true); } catch {}
      try { req.socket.setKeepAlive(true, 30000); } catch {}

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      // Send a comment line immediately so any HTTP response buffer flushes
      // and the client knows the stream is live.
      try { res.write(': connected\n\n'); } catch {}
      for (const ev of this.logger.getTail(50)) {
        try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
      }
      this.sseClients.add(res);
      const ping = setInterval(() => {
        try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
      }, 25000);
      req.on('close', () => {
        clearInterval(ping);
        this.sseClients.delete(res);
      });
      return;
    }

    if (pathname === '/export' && method === 'GET') {
      try {
        const days = await this.logger.listDays();
        res.writeHead(200, {
          'Content-Type': 'application/x-jsonlines; charset=utf-8',
          'Content-Disposition': 'attachment; filename="dashboard-activity.jsonl"',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        const fs = require('fs');
        for (const d of days) {
          await new Promise((resolve) => {
            const s = fs.createReadStream(d.file);
            s.on('data', (chunk) => res.write(chunk));
            s.on('end', resolve);
            s.on('error', resolve);
          });
        }
        return res.end();
      } catch (err) {
        return this.send(res, 500, { error: err.message });
      }
    }

    // ---- /sync/snapshot — client pulls hub's current state on connect ----
    if (pathname === '/sync/snapshot' && method === 'GET') {
      if (!this.sync) return this.send(res, 503, { error: 'sync_not_configured' });
      try {
        const snap = await this.sync.snapshot();
        return this.send(res, 200, snap);
      } catch (err) {
        return this.send(res, 500, { error: err.message });
      }
    }

    // ---- /sync/note?path=… — legacy single-note read (kept for snapshot diff) ----
    if (pathname === '/sync/note' && method === 'GET') {
      if (!this.sync || !this.sync.readNoteBody) return this.send(res, 503, { error: 'sync_not_configured' });
      const p = String(parsed.query.path || '');
      if (!p) return this.send(res, 400, { error: 'path required' });
      try {
        const body = await this.sync.readNoteBody(p);
        if (body == null) return this.send(res, 404, { error: 'not_found' });
        return this.send(res, 200, { path: p, body });
      } catch (err) {
        return this.send(res, 500, { error: err.message });
      }
    }

    // ---- /sync/vault/:name/<op> — central-vault routing ----
    // Connected clients (laptop) call these to read/write the desktop's
    // vaults (notes, cognicore, etc.) instead of touching local files.
    const vaultMatch = pathname.match(/^\/sync\/vault\/([^/]+)\/([^/]+)$/);
    if (vaultMatch && this.sync && this.sync.vault) {
      const [, vaultName, op] = vaultMatch;
      const v = this.sync.vault;
      try {
        if (op === 'list' && method === 'GET') {
          return this.send(res, 200, await v.listEntries(vaultName));
        }
        if (op === 'notes' && method === 'GET') {
          return this.send(res, 200, await v.listNotes(vaultName));
        }
        if (op === 'info' && method === 'GET') {
          return this.send(res, 200, await v.info(vaultName));
        }
        if (op === 'read' && method === 'GET') {
          const p = String(parsed.query.path || '');
          if (!p) return this.send(res, 400, { error: 'path required' });
          let body;
          try { body = await v.read(vaultName, p); }
          catch (err) {
            if (err.code === 'ENOENT') return this.send(res, 404, { error: 'not_found' });
            throw err;
          }
          return this.send(res, 200, { path: p, body });
        }
        if (op === 'write' && method === 'POST') {
          const raw = await this.readBody(req, 4 * 1024 * 1024);
          const o = raw ? JSON.parse(raw) : {};
          if (typeof o.path !== 'string' || !o.path) return this.send(res, 400, { error: 'path required' });
          await v.write(vaultName, o.path, typeof o.content === 'string' ? o.content : '', o.device);
          return this.send(res, 200, { ok: true });
        }
        if (op === 'mkdir' && method === 'POST') {
          const raw = await this.readBody(req, 32 * 1024);
          const o = raw ? JSON.parse(raw) : {};
          if (typeof o.path !== 'string' || !o.path) return this.send(res, 400, { error: 'path required' });
          await v.mkdir(vaultName, o.path, o.device);
          return this.send(res, 200, { ok: true });
        }
        if (op === 'rename' && method === 'POST') {
          const raw = await this.readBody(req, 32 * 1024);
          const o = raw ? JSON.parse(raw) : {};
          if (typeof o.from !== 'string' || !o.from || typeof o.to !== 'string' || !o.to) {
            return this.send(res, 400, { error: 'from/to required' });
          }
          await v.rename(vaultName, o.from, o.to, o.device);
          return this.send(res, 200, { ok: true });
        }
        if (op === 'delete' && method === 'POST') {
          const raw = await this.readBody(req, 32 * 1024);
          const o = raw ? JSON.parse(raw) : {};
          if (typeof o.path !== 'string' || !o.path) return this.send(res, 400, { error: 'path required' });
          await v.delete(vaultName, o.path, o.device);
          return this.send(res, 200, { ok: true });
        }
        return this.send(res, 404, { error: 'unknown vault op' });
      } catch (err) {
        return this.send(res, 500, { error: err.message });
      }
    }

    // ---- /sync/push — client sends a write event to the hub ----
    if (pathname === '/sync/push' && method === 'POST') {
      if (!this.sync) return this.send(res, 503, { error: 'sync_not_configured' });
      let raw;
      try { raw = await this.readBody(req, 1024 * 1024); }
      catch { return this.send(res, 413, { error: 'too_large' }); }
      try {
        const event = raw ? JSON.parse(raw) : {};
        await this.sync.handler(event);
        return this.send(res, 200, { ok: true });
      } catch (err) {
        return this.send(res, 400, { error: err.message });
      }
    }

    if (pathname === '/log' && method === 'POST') {
      let raw;
      try { raw = await this.readBody(req, 256 * 1024); }
      catch { return this.send(res, 413, { error: 'too_large' }); }
      try {
        const obj = raw ? JSON.parse(raw) : {};
        this.logger.log(
          obj.source || 'external',
          obj.channel || obj.event || 'log',
          obj.payload != null ? obj.payload : obj,
          { event: obj.event, remote: this.clientIp(req) },
        );
        return this.send(res, 200, { ok: true });
      } catch (err) {
        return this.send(res, 400, { error: err.message });
      }
    }

    return this.send(res, 404, { error: 'not_found' });
  }
}

module.exports = { ActivityServer, scryptHash, SCRYPT_PARAMS };
