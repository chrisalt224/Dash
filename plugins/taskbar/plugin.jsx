// Taskbar — Shows open OS windows as chips. Click to focus, × to close.
//
// • Polls window.dashboard.windows.list() every 1.5s.
// • Each chip: app icon + (process name) + window title (truncated). Hover
//   reveals × close + _ minimize buttons.
// • Right-click chip = close (still gentle WM_CLOSE — apps can prompt).
// • Designed for width 4 height 1 — drag it to the bottom of your grid for
//   a real-taskbar look. Works at narrower sizes via horizontal scroll.

const KEY = 'plugin:taskbar:state:v1';
const POLL_MS = 3000;

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { showName: false, sort: 'name', ...raw };
  } catch {}
  return { showName: false, sort: 'name' };
};

const truncate = (s, max) => {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
};

// Many window titles end with " - AppName" or " — AppName". Strip the most
// obvious case so chips read cleanly. Conservative: only strip if there's a
// clear separator AND the right-hand side looks like the process name.
const cleanTitle = (title, procName) => {
  if (!title) return '';
  const seps = [' - ', ' — ', ' – '];
  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx > 0) {
      const tail = title.slice(idx + sep.length);
      if (procName && tail.toLowerCase().includes(procName.toLowerCase())) {
        return title.slice(0, idx);
      }
    }
  }
  return title;
};

export default {
  id: 'taskbar',
  name: 'Taskbar',
  width: 4,
  height: 1,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [list, setList] = useState([]);
    const [error, setError] = useState(null);
    const [hoverHwnd, setHoverHwnd] = useState(null);
    const [confirmHwnd, setConfirmHwnd] = useState(null);
    const [busy, setBusy] = useState(false); // true during focus/close — disables polling briefly
    const confirmTimer = useRef(null);
    const busyRef = useRef(busy);
    useEffect(() => { busyRef.current = busy; }, [busy]);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    // Polling loop
    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        if (busyRef.current) return; // skip while user-action in flight
        const api = window.dashboard && window.dashboard.windows;
        if (!api || !api.list) {
          if (!cancelled) setError('host has no windows API — restart the app');
          return;
        }
        try {
          const res = await api.list();
          if (cancelled) return;
          if (res && res.error) setError(res.error);
          else setError(null);
          setList(res && Array.isArray(res.list) ? res.list : []);
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      };
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    const sorted = useMemo(() => {
      const copy = list.slice();
      if (state.sort === 'name') {
        copy.sort((a, b) => {
          const an = (a.name || '').toLowerCase();
          const bn = (b.name || '').toLowerCase();
          if (an !== bn) return an.localeCompare(bn);
          return (a.title || '').localeCompare(b.title || '');
        });
      }
      // 'pid' = stable insertion order from PS, useful when name-sort flips on title change
      else copy.sort((a, b) => (a.pid || 0) - (b.pid || 0));
      return copy;
    }, [list, state.sort]);

    const onFocus = async (hwnd) => {
      const api = window.dashboard && window.dashboard.windows;
      if (!api) return;
      setBusy(true);
      try { await api.focus(hwnd); }
      catch {}
      finally {
        // Brief skip — focus changes the foreground process which the next
        // poll might not reflect for a moment
        setTimeout(() => setBusy(false), 250);
      }
    };

    const onClose = (hwnd) => {
      if (confirmHwnd === hwnd) {
        setConfirmHwnd(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        const api = window.dashboard && window.dashboard.windows;
        if (api) api.close(hwnd).catch(() => {});
        // Optimistically drop from list so UI feels snappy
        setList((l) => l.filter((w) => String(w.hwnd) !== String(hwnd)));
        return;
      }
      setConfirmHwnd(hwnd);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmHwnd(null), 2500);
    };

    const onMin = (hwnd) => {
      const api = window.dashboard && window.dashboard.windows;
      if (api) api.minimize(hwnd).catch(() => {});
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {/* Strip of chips */}
        <div style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          overflowX: 'auto',
          overflowY: 'hidden',
          paddingBottom: 2,
        }}>
          {error && (
            <div style={{
              padding: '3px 8px',
              color: 'var(--danger)',
              border: '1px dashed var(--danger)',
              borderRadius: 3,
              fontSize: 10,
              flexShrink: 0,
            }}>! {error}</div>
          )}
          {!error && sorted.length === 0 && (
            <span className="p-dim" style={{ fontSize: 10, padding: '0 8px' }}>
              no other windows open
            </span>
          )}
          {sorted.map((w) => {
            const hovered = hoverHwnd === w.hwnd;
            const armed = confirmHwnd === w.hwnd;
            const display = cleanTitle(w.title, w.name) || w.name || '?';
            const tooltip = w.name + (w.title ? ' — ' + w.title : '') + ' · pid ' + w.pid;
            return (
              <div
                key={w.hwnd}
                onMouseEnter={() => setHoverHwnd(w.hwnd)}
                onMouseLeave={() => { setHoverHwnd(null); if (!armed) setConfirmHwnd(null); }}
                onClick={() => onFocus(w.hwnd)}
                onContextMenu={(e) => { e.preventDefault(); onClose(w.hwnd); }}
                onAuxClick={(e) => { if (e.button === 1) onClose(w.hwnd); }}
                title={tooltip}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px 3px 6px',
                  border: '1px solid ' + (hovered ? 'var(--accent)' : 'var(--border-bright)'),
                  borderRadius: 3,
                  background: hovered ? 'rgba(var(--accent-rgb),0.06)' : 'rgba(var(--accent-rgb),0.02)',
                  boxShadow: hovered ? 'var(--glow-soft)' : 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--fg)',
                  flexShrink: 0,
                  maxWidth: 200,
                  height: 26,
                  transition: 'border-color 0.1s ease, background 0.1s ease',
                }}
              >
                {w.iconDataUrl ? (
                  <img
                    src={w.iconDataUrl}
                    alt=""
                    width={16} height={16}
                    style={{ flexShrink: 0, imageRendering: 'auto' }}
                  />
                ) : (
                  <span style={{
                    width: 16, height: 16,
                    background: 'var(--border-bright)',
                    borderRadius: 2,
                    flexShrink: 0,
                  }} />
                )}
                <span style={{
                  flex: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                }}>
                  {state.showName && w.name && (
                    <span style={{ color: 'var(--fg-dim)' }}>{w.name}</span>
                  )}
                  {state.showName && w.name && display !== w.name && (
                    <span style={{ color: 'var(--fg-dim)' }}> · </span>
                  )}
                  <span>{truncate(display, 28)}</span>
                </span>
                {(hovered || armed) && (
                  <div style={{
                    display: 'flex',
                    gap: 2,
                    flexShrink: 0,
                    marginLeft: 2,
                  }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); onMin(w.hwnd); }}
                      title="minimize"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--fg-dim)',
                        cursor: 'pointer',
                        fontFamily: 'var(--mono)',
                        fontSize: 14,
                        lineHeight: 0.5,
                        padding: '0 3px',
                      }}
                    >_</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onClose(w.hwnd); }}
                      title={armed ? 'click again to close' : 'close (right-click also)'}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: armed ? 'var(--danger)' : 'var(--fg-dim)',
                        cursor: 'pointer',
                        fontFamily: 'var(--mono)',
                        fontSize: armed ? 11 : 14,
                        lineHeight: 1,
                        padding: '0 3px',
                        fontWeight: armed ? 700 : 400,
                      }}
                    >{armed ? '✓?' : '×'}</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Footer (visible only when widget is tall enough) */}
        <div className="p-row" style={{ justifyContent: 'space-between', fontSize: 9, alignItems: 'center' }}>
          <span className="p-dim">{sorted.length} window{sorted.length !== 1 ? 's' : ''}</span>
          <div className="p-row" style={{ gap: 4 }}>
            <button
              onClick={() => setState((s) => ({ ...s, showName: !s.showName }))}
              title="toggle process-name prefix"
              style={{
                background: 'transparent',
                border: '1px solid var(--border-bright)',
                color: state.showName ? 'var(--accent)' : 'var(--fg-dim)',
                fontFamily: 'var(--mono)',
                fontSize: 9,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                padding: '1px 6px',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >app</button>
            <button
              onClick={() => setState((s) => ({ ...s, sort: s.sort === 'name' ? 'pid' : 'name' }))}
              title={'sort: ' + state.sort}
              style={{
                background: 'transparent',
                border: '1px solid var(--border-bright)',
                color: 'var(--fg-dim)',
                fontFamily: 'var(--mono)',
                fontSize: 9,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                padding: '1px 6px',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >sort: {state.sort}</button>
          </div>
        </div>
      </div>
    );
  },
};
