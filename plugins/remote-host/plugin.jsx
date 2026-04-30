// remote-host — accept incoming remote-desktop sessions from other devices on
// the same hub. Streams this machine's screen via WebRTC and applies remote
// mouse/keyboard input by piping events to the host's PowerShell injector.
//
// State (all per-device, denied from sync via plugin:remote-host:* in sync-manager.js):
//   plugin:remote-host:enabled:v1   — bool, host opted in to receive requests
//   plugin:remote-host:autoAccept:v1 — bool, accept all (DANGEROUS, off by default)
//   plugin:remote-host:allowInput:v1 — bool, allow input injection (off by default)

const ENABLED_KEY = 'plugin:remote-host:enabled:v1';
const AUTO_ACCEPT_KEY = 'plugin:remote-host:autoAccept:v1';
const ALLOW_INPUT_KEY = 'plugin:remote-host:allowInput:v1';

export default {
  id: 'remote-host',
  name: 'Remote Host',
  width: 2,
  height: 3,
  component: ({ React, useState, useEffect, useRef, useCallback }) => {
    const [enabled, setEnabled] = useState(() => localStorage.getItem(ENABLED_KEY) === '1');
    const [autoAccept, setAutoAccept] = useState(() => localStorage.getItem(AUTO_ACCEPT_KEY) === '1');
    const [allowInput, setAllowInput] = useState(() => localStorage.getItem(ALLOW_INPUT_KEY) === '1');
    const [deviceId, setDeviceId] = useState('');
    const [deviceName, setDeviceName] = useState('');
    const [pending, setPending] = useState(null); // { from, fromName }
    const [session, setSession] = useState(null); // { peerId, peerName, startedAt, bytes? }
    const [injector, setInjector] = useState({ running: false, ready: false, screen: null, platform: 'unknown' });
    const [log, setLog] = useState([]); // recent activity, oldest first

    useEffect(() => { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); }, [enabled]);
    useEffect(() => { localStorage.setItem(AUTO_ACCEPT_KEY, autoAccept ? '1' : '0'); }, [autoAccept]);
    useEffect(() => { localStorage.setItem(ALLOW_INPUT_KEY, allowInput ? '1' : '0'); }, [allowInput]);

    const append = useCallback((line) => {
      setLog((prev) => {
        const next = prev.concat([{ ts: Date.now(), line }]);
        return next.length > 80 ? next.slice(-80) : next;
      });
    }, []);

    // Identity + injector status on mount.
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const [id, name, st] = await Promise.all([
            window.dashboard.remote.deviceId(),
            window.dashboard.remote.deviceName(),
            window.dashboard.remote.injectorStatus(),
          ]);
          if (cancelled) return;
          setDeviceId(id || '');
          setDeviceName(name || 'unknown');
          setInjector(st || { running: false, ready: false, platform: 'unknown' });
        } catch {}
      })();
      return () => { cancelled = true; };
    }, []);

    // Refs so async callbacks always read the latest state.
    const enabledRef = useRef(enabled);
    const autoAcceptRef = useRef(autoAccept);
    const allowInputRef = useRef(allowInput);
    const deviceIdRef = useRef(deviceId);
    const deviceNameRef = useRef(deviceName);
    const sessionRef = useRef(session);
    const pcRef = useRef(null);
    const dcRef = useRef(null);
    const streamRef = useRef(null);
    // Timer for the "disconnected → wait for recovery → tear down" grace
    // period. WebRTC routinely flickers to `disconnected` for a second or
    // two during ICE consent-freshness checks; tearing down immediately
    // guarantees a session lifetime of just a few seconds.
    const disconnectGraceRef = useRef(null);
    const DISCONNECT_GRACE_MS = 8000;
    useEffect(() => { enabledRef.current = enabled; }, [enabled]);
    useEffect(() => { autoAcceptRef.current = autoAccept; }, [autoAccept]);
    useEffect(() => { allowInputRef.current = allowInput; }, [allowInput]);
    useEffect(() => { deviceIdRef.current = deviceId; }, [deviceId]);
    useEffect(() => { deviceNameRef.current = deviceName; }, [deviceName]);
    useEffect(() => { sessionRef.current = session; }, [session]);

    const send = useCallback((to, type, payload) => {
      return window.dashboard.remote.send({ to, type, payload });
    }, []);

    const teardownSession = useCallback((reason) => {
      const cur = sessionRef.current;
      if (cur) {
        send(cur.peerId, 'end', { reason: reason || 'host-ended' }).catch(() => {});
        append(`session ended (${reason || 'host-ended'})`);
      }
      if (disconnectGraceRef.current) {
        clearTimeout(disconnectGraceRef.current);
        disconnectGraceRef.current = null;
      }
      try { dcRef.current && dcRef.current.close(); } catch {}
      try { pcRef.current && pcRef.current.close(); } catch {}
      try { streamRef.current && streamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      dcRef.current = null;
      pcRef.current = null;
      streamRef.current = null;
      setSession(null);
    }, [send, append]);

    const beginSession = useCallback(async (peerId, peerName) => {
      try {
        teardownSession('replaced');
        append(`accepting from ${peerName || peerId.slice(0, 6)}`);

        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: false,
        });
        streamRef.current = stream;

        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        });
        pcRef.current = pc;

        for (const track of stream.getTracks()) pc.addTrack(track, stream);

        // Ensure injector is up if we'll allow input.
        if (allowInputRef.current) {
          try {
            const r = await window.dashboard.remote.startInjector();
            if (!r || r.ok === false) append(`injector start failed: ${r && r.error}`);
            const st = await window.dashboard.remote.injectorStatus();
            setInjector(st);
          } catch (err) { append('injector error: ' + err.message); }
        }

        const dc = pc.createDataChannel('input', { ordered: true });
        dcRef.current = dc;
        dc.onopen = () => append('input channel open');
        dc.onclose = () => append('input channel closed');
        dc.onmessage = (ev) => {
          if (!allowInputRef.current) return;
          let cmd;
          try { cmd = JSON.parse(ev.data); }
          catch { return; }
          window.dashboard.remote.injectInput(cmd).catch(() => {});
        };

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            send(peerId, 'ice', { candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
          }
        };
        pc.onconnectionstatechange = () => {
          const st = pc.connectionState;
          append('pc state: ' + st);
          // Clear any pending grace timer if we recover.
          if (st === 'connected' && disconnectGraceRef.current) {
            clearTimeout(disconnectGraceRef.current);
            disconnectGraceRef.current = null;
            append('connection recovered');
          }
          // Hard failures: tear down immediately.
          if (st === 'failed' || st === 'closed') {
            teardownSession(st);
            return;
          }
          // Soft transient: WebRTC routinely flickers to `disconnected` for
          // a couple seconds during ICE consent-freshness checks. Wait it
          // out — only tear down if we don't recover within the grace window.
          if (st === 'disconnected') {
            if (disconnectGraceRef.current) clearTimeout(disconnectGraceRef.current);
            disconnectGraceRef.current = setTimeout(() => {
              disconnectGraceRef.current = null;
              if (pcRef.current === pc && pc.connectionState === 'disconnected') {
                append('disconnect did not recover, ending');
                teardownSession('disconnect-timeout');
              }
            }, DISCONNECT_GRACE_MS);
          }
        };

        // Stream may end if the user clicks "stop sharing" in the picker.
        for (const t of stream.getTracks()) {
          t.addEventListener('ended', () => teardownSession('stream-ended'));
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await send(peerId, 'offer', { sdp: pc.localDescription.sdp });

        setSession({ peerId, peerName: peerName || peerId.slice(0, 6), startedAt: Date.now() });
      } catch (err) {
        append('session failed: ' + err.message);
        teardownSession('error');
        send(peerId, 'reject', { reason: err.message }).catch(() => {});
      }
    }, [send, append, teardownSession]);

    // Inbound signaling.
    useEffect(() => {
      const off = window.dashboard.remote.onEvent(async (ev) => {
        if (!ev) return;
        const myId = deviceIdRef.current;
        if (!myId) return;
        if (ev.from === myId) return;                          // own echo
        if (ev.to !== myId && ev.to !== '*') return;           // not for us

        const t = ev.type;
        const payload = ev.payload || {};

        if (t === 'discover') {
          // Always answer if we exist; available=true only when toggled on.
          send(ev.from, 'announce', {
            name: deviceNameRef.current,
            available: !!enabledRef.current,
            inputSupported: injector.platform === 'win32',
          }).catch(() => {});
          return;
        }

        if (t === 'request') {
          if (!enabledRef.current) {
            send(ev.from, 'reject', { reason: 'host-disabled' }).catch(() => {});
            return;
          }
          if (sessionRef.current) {
            send(ev.from, 'reject', { reason: 'busy' }).catch(() => {});
            return;
          }
          if (autoAcceptRef.current) {
            await send(ev.from, 'accept', {}).catch(() => {});
            await beginSession(ev.from, payload.name || ev.from.slice(0, 6));
          } else {
            setPending({ from: ev.from, fromName: payload.name || ev.from.slice(0, 6) });
            append(`request from ${payload.name || ev.from.slice(0, 6)}`);
          }
          return;
        }

        if (t === 'answer') {
          const pc = pcRef.current;
          const cur = sessionRef.current;
          if (!pc || !cur || cur.peerId !== ev.from) return;
          try { await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp }); }
          catch (err) { append('setRemoteDescription failed: ' + err.message); }
          return;
        }

        if (t === 'ice') {
          const pc = pcRef.current;
          const cur = sessionRef.current;
          if (!pc || !cur || cur.peerId !== ev.from) return;
          try { await pc.addIceCandidate(payload.candidate); }
          catch { /* benign — candidate may arrive before remote desc */ }
          return;
        }

        if (t === 'end') {
          const cur = sessionRef.current;
          if (cur && cur.peerId === ev.from) teardownSession('peer-ended');
          return;
        }

        if (t === 'cancel') {
          if (pending && pending.from === ev.from) setPending(null);
          return;
        }
      });
      return () => { off && off(); };
    }, [send, beginSession, teardownSession, append, pending, injector.platform]);

    // Cleanup on unmount.
    useEffect(() => () => { teardownSession('unmount'); }, [teardownSession]);

    const acceptPending = useCallback(async () => {
      if (!pending) return;
      const p = pending;
      setPending(null);
      await send(p.from, 'accept', {}).catch(() => {});
      await beginSession(p.from, p.fromName);
    }, [pending, send, beginSession]);

    const rejectPending = useCallback(() => {
      if (!pending) return;
      send(pending.from, 'reject', { reason: 'denied-by-user' }).catch(() => {});
      append(`rejected ${pending.fromName}`);
      setPending(null);
    }, [pending, send, append]);

    const startInjector = useCallback(async () => {
      const r = await window.dashboard.remote.startInjector();
      if (!r || r.ok === false) append('injector start failed: ' + (r && r.error));
      const st = await window.dashboard.remote.injectorStatus();
      setInjector(st);
    }, [append]);

    const stopInjector = useCallback(async () => {
      await window.dashboard.remote.stopInjector();
      const st = await window.dashboard.remote.injectorStatus();
      setInjector(st);
    }, []);

    // ---------- render ----------
    const dotStyle = (on) => ({
      width: 8, height: 8, borderRadius: 4, display: 'inline-block',
      background: on ? 'var(--accent)' : 'var(--fg-dim)',
      boxShadow: on ? 'var(--glow-soft)' : 'none',
      marginRight: 6,
    });

    return (
      <div className="p-col" style={{ height: '100%', gap: 6, padding: 4 }}>
        <div className="p-row" style={{ justifyContent: 'space-between' }}>
          <div className="p-label">remote host</div>
          <div className="p-label" style={{ fontSize: 9 }}>
            <span style={dotStyle(enabled)} />
            {enabled ? 'listening' : 'off'}
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          this device: <span className="p-accent">{deviceName}</span>
          <span style={{ marginLeft: 6, opacity: 0.6 }}>{deviceId.slice(0, 8)}</span>
        </div>

        <div className="p-col" style={{ gap: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4 }}>
          <label className="p-row" style={{ gap: 6, fontSize: 11, cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            accept incoming requests
          </label>
          <label className="p-row" style={{ gap: 6, fontSize: 11, cursor: 'pointer', opacity: enabled ? 1 : 0.4 }}>
            <input type="checkbox" disabled={!enabled} checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
            auto-accept (no prompt)
          </label>
          <label className="p-row" style={{ gap: 6, fontSize: 11, cursor: 'pointer', opacity: enabled ? 1 : 0.4 }}>
            <input
              type="checkbox" disabled={!enabled}
              checked={allowInput} onChange={(e) => setAllowInput(e.target.checked)} />
            allow remote input (mouse + keyboard)
          </label>
          {allowInput && injector.platform !== 'win32' && (
            <div style={{ fontSize: 10, color: 'var(--accent-warm)' }}>
              ! input injection is Windows-only (this is {injector.platform})
            </div>
          )}
        </div>

        {pending && (
          <div className="p-col" style={{
            gap: 6, padding: 8,
            border: '1px solid var(--accent)',
            background: 'rgba(var(--accent-rgb), 0.08)',
            borderRadius: 4,
          }}>
            <div style={{ fontSize: 12 }}>
              connection request from <span className="p-accent">{pending.fromName}</span>
            </div>
            <div className="p-row" style={{ gap: 6 }}>
              <button className="p-btn p-accent" onClick={acceptPending}>accept</button>
              <button className="p-btn" onClick={rejectPending}>reject</button>
            </div>
          </div>
        )}

        {session && (
          <div className="p-col" style={{
            gap: 4, padding: 8,
            border: '1px solid var(--border-bright)', borderRadius: 4,
          }}>
            <div className="p-row" style={{ justifyContent: 'space-between', fontSize: 11 }}>
              <span>streaming to <span className="p-accent">{session.peerName}</span></span>
              <button className="p-btn" onClick={() => teardownSession('host-ended')}>stop</button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
              started {new Date(session.startedAt).toLocaleTimeString()}
              {allowInput && injector.ready && injector.screen && <> · screen {injector.screen}</>}
            </div>
          </div>
        )}

        <div className="p-row" style={{ gap: 6, fontSize: 10 }}>
          <span style={{ color: 'var(--fg-dim)' }}>injector:</span>
          <span style={dotStyle(injector.ready)} />
          <span>{injector.ready ? 'ready' : (injector.running ? 'starting' : 'stopped')}</span>
          {injector.platform === 'win32' && (
            injector.running
              ? <button className="p-btn" style={{ marginLeft: 'auto', fontSize: 10 }} onClick={stopInjector}>stop</button>
              : <button className="p-btn" style={{ marginLeft: 'auto', fontSize: 10 }} onClick={startInjector}>start</button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', fontSize: 10, color: 'var(--fg-dim)', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4 }}>
          {log.length === 0 && <div style={{ opacity: 0.5 }}>idle</div>}
          {log.slice().reverse().map((l, i) => (
            <div key={l.ts + ':' + i} className="p-mono">
              {new Date(l.ts).toLocaleTimeString()} · {l.line}
            </div>
          ))}
        </div>
      </div>
    );
  },
};
