// Servers — connect to remote dashboard activity servers (yours, on Tailscale,
// or any reachable host). Saved servers + passwords are stored encrypted in
// the main process via Electron safeStorage; the password value is only
// fetched when you actually connect.

const VIEW_KEY = 'plugin:servers:view:v1';
const NORMALIZE_URL = (u) => {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
};

export default {
  id: 'servers',
  name: 'Servers',
  width: 2,
  height: 3,
  component: ({ React, useState, useEffect, useRef, useCallback }) => {
    function PasswordPrompt({ label, onSubmit, onCancel }) {
      const [pw, setPw] = useState('');
      return (
        <div className="p-col" style={{ gap: 6, padding: 10 }}>
          <div className="p-label">enter password for {label}</div>
          <input
            type="password"
            className="p-input"
            autoFocus
            value={pw}
            onChange={(ev) => setPw(ev.target.value)}
            onKeyDown={(ev) => ev.key === 'Enter' && pw && onSubmit(pw)}
          />
          <div className="p-row">
            <button className="p-btn p-accent" disabled={!pw} onClick={() => onSubmit(pw)}>connect</button>
            <button className="p-btn" onClick={onCancel}>cancel</button>
          </div>
        </div>
      );
    }

    const [list, setList] = useState([]);
    const [view, setView] = useState(() => {
      try { return JSON.parse(localStorage.getItem(VIEW_KEY)) || { name: 'list' }; }
      catch { return { name: 'list' }; }
    });
    const [editing, setEditing] = useState(null);  // { id?, name, url, password, savePassword }
    const [conn, setConn] = useState(null);        // { server, status, error }
    const [events, setEvents] = useState([]);
    // Server mode: when this device is itself running the host server, the
    // connect-to-others UI is hidden — a hub connecting to another hub causes
    // routing loops + duplicate sync events. Polled every 2s.
    const [hostStatus, setHostStatus] = useState(null); // { running, port, lan, ... } | null
    useEffect(() => {
      let cancelled = false;
      const poll = async () => {
        try {
          const st = await window.dashboard.host.status();
          if (!cancelled) setHostStatus(st || null);
        } catch { if (!cancelled) setHostStatus(null); }
      };
      poll();
      const id = setInterval(poll, 2000);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    // ---- list ops ----
    const refresh = useCallback(async () => {
      try { setList(await window.dashboard.servers.list()); } catch {}
    }, []);
    useEffect(() => { refresh(); }, [refresh]);
    useEffect(() => {
      try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {}
    }, [view]);

    // ---- connect / disconnect (driven by main-process sync client) ----
    // Connection lifetime is owned by main so it survives plugin remount /
    // minimize. The plugin just shows UI + initiates the request.

    // Subscribe to status + remote events from main on mount.
    useEffect(() => {
      let cancelled = false;
      // Pick up an existing connection if main was already connected.
      window.dashboard.sync.status().then((st) => {
        if (cancelled || !st || !st.server) return;
        setConn({
          server: st.server,
          status: st.status === 'connected' ? 'connected' : st.status,
          error: st.error,
        });
        setView({ name: 'connected' });
      }).catch(() => {});
      const offStatus = window.dashboard.sync.onStatus((st) => {
        if (!st) return;
        if (st.server) {
          setConn((prev) => prev && prev.server.id === st.server.id
            ? { ...prev, status: st.status, error: st.error }
            : { server: st.server, status: st.status, error: st.error });
        } else {
          setConn(null);
        }
      });
      const offEvent = window.dashboard.sync.onEvent((ev) => {
        if (!ev) return;
        setEvents((prev) => {
          const next = prev.concat([ev]);
          return next.length > 200 ? next.slice(-200) : next;
        });
      });
      return () => { cancelled = true; offStatus && offStatus(); offEvent && offEvent(); };
    }, []);

    const connectTo = useCallback(async (server, passwordOverride) => {
      setEvents([]);
      setView({ name: 'connected' });
      setConn({ server, status: 'reaching', error: null });

      // Probe reachability first so the user sees "can't reach" as a distinct
      // state from "wrong password".
      const url = NORMALIZE_URL(server.url);
      try {
        const probe = await fetch(url + '/status', { method: 'GET' });
        if (!probe.ok) {
          setConn({ server, status: 'error', error: `server replied ${probe.status} on /status` });
          return;
        }
      } catch (err) {
        setConn({
          server, status: 'error',
          error: 'cannot reach ' + url + ' — ' + (err.message || 'network error'),
        });
        return;
      }

      let password = passwordOverride;
      if (password == null && server.hasPassword) {
        try { password = await window.dashboard.servers.getPassword(server.id); } catch {}
      }
      if (!password) {
        setConn({ server, status: 'need-password', error: null });
        return;
      }

      setConn({ server, status: 'login', error: null });
      const r = await window.dashboard.sync.connect({ ...server, url }, password);
      if (!r || !r.ok) {
        let msg = (r && r.error) || 'unknown';
        if (/login 401|invalid_password/i.test(msg)) msg = 'wrong password';
        else if (/login 429|too_many_attempts/i.test(msg)) msg = 'locked out — try again later';
        setConn({ server, status: 'error', error: msg });
        return;
      }
      // Status will update via onStatus subscription.
    }, []);

    const disconnect = useCallback(async () => {
      try { await window.dashboard.sync.disconnect(); } catch {}
      setConn(null);
      setEvents([]);
      setView({ name: 'list' });
    }, []);

    // ---- form ops ----
    const startAdd = () => { setEditing({ name: '', url: '', password: '', savePassword: false }); setView({ name: 'edit' }); };
    const startEdit = (s) => { setEditing({ id: s.id, name: s.name, url: s.url, password: '', savePassword: false }); setView({ name: 'edit' }); };
    const cancelEdit = () => { setEditing(null); setView({ name: 'list' }); };
    const saveEntry = async () => {
      if (!editing) return;
      const url = editing.url.trim();
      if (!url) { alert('URL is required'); return; }
      const payload = {
        id: editing.id,
        name: editing.name.trim() || url,
        url: NORMALIZE_URL(url),
      };
      if (editing.savePassword && editing.password) payload.password = editing.password;
      else if (editing.savePassword === false && editing.password === '') payload.password = ''; // explicit clear
      try {
        await window.dashboard.servers.save(payload);
        await refresh();
        setEditing(null);
        setView({ name: 'list' });
      } catch (err) { alert('save failed: ' + (err.message || err)); }
    };
    const deleteEntry = async (id) => {
      if (!confirm('Delete this server?')) return;
      await window.dashboard.servers.delete(id);
      await refresh();
    };

    // ---- helpers ----
    const fmtTs = (ts) => new Date(ts).toTimeString().slice(0, 8);
    const statusColor = {
      reaching:     'var(--fg-dim)',
      login:        'var(--fg-dim)',
      'need-password': 'var(--accent-warm, var(--accent))',
      connecting:   'var(--accent-warm, var(--accent))',
      connected:    'var(--accent)',
      reconnecting: 'var(--accent-warm, var(--accent))',
      error:        'var(--danger)',
    };

    // ---- Server Mode override ----
    // When this machine is itself running the host server, connecting outward
    // would create a hub-to-hub loop. Auto-drop any active outbound connection
    // and replace the whole UI with a server-status panel.
    const isHosting = !!(hostStatus && hostStatus.running);
    useEffect(() => {
      if (isHosting && conn) {
        window.dashboard.sync.disconnect().catch(() => {});
      }
    }, [isHosting, conn]);

    const [serverIps, setServerIps] = useState([]);
    useEffect(() => {
      if (!isHosting) { setServerIps([]); return; }
      let cancelled = false;
      window.dashboard.host.localIps().then((ips) => {
        if (!cancelled) setServerIps(Array.isArray(ips) ? ips : []);
      }).catch(() => {});
      return () => { cancelled = true; };
    }, [isHosting]);

    if (isHosting) {
      const port = hostStatus.port || 7878;
      const reachable = (hostStatus.lan ? serverIps : ['127.0.0.1']).map((ip) => `http://${ip}:${port}`);
      return (
        <div className="p-col" style={{ height: '100%', gap: 8, padding: 4 }}>
          <div className="p-row" style={{ alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: 'var(--accent)' }}>●</span>
            <strong style={{ flex: 1 }}>Server Mode</strong>
            <span className="p-label" style={{ fontSize: 9 }}>port {port}</span>
          </div>
          <div style={{
            padding: 10,
            border: '1px solid var(--border-bright)',
            borderRadius: 4,
            background: 'rgba(var(--accent-rgb), 0.04)',
          }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              this device is hosting — outbound connections are disabled to
              prevent hub-to-hub loops.
            </div>
            <div className="p-label" style={{ fontSize: 9, marginBottom: 4 }}>
              {hostStatus.lan ? 'reachable on LAN at' : 'loopback only — enable LAN in settings'}
            </div>
            <div className="p-mono" style={{ fontSize: 11, color: 'var(--fg-bright)' }}>
              {reachable.length === 0
                ? <span className="p-dim">discovering interfaces…</span>
                : reachable.map((u) => <div key={u}>{u}</div>)}
            </div>
            <div className="p-row" style={{ marginTop: 8, gap: 6, fontSize: 10 }}>
              <span className="p-dim">sessions:</span> <span>{hostStatus.sessions || 0}</span>
              <span className="p-dim" style={{ marginLeft: 8 }}>live clients:</span> <span>{hostStatus.sseClients || 0}</span>
            </div>
          </div>
          <div className="p-dim" style={{ fontSize: 10, padding: '4px 2px' }}>
            stop the server in <span className="p-accent">Settings → Host</span> to use the
            Servers plugin in client mode.
          </div>
        </div>
      );
    }

    // ---- VIEWS ----
    if (view.name === 'edit' && editing) {
      return (
        <div className="p-col" style={{ height: '100%', gap: 8 }}>
          <div className="p-row" style={{ alignItems: 'baseline' }}>
            <button className="p-btn" onClick={cancelEdit}>← back</button>
            <strong style={{ flex: 1 }}>{editing.id ? 'Edit server' : 'Add server'}</strong>
          </div>
          <label className="p-label">name</label>
          <input
            className="p-input"
            placeholder="my desktop"
            value={editing.name}
            onChange={(ev) => setEditing({ ...editing, name: ev.target.value })}
          />
          <label className="p-label">url <span className="p-dim">e.g. http://100.64.1.5:7878 or just 100.64.1.5:7878</span></label>
          <input
            className="p-input"
            placeholder="100.64.1.5:7878"
            value={editing.url}
            onChange={(ev) => setEditing({ ...editing, url: ev.target.value })}
          />
          <label className="p-label" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={!!editing.savePassword}
              onChange={(ev) => setEditing({ ...editing, savePassword: ev.target.checked })}
              style={{ marginRight: 6 }}
            />
            remember password
          </label>
          {editing.savePassword && (
            <input
              type="password"
              className="p-input"
              placeholder={editing.id ? 'new password (leave blank to keep existing)' : 'password'}
              value={editing.password}
              onChange={(ev) => setEditing({ ...editing, password: ev.target.value })}
            />
          )}
          <div className="p-row" style={{ marginTop: 8 }}>
            <button className="p-btn p-accent" onClick={saveEntry}>save</button>
            <button className="p-btn" onClick={cancelEdit}>cancel</button>
          </div>
        </div>
      );
    }

    if (view.name === 'connected' && conn) {
      const isError = conn.status === 'error';
      const isReaching = conn.status === 'reaching' || conn.status === 'login';
      return (
        <div className="p-col" style={{ height: '100%', gap: 6 }}>
          <div className="p-row" style={{ alignItems: 'baseline' }}>
            <span style={{ color: statusColor[conn.status] || 'var(--fg-dim)' }}>●</span>
            <strong style={{ flex: 1 }}>{conn.server.name}</strong>
            <button className="p-btn" onClick={disconnect}>{isError ? '← back' : 'disconnect'}</button>
          </div>
          <div className="p-dim p-label" style={{ fontSize: 10 }}>
            {conn.server.url} · {conn.status}
            {conn.expiresAt ? ' · session ' + new Date(conn.expiresAt).toLocaleDateString() : ''}
          </div>

          {isError ? (
            <div
              style={{
                flex: 1,
                padding: 10,
                background: 'rgba(var(--danger-rgb, 255,107,107), 0.08)',
                border: '1px solid var(--danger)',
                borderRadius: 4,
                overflow: 'auto',
              }}
            >
              <div style={{ color: 'var(--danger)', fontWeight: 500, marginBottom: 8 }}>connection failed</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 12, wordBreak: 'break-word' }}>
                {conn.error || 'unknown error'}
              </div>
              <div className="p-col" style={{ gap: 4, fontSize: 10 }}>
                <div className="p-dim">things to check on the desktop:</div>
                <div className="p-dim">· server is running (Settings → Host → status pill green)</div>
                <div className="p-dim">· "Allow remote access" is on (otherwise it's loopback only)</div>
                <div className="p-dim">· the URL above matches one of the "reachable at" entries</div>
                <div className="p-dim">· Windows firewall isn't blocking node/electron on port {(NORMALIZE_URL(conn.server.url).match(/:(\d+)$/) || [])[1] || '7878'}</div>
                <div className="p-dim">· Tailscale is up on both machines (run "tailscale status")</div>
              </div>
              <div className="p-row" style={{ marginTop: 10 }}>
                <button className="p-btn p-accent" onClick={() => connectTo(conn.server)}>↻ retry</button>
                <button className="p-btn" onClick={() => startEdit(conn.server)}>edit server</button>
              </div>
            </div>
          ) : conn.status === 'need-password' ? (
            <PasswordPrompt
              label={conn.server.name}
              onSubmit={(pw) => connectTo(conn.server, pw)}
              onCancel={disconnect}
            />
          ) : isReaching ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--mono)',
                fontSize: 11,
              }}
              className="p-dim"
            >
              {conn.status === 'reaching' ? 'reaching server…' : 'logging in…'}
            </div>
          ) : (
            <div
              ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
              style={{
                flex: 1,
                overflowY: 'auto',
                background: 'var(--bg-elev, rgba(0,0,0,0.25))',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: 6,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                lineHeight: 1.5,
              }}
            >
              {events.length === 0
                ? <div className="p-dim">waiting for events…</div>
                : events.map((ev, i) => (
                    <div
                      key={(ev.ts || 0) + ':' + i}
                      style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      <span style={{ opacity: 0.5 }}>{fmtTs(ev.ts)}</span>{' '}
                      <span className="p-accent">{ev.source}</span>{' '}
                      <span>{ev.channel || ev.event || ''}</span>
                      {ev.ok === false && <span style={{ color: 'var(--danger)' }}> ✗</span>}
                      {ev.ms != null && <span style={{ opacity: 0.5 }}> {ev.ms}ms</span>}
                    </div>
                  ))}
            </div>
          )}

          {!isError && (
            <div className="p-dim p-label" style={{ fontSize: 10, textAlign: 'right' }}>
              {events.length} event{events.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      );
    }

    // ---- list view (default) ----
    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        <div className="p-row" style={{ alignItems: 'baseline' }}>
          <strong style={{ flex: 1 }}>Servers</strong>
          <button className="p-btn p-accent" onClick={startAdd}>+ add</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {list.length === 0
            ? <div className="p-dim" style={{ padding: '20px 8px', textAlign: 'center' }}>
                no saved servers
                <div style={{ fontSize: 10, marginTop: 6 }}>
                  add the URL of a dashboard host server you want to monitor
                </div>
              </div>
            : list.map((s) => (
                <div
                  key={s.id}
                  className="p-row"
                  style={{
                    padding: '6px 4px',
                    borderBottom: '1px solid var(--border)',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </div>
                    <div className="p-dim" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.url}
                      {s.hasPassword ? ' · 🔑 saved' : ''}
                    </div>
                  </div>
                  <button className="p-btn p-accent" onClick={() => connectTo(s)}>connect</button>
                  <button className="p-btn" onClick={() => startEdit(s)} title="edit">✎</button>
                  <button className="p-btn" onClick={() => deleteEntry(s.id)} title="delete">×</button>
                </div>
              ))}
        </div>
        <div className="p-dim p-label" style={{ fontSize: 9.5, marginTop: 4 }}>
          tip: install Tailscale on both machines for internet-anywhere access
        </div>
      </div>
    );

  },
};
