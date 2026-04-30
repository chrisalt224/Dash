// remote-viewer — discover other devices on the same hub, request a remote
// session, and control them. Pairs with the remote-host plugin running on the
// target device. All signaling rides the existing sync SSE channel via
// window.dashboard.remote.{send,onEvent}.
//
// State (per-device, denied via plugin:remote-viewer:* in sync-manager.js):
//   plugin:remote-viewer:lastPeer:v1 — id of the last device we connected to
//   plugin:remote-viewer:sendInput:v1 — bool, send keyboard/mouse to remote

const LAST_PEER_KEY = 'plugin:remote-viewer:lastPeer:v1';
const SEND_INPUT_KEY = 'plugin:remote-viewer:sendInput:v1';

// KeyboardEvent.code → Win32 virtual-key code. Covers the common keys that
// matter for everyday remote-control use; rare keys fall back to keyCode.
const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, ShiftLeft: 0xA0, ShiftRight: 0xA1,
  ControlLeft: 0xA2, ControlRight: 0xA3, AltLeft: 0xA4, AltRight: 0xA5,
  Pause: 0x13, CapsLock: 0x14, Escape: 0x1B, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PrintScreen: 0x2C, Insert: 0x2D, Delete: 0x2E,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46,
  KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4A, KeyK: 0x4B, KeyL: 0x4C,
  KeyM: 0x4D, KeyN: 0x4E, KeyO: 0x4F, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52,
  KeyS: 0x53, KeyT: 0x54, KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58,
  KeyY: 0x59, KeyZ: 0x5A,
  MetaLeft: 0x5B, MetaRight: 0x5C, ContextMenu: 0x5D,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D,
  NumpadDecimal: 0x6E, NumpadDivide: 0x6F, NumpadEnter: 0x0D,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  NumLock: 0x90, ScrollLock: 0x91,
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD,
  Period: 0xBE, Slash: 0xBF, Backquote: 0xC0,
  BracketLeft: 0xDB, Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE,
};

function vkFromKeyEvent(ev) {
  const known = VK[ev.code];
  if (known) return known;
  if (typeof ev.keyCode === 'number' && ev.keyCode > 0) return ev.keyCode;
  return 0;
}

const DISCOVER_INTERVAL_MS = 8000;
const DISCOVER_WINDOW_MS = 1500;

export default {
  id: 'remote-viewer',
  name: 'Remote Viewer',
  width: 4,
  height: 6,
  component: ({ React, useState, useEffect, useRef, useCallback }) => {
    const [deviceId, setDeviceId] = useState('');
    const [devices, setDevices] = useState({}); // id -> { name, available, lastSeen, inputSupported }
    const [target, setTarget] = useState(null); // { peerId, peerName, status, error, startedAt? }
    const [sendInput, setSendInput] = useState(() => localStorage.getItem(SEND_INPUT_KEY) !== '0');
    const [lastPeer, setLastPeer] = useState(() => localStorage.getItem(LAST_PEER_KEY) || null);
    const [log, setLog] = useState([]);

    useEffect(() => { localStorage.setItem(SEND_INPUT_KEY, sendInput ? '1' : '0'); }, [sendInput]);
    useEffect(() => {
      if (lastPeer) localStorage.setItem(LAST_PEER_KEY, lastPeer);
      else localStorage.removeItem(LAST_PEER_KEY);
    }, [lastPeer]);

    const append = useCallback((line) => {
      setLog((prev) => {
        const next = prev.concat([{ ts: Date.now(), line }]);
        return next.length > 80 ? next.slice(-80) : next;
      });
    }, []);

    // Identity on mount.
    useEffect(() => {
      let cancelled = false;
      window.dashboard.remote.deviceId().then((id) => {
        if (!cancelled) setDeviceId(id || '');
      }).catch(() => {});
      return () => { cancelled = true; };
    }, []);

    const send = useCallback((to, type, payload) => {
      return window.dashboard.remote.send({ to, type, payload });
    }, []);

    // Refs for async callbacks.
    const deviceIdRef = useRef(deviceId);
    const targetRef = useRef(target);
    const pcRef = useRef(null);
    const dcRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const videoRef = useRef(null);
    const wrapRef = useRef(null);
    // Grace timer for transient `disconnected` states — see remote-host for
    // the rationale. We only tear down if disconnect persists past the grace.
    const disconnectGraceRef = useRef(null);
    const DISCONNECT_GRACE_MS = 8000;
    const sendInputRef = useRef(sendInput);
    useEffect(() => { deviceIdRef.current = deviceId; }, [deviceId]);
    useEffect(() => { targetRef.current = target; }, [target]);
    useEffect(() => { sendInputRef.current = sendInput; }, [sendInput]);

    const teardown = useCallback((reason) => {
      const cur = targetRef.current;
      if (cur && cur.peerId && cur.status !== 'idle') {
        send(cur.peerId, 'end', { reason: reason || 'viewer-ended' }).catch(() => {});
        append(`disconnected (${reason || 'viewer-ended'})`);
      }
      if (disconnectGraceRef.current) {
        clearTimeout(disconnectGraceRef.current);
        disconnectGraceRef.current = null;
      }
      try { dcRef.current && dcRef.current.close(); } catch {}
      try { pcRef.current && pcRef.current.close(); } catch {}
      try {
        if (remoteStreamRef.current) {
          remoteStreamRef.current.getTracks().forEach((t) => t.stop());
        }
      } catch {}
      dcRef.current = null;
      pcRef.current = null;
      remoteStreamRef.current = null;
      if (videoRef.current) {
        try { videoRef.current.srcObject = null; } catch {}
      }
      setTarget(null);
    }, [send, append]);

    // ---- discovery ----
    const refreshDevices = useCallback(() => {
      if (!deviceIdRef.current) return;
      send('*', 'discover', { name: 'viewer' }).catch(() => {});
      // Reap entries we haven't heard from in two intervals.
      const cutoff = Date.now() - (DISCOVER_INTERVAL_MS * 2 + 1000);
      setDevices((prev) => {
        const next = {};
        for (const [id, info] of Object.entries(prev)) {
          if (info.lastSeen >= cutoff) next[id] = info;
        }
        return next;
      });
    }, [send]);

    useEffect(() => {
      if (!deviceId) return;
      refreshDevices();
      const id = setInterval(refreshDevices, DISCOVER_INTERVAL_MS);
      return () => clearInterval(id);
    }, [deviceId, refreshDevices]);

    // ---- inbound signaling ----
    useEffect(() => {
      const off = window.dashboard.remote.onEvent(async (ev) => {
        if (!ev) return;
        const myId = deviceIdRef.current;
        if (!myId || ev.from === myId) return;
        if (ev.to !== myId && ev.to !== '*') return;
        const t = ev.type;
        const payload = ev.payload || {};

        if (t === 'announce') {
          setDevices((prev) => ({
            ...prev,
            [ev.from]: {
              name: payload.name || ev.from.slice(0, 6),
              available: !!payload.available,
              inputSupported: !!payload.inputSupported,
              lastSeen: Date.now(),
            },
          }));
          return;
        }

        // Anything below requires it to come from our active target.
        const cur = targetRef.current;
        if (!cur || cur.peerId !== ev.from) return;

        if (t === 'accept') {
          setTarget((prev) => prev ? { ...prev, status: 'negotiating' } : prev);
          append('peer accepted, awaiting offer');
          return;
        }
        if (t === 'reject') {
          append('peer rejected: ' + (payload.reason || 'no reason'));
          teardown('rejected');
          return;
        }
        if (t === 'offer') {
          // Build the PC now, on offer arrival.
          try {
            const pc = new RTCPeerConnection({
              iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
              ],
            });
            pcRef.current = pc;
            pc.ontrack = (e) => {
              remoteStreamRef.current = e.streams[0] || new MediaStream([e.track]);
              if (videoRef.current) {
                try { videoRef.current.srcObject = remoteStreamRef.current; } catch {}
              }
            };
            pc.ondatachannel = (e) => {
              dcRef.current = e.channel;
              e.channel.onopen = () => append('input channel ready');
              e.channel.onclose = () => append('input channel closed');
            };
            pc.onicecandidate = (e) => {
              if (e.candidate) send(ev.from, 'ice', {
                candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate,
              });
            };
            pc.onconnectionstatechange = () => {
              const st = pc.connectionState;
              append('pc state: ' + st);
              if (st === 'connected') {
                setTarget((prev) => prev ? { ...prev, status: 'connected', startedAt: Date.now() } : prev);
                if (disconnectGraceRef.current) {
                  clearTimeout(disconnectGraceRef.current);
                  disconnectGraceRef.current = null;
                  append('connection recovered');
                }
              }
              // Hard failures: tear down immediately.
              if (st === 'failed' || st === 'closed') {
                teardown(st);
                return;
              }
              // Soft transient: WebRTC routinely flickers to `disconnected`
              // for a couple seconds during ICE consent-freshness checks.
              // Wait it out before tearing down.
              if (st === 'disconnected') {
                if (disconnectGraceRef.current) clearTimeout(disconnectGraceRef.current);
                disconnectGraceRef.current = setTimeout(() => {
                  disconnectGraceRef.current = null;
                  if (pcRef.current === pc && pc.connectionState === 'disconnected') {
                    append('disconnect did not recover, ending');
                    teardown('disconnect-timeout');
                  }
                }, DISCONNECT_GRACE_MS);
              }
            };
            await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await send(ev.from, 'answer', { sdp: pc.localDescription.sdp });
          } catch (err) {
            append('offer handling failed: ' + err.message);
            teardown('error');
          }
          return;
        }
        if (t === 'ice') {
          const pc = pcRef.current;
          if (!pc) return;
          try { await pc.addIceCandidate(payload.candidate); } catch {}
          return;
        }
        if (t === 'end') {
          teardown('peer-ended');
          return;
        }
      });
      return () => { off && off(); };
    }, [send, append, teardown]);

    // ---- connect / disconnect ----
    const connectTo = useCallback(async (peerId, peerName) => {
      teardown('replaced');
      setTarget({ peerId, peerName: peerName || peerId.slice(0, 6), status: 'requesting' });
      setLastPeer(peerId);
      append(`requesting ${peerName || peerId.slice(0, 6)}`);
      await send(peerId, 'request', { name: 'viewer' }).catch((err) => append('send failed: ' + err.message));
    }, [send, append, teardown]);

    useEffect(() => () => { teardown('unmount'); }, [teardown]);

    // ---- input capture on the video element ----
    const sendInputCmd = useCallback((cmd) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== 'open') return;
      try { dc.send(JSON.stringify(cmd)); } catch {}
    }, []);

    const onMouseMove = useCallback((ev) => {
      if (!sendInputRef.current) return;
      const v = videoRef.current;
      if (!v) return;
      const r = v.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      sendInputCmd({ t: 'm', x, y });
    }, [sendInputCmd]);

    const onMouseDown = useCallback((ev) => {
      if (!sendInputRef.current) return;
      ev.preventDefault();
      videoRef.current && videoRef.current.focus();
      const v = videoRef.current;
      if (v) {
        const r = v.getBoundingClientRect();
        sendInputCmd({ t: 'm', x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height });
      }
      sendInputCmd({ t: 'd', b: ev.button });
    }, [sendInputCmd]);

    const onMouseUp = useCallback((ev) => {
      if (!sendInputRef.current) return;
      ev.preventDefault();
      sendInputCmd({ t: 'u', b: ev.button });
    }, [sendInputCmd]);

    const onWheel = useCallback((ev) => {
      if (!sendInputRef.current) return;
      ev.preventDefault();
      // Browser deltaY is in lines/pixels; Win32 wheel ticks are 120 per notch.
      const dy = -Math.round(ev.deltaY) * 2;
      sendInputCmd({ t: 'w', dy });
    }, [sendInputCmd]);

    const onKeyDown = useCallback((ev) => {
      if (!sendInputRef.current) return;
      const vk = vkFromKeyEvent(ev);
      if (!vk) return;
      ev.preventDefault();
      sendInputCmd({ t: 'k', vk, up: false });
    }, [sendInputCmd]);

    const onKeyUp = useCallback((ev) => {
      if (!sendInputRef.current) return;
      const vk = vkFromKeyEvent(ev);
      if (!vk) return;
      ev.preventDefault();
      sendInputCmd({ t: 'k', vk, up: true });
    }, [sendInputCmd]);

    const onContextMenu = useCallback((ev) => {
      // Suppress browser context menu so right-click reaches the remote.
      ev.preventDefault();
    }, []);

    const sortedDevices = Object.entries(devices)
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => (b.available - a.available) || a.name.localeCompare(b.name));

    const isConnected = target && target.status === 'connected';
    const isPending = target && target.status !== 'connected';

    return (
      <div ref={wrapRef} className="p-col" style={{ height: '100%', gap: 6, padding: 4 }}>
        {!target && (
          <>
            <div className="p-row" style={{ justifyContent: 'space-between' }}>
              <div className="p-label">remote viewer</div>
              <button className="p-btn" style={{ fontSize: 10 }} onClick={refreshDevices}>↻ scan</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {sortedDevices.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: 8 }}>
                  no devices found. make sure another device on the same hub has the
                  remote-host plugin enabled.
                </div>
              )}
              {sortedDevices.map((d) => (
                <div key={d.id} className="p-row" style={{
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  border: '1px solid var(--border)', borderRadius: 4,
                  marginBottom: 4,
                  opacity: d.available ? 1 : 0.45,
                }}>
                  <div className="p-col" style={{ gap: 0 }}>
                    <div className="p-mono" style={{ fontSize: 12 }}>
                      {d.name}
                      {d.id === lastPeer && <span className="p-accent" style={{ fontSize: 9, marginLeft: 6 }}>last</span>}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--fg-dim)' }}>
                      {d.id.slice(0, 8)} · {d.available ? 'available' : 'host off'}
                      {d.inputSupported ? ' · input ok' : ' · view only'}
                    </div>
                  </div>
                  <button
                    className="p-btn p-accent"
                    disabled={!d.available}
                    onClick={() => connectTo(d.id, d.name)}>
                    connect
                  </button>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: 'var(--fg-dim)', padding: '2px 4px' }}>
              this device: {deviceId.slice(0, 8)}
            </div>
          </>
        )}

        {target && (
          <>
            <div className="p-row" style={{ justifyContent: 'space-between' }}>
              <div className="p-label">
                {isConnected ? 'connected' : (isPending ? target.status : 'idle')}
                <span className="p-accent" style={{ marginLeft: 6 }}>{target.peerName}</span>
              </div>
              <div className="p-row" style={{ gap: 6 }}>
                <label className="p-row" style={{ gap: 4, fontSize: 10, cursor: 'pointer' }}>
                  <input type="checkbox" checked={sendInput} onChange={(e) => setSendInput(e.target.checked)} />
                  send input
                </label>
                <button className="p-btn" onClick={() => teardown('viewer-ended')}>disconnect</button>
              </div>
            </div>
            <div style={{
              flex: 1,
              position: 'relative',
              background: 'var(--bg)',
              border: '1px solid var(--border-bright)',
              borderRadius: 4,
              overflow: 'hidden',
            }}>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                tabIndex={0}
                onMouseMove={onMouseMove}
                onMouseDown={onMouseDown}
                onMouseUp={onMouseUp}
                onWheel={onWheel}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onContextMenu={onContextMenu}
                onClick={(e) => e.currentTarget.focus()}
                style={{
                  width: '100%', height: '100%',
                  objectFit: 'contain',
                  outline: 'none',
                  cursor: sendInput && isConnected ? 'crosshair' : 'default',
                }}
              />
              {!isConnected && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, color: 'var(--fg-dim)',
                  background: 'rgba(0,0,0,0.4)',
                  pointerEvents: 'none',
                }}>
                  {target.status === 'requesting' && 'waiting for accept…'}
                  {target.status === 'negotiating' && 'negotiating…'}
                </div>
              )}
            </div>
            <div style={{ fontSize: 10, color: 'var(--fg-dim)', maxHeight: 60, overflowY: 'auto' }}>
              {log.slice(-6).reverse().map((l, i) => (
                <div key={l.ts + ':' + i} className="p-mono">
                  {new Date(l.ts).toLocaleTimeString()} · {l.line}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  },
};
