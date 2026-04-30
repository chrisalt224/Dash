// Launcher — auto-discovers installed apps from the Windows Start Menu
// and lets you add your own.
//
// Click a tile to launch.
// Hover a tile for ★ favorite · × hide · − remove (your own apps only).
// Drag a tile onto another to reorder.
// Favorites pin to the front of the grid; ordered alphabetically by default
// but you can drag to set a custom order within favorites and within
// non-favorites.

const USER_APPS_KEY = 'plugin:launcher:userApps:v1';
const HIDDEN_KEY = 'plugin:launcher:hidden:v1';
const FAVS_KEY = 'plugin:launcher:favs:v1';
const ORDER_KEY = 'plugin:launcher:order:v1';

const loadJson = (key, dflt) => {
  try { return JSON.parse(localStorage.getItem(key)) || dflt; }
  catch { return dflt; }
};

const Tile = ({
  app, hidden, isFav, isDragging, isDropTarget,
  onLaunch, onToggleHide, onToggleFav, onRemove,
  onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
  useState,
}) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      draggable={true}
      onDragStart={(e) => onDragStart(app.id, e)}
      onDragOver={(e) => onDragOver(app.id, e)}
      onDragLeave={() => onDragLeave(app.id)}
      onDrop={(e) => onDrop(app.id, e)}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onLaunch}
      title={`${app.name}\n${app.target || ''}`}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8px 4px',
        borderRadius: 6,
        cursor: 'pointer',
        opacity: hidden ? 0.45 : (isDragging ? 0.35 : 1),
        background: isDropTarget
          ? 'rgba(var(--accent-rgb),0.16)'
          : hover ? 'rgba(var(--accent-rgb),0.08)' : 'transparent',
        border: '1px solid ' + (
          isDropTarget ? 'var(--accent)' :
          hover ? 'var(--accent)' : 'transparent'
        ),
        boxShadow: (hover || isDropTarget) ? 'var(--glow-soft)' : 'none',
        transition: 'background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease',
        userSelect: 'none',
      }}
    >
      {/* Favorite indicator (always visible when favorited) */}
      {isFav && (
        <span
          style={{
            position: 'absolute',
            top: 2, left: 3,
            color: 'var(--accent-warm)',
            fontSize: 11,
            lineHeight: 1,
            textShadow: '0 0 4px var(--accent-warm)',
            pointerEvents: 'none',
          }}
        >★</span>
      )}

      {app.iconDataUrl ? (
        <img
          src={app.iconDataUrl}
          width={32}
          height={32}
          alt=""
          draggable={false}
          style={{ imageRendering: 'auto' }}
        />
      ) : (
        <div style={{
          width: 32, height: 32,
          background: 'var(--border-bright)',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent)',
          fontWeight: 600,
        }}>{(app.name || '?')[0].toUpperCase()}</div>
      )}
      <div style={{
        fontSize: 10,
        textAlign: 'center',
        marginTop: 5,
        width: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--fg)',
      }}>{app.name}</div>

      {hover && (
        <div style={{
          position: 'absolute',
          top: 2, right: 2,
          display: 'flex',
          gap: 2,
        }}>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFav(); }}
            onMouseDown={(e) => e.stopPropagation()}
            title={isFav ? 'unfavorite' : 'favorite (pin to front)'}
            style={{
              width: 18, height: 18,
              border: '1px solid ' + (isFav ? 'var(--accent-warm)' : 'var(--border-bright)'),
              borderRadius: 3,
              background: 'rgba(0,0,0,0.7)',
              color: isFav ? 'var(--accent-warm)' : 'var(--fg)',
              fontSize: 11,
              lineHeight: 1,
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'var(--mono)',
            }}
          >★</button>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleHide(); }}
            onMouseDown={(e) => e.stopPropagation()}
            title={hidden ? 'unhide' : 'hide from launcher'}
            style={{
              width: 18, height: 18,
              border: '1px solid var(--border-bright)',
              borderRadius: 3,
              background: 'rgba(0,0,0,0.7)',
              color: 'var(--fg)',
              fontSize: 11,
              lineHeight: 1,
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'var(--mono)',
            }}
          >{hidden ? '↺' : '×'}</button>
          {onRemove && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              onMouseDown={(e) => e.stopPropagation()}
              title="remove (only for apps you added)"
              style={{
                width: 18, height: 18,
                border: '1px solid var(--danger)',
                borderRadius: 3,
                background: 'rgba(0,0,0,0.7)',
                color: 'var(--danger)',
                fontSize: 11,
                lineHeight: 1,
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'var(--mono)',
              }}
            >−</button>
          )}
        </div>
      )}
    </div>
  );
};

export default {
  id: 'launcher',
  name: 'Launcher',
  width: 4,
  height: 2,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [discovered, setDiscovered] = useState([]);
    const [userApps, setUserApps] = useState(() => loadJson(USER_APPS_KEY, []));
    const [hidden, setHidden] = useState(() => new Set(loadJson(HIDDEN_KEY, [])));
    const [favs, setFavs] = useState(() => new Set(loadJson(FAVS_KEY, [])));
    const [order, setOrder] = useState(() => loadJson(ORDER_KEY, []));
    const [search, setSearch] = useState('');
    const [showHidden, setShowHidden] = useState(false);
    const [loading, setLoading] = useState(true);
    const [dragId, setDragId] = useState(null);
    const [overId, setOverId] = useState(null);

    const persistHidden = (next) => {
      setHidden(next);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    };
    const persistUserApps = (next) => {
      setUserApps(next);
      localStorage.setItem(USER_APPS_KEY, JSON.stringify(next));
    };
    const persistFavs = (next) => {
      setFavs(next);
      localStorage.setItem(FAVS_KEY, JSON.stringify([...next]));
    };
    const persistOrder = (next) => {
      setOrder(next);
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    };

    useEffect(() => {
      let cancelled = false;
      window.dashboard.apps.discover().then((apps) => {
        if (cancelled) return;
        setDiscovered(apps || []);
        setLoading(false);
      }).catch(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, []);

    const allApps = useMemo(() => {
      const merged = [...userApps, ...discovered];
      const seen = new Set();
      const out = [];
      for (const a of merged) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        out.push(a);
      }
      return out;
    }, [userApps, discovered]);

    const visibleApps = useMemo(() => {
      const q = search.trim().toLowerCase();
      const filtered = allApps.filter((a) => {
        const isHidden = hidden.has(a.id);
        if (showHidden ? !isHidden : isHidden) return false;
        if (q && !a.name.toLowerCase().includes(q)) return false;
        return true;
      });
      // Sort: favorites first; within each group, by user order index, then alphabetical
      const orderMap = new Map(order.map((id, i) => [id, i]));
      filtered.sort((a, b) => {
        const aFav = favs.has(a.id);
        const bFav = favs.has(b.id);
        if (aFav !== bFav) return aFav ? -1 : 1;
        const ao = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
        const bo = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      });
      return filtered;
    }, [allApps, hidden, showHidden, search, favs, order]);

    const launch = (a) => {
      const target = a.launchPath || a.target;
      if (!target) return;
      if (/\.lnk$/i.test(target) || a.source === 'discovered') {
        window.dashboard.shell.open(target);
      } else {
        window.dashboard.shell.launch(target, []);
      }
    };

    const addApp = async () => {
      const filePath = await window.dashboard.dialog.openFile({
        title: 'Pick an app to add',
        filters: [
          { name: 'Programs', extensions: ['exe', 'lnk', 'bat', 'cmd'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (!filePath) return;

      let iconSource = filePath;
      let target = filePath;
      const launchPath = filePath;
      if (/\.lnk$/i.test(filePath)) {
        const link = await window.dashboard.shell.readShortcut(filePath);
        if (link && link.target) {
          target = link.target;
          iconSource = link.target;
        }
      }

      let iconDataUrl = await window.dashboard.shell.getFileIcon(iconSource);
      if (!iconDataUrl && iconSource !== filePath) {
        iconDataUrl = await window.dashboard.shell.getFileIcon(filePath);
      }

      const baseName = filePath.split(/[\\/]/).pop().replace(/\.(exe|lnk|bat|cmd)$/i, '');
      const newApp = {
        id: 'user:' + filePath,
        source: 'user',
        name: baseName,
        target,
        launchPath,
        iconDataUrl,
      };
      if (userApps.some((a) => a.id === newApp.id)) return;
      persistUserApps([...userApps, newApp]);
    };

    const toggleHide = (id) => {
      const next = new Set(hidden);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistHidden(next);
    };

    const toggleFav = (id) => {
      const next = new Set(favs);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistFavs(next);
    };

    const removeUser = (id) => {
      persistUserApps(userApps.filter((a) => a.id !== id));
      // Also clean up favorite/order/hidden entries
      if (favs.has(id)) {
        const f = new Set(favs); f.delete(id); persistFavs(f);
      }
      if (hidden.has(id)) {
        const h = new Set(hidden); h.delete(id); persistHidden(h);
      }
      if (order.includes(id)) persistOrder(order.filter((x) => x !== id));
    };

    const refresh = async () => {
      setLoading(true);
      try {
        const apps = await window.dashboard.apps.discover({ refresh: true });
        setDiscovered(apps || []);
      } finally { setLoading(false); }
    };

    // ---- Drag-and-drop reorder ----
    // Build a new global order so that the dropped app sits where the target
    // app was within the displayed list. Cross-group drags (fav onto non-fav
    // or vice versa) are no-ops to avoid surprising "snap back" behavior.
    const reorderApp = (fromId, toId) => {
      if (fromId === toId) return;
      const fromFav = favs.has(fromId);
      const toFav = favs.has(toId);
      if (fromFav !== toFav) return; // silently ignore cross-group drops

      const visibleIds = visibleApps.map((a) => a.id);
      const fromIdx = visibleIds.indexOf(fromId);
      const toIdx = visibleIds.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return;
      const newVisibleOrder = visibleIds.slice();
      newVisibleOrder.splice(fromIdx, 1);
      newVisibleOrder.splice(toIdx, 0, fromId);

      // Combine with rest of order (apps not currently visible) so we don't
      // lose the user's saved positions for hidden / search-filtered apps.
      const visibleSet = new Set(visibleIds);
      const restOrder = order.filter((id) => !visibleSet.has(id));
      persistOrder([...newVisibleOrder, ...restOrder]);
    };

    const onDragStart = (id, ev) => {
      ev.dataTransfer.setData('text/plain', id);
      ev.dataTransfer.effectAllowed = 'move';
      setDragId(id);
    };
    const onDragOver = (id, ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      if (id !== overId) setOverId(id);
    };
    const onDragLeave = (id) => {
      setOverId((cur) => (cur === id ? null : cur));
    };
    const onDrop = (toId, ev) => {
      ev.preventDefault();
      const fromId = ev.dataTransfer.getData('text/plain') || dragId;
      setDragId(null); setOverId(null);
      if (fromId) reorderApp(fromId, toId);
    };
    const onDragEnd = () => { setDragId(null); setOverId(null); };

    const hiddenCount = hidden.size;
    const favCount = favs.size;

    return (
      <div className="p-col" style={{ height: '100%', gap: 8 }}>
        <div className="p-row" style={{ gap: 6 }}>
          <input
            className="p-input"
            placeholder="search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="p-btn" onClick={addApp} title="add an app">+ add</button>
          <button
            className="p-btn"
            onClick={() => setShowHidden(!showHidden)}
            title="toggle hidden apps view"
            style={{
              color: showHidden ? 'var(--accent-warm)' : undefined,
              borderColor: showHidden ? 'var(--accent-warm)' : undefined,
            }}
          >{showHidden ? `← back (${hiddenCount})` : `${hiddenCount} hidden`}</button>
          <button className="p-btn" onClick={refresh} title="rescan Start Menu">↻</button>
        </div>
        {favCount > 0 && !showHidden && (
          <div className="p-dim" style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', paddingLeft: 2 }}>
            ★ {favCount} favorite{favCount === 1 ? '' : 's'} pinned · drag tiles to reorder
          </div>
        )}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))',
          gap: 4,
          alignContent: 'start',
        }}>
          {loading && (
            <div className="p-dim" style={{ gridColumn: '1 / -1', padding: 20, textAlign: 'center' }}>
              ▸ scanning Start Menu...
            </div>
          )}
          {!loading && visibleApps.length === 0 && (
            <div className="p-dim" style={{ gridColumn: '1 / -1', padding: 20, textAlign: 'center' }}>
              {showHidden ? 'no hidden apps' : (search ? 'no matches' : 'no apps. click + to add one.')}
            </div>
          )}
          {visibleApps.map((a) => (
            <Tile
              key={a.id}
              app={a}
              hidden={hidden.has(a.id)}
              isFav={favs.has(a.id)}
              isDragging={dragId === a.id}
              isDropTarget={overId === a.id && dragId && dragId !== a.id && favs.has(dragId) === favs.has(a.id)}
              onLaunch={() => launch(a)}
              onToggleHide={() => toggleHide(a.id)}
              onToggleFav={() => toggleFav(a.id)}
              onRemove={a.source === 'user' ? () => removeUser(a.id) : null}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
              useState={useState}
            />
          ))}
        </div>
      </div>
    );
  },
};
