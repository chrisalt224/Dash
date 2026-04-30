// vault-manager.js — named "vaults" for plugins to share content folders
// across devices. Each vault is just a directory; the API is a sandbox over
// it (paths are relative; ../ and absolute escapes are rejected).
//
// Vaults are LOCAL on the desktop (the host). When a client (laptop) is
// connected to a host, the client's renderer-facing IPC routes vault calls
// to the host's HTTP API instead of touching local files. See main.js.
//
// We register each vault by name + directory at startup. The 'notes' vault
// is special-cased to track NOTES_DIR (which is user-configurable via the
// existing notes:setDir IPC).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function sanitizeRel(rel) {
  // Normalize separators, strip leading slashes, reject empty / dotfile /
  // path-traversal entries.
  let s = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) throw new Error('empty path');
  for (const seg of s.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error('invalid path: ' + rel);
    // Don't allow drive letters on Windows ('C:foo' etc.)
    if (/^[a-z]:/i.test(seg)) throw new Error('invalid path: ' + rel);
  }
  return s;
}

class VaultManager {
  constructor() {
    this.vaults = new Map(); // name -> { dir }
    // Listeners for vault changes — used to broadcast/forward.
    this.listeners = [];
  }

  register(name, dir) {
    if (!name) throw new Error('vault name required');
    if (!dir) throw new Error('vault dir required');
    fs.mkdirSync(dir, { recursive: true });
    this.vaults.set(name, { dir });
  }

  setDir(name, newDir) {
    if (!this.vaults.has(name)) {
      this.register(name, newDir);
      return;
    }
    fs.mkdirSync(newDir, { recursive: true });
    this.vaults.get(name).dir = newDir;
  }

  getDir(name) {
    const v = this.vaults.get(name);
    return v ? v.dir : null;
  }

  has(name) { return this.vaults.has(name); }

  list() { return Array.from(this.vaults.keys()); }

  _resolve(name, rel) {
    const v = this.vaults.get(name);
    if (!v) throw new Error(`unknown vault: ${name}`);
    const safe = sanitizeRel(rel);
    const full = path.resolve(path.join(v.dir, safe));
    // Belt & suspenders — full must remain inside v.dir
    const root = path.resolve(v.dir);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('path escapes vault root');
    }
    return full;
  }

  async info(name) {
    const v = this.vaults.get(name);
    if (!v) return null;
    return { name, dir: v.dir };
  }

  async listEntries(name) {
    const v = this.vaults.get(name);
    if (!v) throw new Error(`unknown vault: ${name}`);
    const root = v.dir;
    const out = [];
    async function walk(absDir, relPrefix) {
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(absDir, ent.name);
        const rel = (relPrefix ? relPrefix + '/' : '') + ent.name;
        if (ent.isDirectory()) {
          out.push({ path: rel, isDir: true, isFile: false });
          await walk(full, rel);
        } else if (ent.isFile()) {
          let size = 0, mtime = 0, body = null;
          try {
            const st = await fsp.stat(full);
            size = st.size; mtime = st.mtimeMs;
          } catch {}
          out.push({ path: rel, isDir: false, isFile: true, size, mtime });
        }
      }
    }
    await walk(root, '');
    return out;
  }

  // Convenience: like listEntries but only files, with their bodies inlined.
  // Used by plugins that work with markdown-style note collections.
  async listNotes(name) {
    const entries = await this.listEntries(name);
    const v = this.vaults.get(name);
    const out = [];
    for (const e of entries) {
      if (!e.isFile) continue;
      try {
        const body = await fsp.readFile(path.join(v.dir, e.path), 'utf8');
        out.push({ path: e.path, body, mtime: e.mtime });
      } catch { /* skip unreadable */ }
    }
    return out;
  }

  async read(name, rel) {
    const full = this._resolve(name, rel);
    return await fsp.readFile(full, 'utf8');
  }

  async write(name, rel, content) {
    const full = this._resolve(name, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content == null ? '' : String(content), 'utf8');
    this._fire(name, 'write', rel);
    return true;
  }

  async mkdir(name, rel) {
    const full = this._resolve(name, rel);
    await fsp.mkdir(full, { recursive: true });
    this._fire(name, 'mkdir', rel);
    return true;
  }

  async rename(name, from, to) {
    const a = this._resolve(name, from);
    const b = this._resolve(name, to);
    if (a === b) return true;
    await fsp.mkdir(path.dirname(b), { recursive: true });
    // Refuse to silently overwrite an existing target
    try {
      await fsp.access(b);
      throw new Error('a file/folder already exists at the target path');
    } catch (err) {
      if (err.code !== 'ENOENT' && !/already exists/.test(err.message)) {
        // some other stat error — proceed and let rename fail naturally
      } else if (/already exists/.test(err.message)) {
        throw err;
      }
    }
    await fsp.rename(a, b);
    await this._cleanupEmptyDirsUpTo(name, path.dirname(a));
    this._fire(name, 'rename', { from, to });
    return true;
  }

  async delete(name, rel) {
    const full = this._resolve(name, rel);
    let st;
    try { st = await fsp.stat(full); }
    catch (err) {
      if (err.code === 'ENOENT') return true; // already gone
      throw err;
    }
    if (st.isDirectory()) await fsp.rm(full, { recursive: true, force: true });
    else await fsp.unlink(full);
    await this._cleanupEmptyDirsUpTo(name, path.dirname(full));
    this._fire(name, 'delete', rel);
    return true;
  }

  async _cleanupEmptyDirsUpTo(name, startDir) {
    const v = this.vaults.get(name);
    if (!v) return;
    const root = path.resolve(v.dir);
    let cur = path.resolve(startDir);
    while (cur !== root && cur.startsWith(root + path.sep)) {
      try {
        const ents = await fsp.readdir(cur);
        if (ents.length > 0) break;
        await fsp.rmdir(cur);
        cur = path.dirname(cur);
      } catch { break; }
    }
  }

  // ---- change events ----
  onChange(cb) {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  _fire(name, op, payload) {
    for (const cb of this.listeners) {
      try { cb({ name, op, payload }); } catch {}
    }
  }
}

module.exports = { VaultManager, sanitizeRel };
