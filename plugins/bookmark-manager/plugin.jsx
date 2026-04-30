// Bookmark Manager — URLs in folders, click to open in default browser.
//
// • Folders are collapsible. Click any bookmark to shell.openExternal it.
// • + bookmark adds to the currently expanded folder (or "default"). + folder
//   creates a new section. Edit toggles inline rename + drag-to-reorder.
// • Each bookmark gets a colored letter-tile icon (deterministic by domain)
//   so you don't need favicons. CSP doesn't allow third-party img loads
//   from the renderer anyway.
// • Persistent. Different from `quick-links` — bookmarks support folders +
//   reordering + descriptions.

const KEY = 'plugin:bookmark-manager:state:v1';

const TILE_COLORS = ['var(--accent)', 'var(--accent-warm)', '#5eeaff', '#ff6bd6', 'var(--fg-bright)', '#ff9c39', '#a3ff7a'];

const DEFAULTS = {
  folders: [
    { id: 'default', name: 'links', expanded: true },
  ],
  bookmarks: [
    { id: 'b1', folder: 'default', title: 'Hacker News', url: 'https://news.ycombinator.com', notes: '' },
    { id: 'b2', folder: 'default', title: 'GitHub',      url: 'https://github.com',           notes: '' },
  ],
};

const newId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.folders) && Array.isArray(raw.bookmarks)) return raw;
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULTS));
};

const hostnameOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
};

// Deterministic color/letter from domain so the same site always looks the same
const tileFor = (url, title) => {
  const host = hostnameOf(url) || title || '?';
  const letter = (host[0] || '?').toUpperCase();
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) | 0;
  const color = TILE_COLORS[Math.abs(h) % TILE_COLORS.length];
  return { letter, color };
};

const ensureProto = (url) => {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return 'https://' + url;
};

export default {
  id: 'bookmark-manager',
  name: 'Bookmarks',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [editing, setEditing] = useState(null); // bookmark id
    const [draft, setDraft] = useState({ title: '', url: '', notes: '', folder: 'default' });
    const [adding, setAdding] = useState(null); // folder id we're adding into
    const [boardEdit, setBoardEdit] = useState(false);
    const [confirmId, setConfirmId] = useState(null);
    const [query, setQuery] = useState('');
    const [dragId, setDragId] = useState(null);
    const [dropTarget, setDropTarget] = useState(null); // {folder, beforeId} or {folder, end:true}
    const confirmTimer = useRef(null);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const open = (url) => {
      try {
        const api = window.dashboard && window.dashboard.shell;
        if (api && api.openExternal) api.openExternal(ensureProto(url));
      } catch {}
    };

    const startAdd = (folderId) => {
      setAdding(folderId);
      setDraft({ title: '', url: '', notes: '', folder: folderId });
      setEditing('__new__');
      // Make sure the folder is expanded so the form is visible
      setState((s) => ({
        ...s,
        folders: s.folders.map((f) => f.id === folderId ? { ...f, expanded: true } : f),
      }));
    };

    const startEdit = (bookmark) => {
      setEditing(bookmark.id);
      setDraft({ title: bookmark.title || '', url: bookmark.url || '', notes: bookmark.notes || '', folder: bookmark.folder });
      setAdding(null);
    };

    const saveEdit = () => {
      const url = draft.url.trim();
      const title = draft.title.trim() || hostnameOf(ensureProto(url)) || url;
      if (!url) return; // need at least a URL
      if (editing === '__new__') {
        const id = newId('bm');
        setState((s) => ({
          ...s,
          bookmarks: [...s.bookmarks, { id, folder: draft.folder, title, url, notes: draft.notes }],
        }));
      } else {
        setState((s) => ({
          ...s,
          bookmarks: s.bookmarks.map((b) =>
            b.id === editing ? { ...b, title, url, notes: draft.notes, folder: draft.folder } : b
          ),
        }));
      }
      setEditing(null);
      setAdding(null);
    };

    const cancelEdit = () => { setEditing(null); setAdding(null); };

    const deleteBookmark = (id) => {
      if (confirmId === id) {
        setState((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    // Folder ops
    const addFolder = () => {
      const id = newId('f');
      setState((s) => ({ ...s, folders: [...s.folders, { id, name: 'new folder', expanded: true }] }));
    };
    const renameFolder = (id, name) =>
      setState((s) => ({ ...s, folders: s.folders.map((f) => f.id === id ? { ...f, name } : f) }));
    const toggleFolder = (id) =>
      setState((s) => ({ ...s, folders: s.folders.map((f) => f.id === id ? { ...f, expanded: !f.expanded } : f) }));
    const removeFolder = (id) => {
      if (confirmId === 'f:' + id) {
        setState((s) => ({
          ...s,
          folders: s.folders.filter((f) => f.id !== id),
          bookmarks: s.bookmarks.filter((b) => b.folder !== id),
        }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId('f:' + id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    // Drag & drop within / between folders
    const onDragStart = (id, ev) => {
      setDragId(id);
      ev.dataTransfer.effectAllowed = 'move';
    };
    const onDragEnd = () => { setDragId(null); setDropTarget(null); };
    const onDragOverBookmark = (folderId, beforeId, ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = 'move';
      setDropTarget({ folder: folderId, beforeId });
    };
    const onDragOverFolder = (folderId, ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      setDropTarget({ folder: folderId, beforeId: null, end: true });
    };
    const onDrop = (ev) => {
      ev.preventDefault();
      if (!dragId || !dropTarget) { setDragId(null); setDropTarget(null); return; }
      setState((s) => {
        const idx = s.bookmarks.findIndex((b) => b.id === dragId);
        if (idx === -1) return s;
        const bookmarks = s.bookmarks.slice();
        const [b] = bookmarks.splice(idx, 1);
        b.folder = dropTarget.folder;
        if (dropTarget.beforeId) {
          const beforeIdx = bookmarks.findIndex((x) => x.id === dropTarget.beforeId);
          if (beforeIdx === -1) bookmarks.push(b);
          else bookmarks.splice(beforeIdx, 0, b);
        } else {
          bookmarks.push(b);
        }
        return { ...s, bookmarks };
      });
      setDragId(null);
      setDropTarget(null);
    };

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return state.bookmarks;
      return state.bookmarks.filter((b) =>
        (b.title || '').toLowerCase().includes(q) ||
        (b.url || '').toLowerCase().includes(q) ||
        (b.notes || '').toLowerCase().includes(q)
      );
    }, [state.bookmarks, query]);

    const bookmarksFor = (folderId) => filtered.filter((b) => b.folder === folderId);

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search…"
            spellCheck={false}
            className="p-input"
            style={{ flex: 1, fontSize: 11 }}
          />
          {boardEdit && (
            <button className="p-btn" onClick={addFolder} style={{ fontSize: 10, padding: '2px 8px' }}>+ folder</button>
          )}
          <button
            onClick={() => setBoardEdit((b) => !b)}
            style={{
              background: boardEdit ? 'rgba(255,180,84,0.15)' : 'transparent',
              border: '1px solid ' + (boardEdit ? 'var(--accent-warm)' : 'var(--border-bright)'),
              color: boardEdit ? 'var(--accent-warm)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '2px 6px', borderRadius: 2, cursor: 'pointer',
              letterSpacing: '0.1em', textTransform: 'uppercase',
            }}
          >{boardEdit ? 'done' : 'edit'}</button>
        </div>

        {/* Folders */}
        <div
          style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}
          onDrop={onDrop}
        >
          {state.folders.map((folder) => {
            const bms = bookmarksFor(folder.id);
            return (
              <div
                key={folder.id}
                onDragOver={(e) => bms.length === 0 && onDragOverFolder(folder.id, e)}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  background: 'rgba(0,0,0,0.2)',
                  overflow: 'hidden',
                }}
              >
                {/* Folder header */}
                <div
                  className="p-row"
                  style={{
                    alignItems: 'center', gap: 4,
                    padding: '4px 6px',
                    background: 'rgba(var(--accent-rgb),0.04)',
                    cursor: boardEdit ? 'default' : 'pointer',
                  }}
                  onClick={() => !boardEdit && toggleFolder(folder.id)}
                >
                  <span style={{
                    color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 11,
                    width: 10, flexShrink: 0,
                  }}>{folder.expanded ? '▾' : '▸'}</span>
                  {boardEdit ? (
                    <input
                      value={folder.name}
                      onChange={(e) => renameFolder(folder.id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="p-input"
                      style={{ flex: 1, fontSize: 11, padding: '1px 4px' }}
                    />
                  ) : (
                    <span style={{
                      flex: 1,
                      fontFamily: 'var(--mono)', fontSize: 11,
                      color: 'var(--fg-bright)', textTransform: 'uppercase',
                      letterSpacing: '0.1em', fontWeight: 600,
                    }}>{folder.name}</span>
                  )}
                  <span className="p-dim" style={{ fontSize: 9 }}>{bms.length}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); startAdd(folder.id); }}
                    title="add bookmark to this folder"
                    style={{
                      background: 'transparent', border: 'none',
                      color: 'var(--fg-dim)', cursor: 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 11, padding: '0 4px',
                    }}
                  >+</button>
                  {boardEdit && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFolder(folder.id); }}
                      title="delete folder + bookmarks"
                      style={{
                        background: 'transparent', border: 'none',
                        color: confirmId === 'f:' + folder.id ? 'var(--danger)' : 'var(--fg-dim)',
                        cursor: 'pointer', fontFamily: 'var(--mono)',
                        fontSize: confirmId === 'f:' + folder.id ? 10 : 13,
                        padding: '0 4px', lineHeight: 1,
                      }}
                    >{confirmId === 'f:' + folder.id ? '✓?' : '×'}</button>
                  )}
                </div>
                {/* Bookmarks list */}
                {folder.expanded && (
                  <div style={{
                    padding: 3,
                    display: 'flex', flexDirection: 'column', gap: 2,
                  }}>
                    {bms.length === 0 && editing !== '__new__' && !adding && (
                      <div className="p-dim" style={{ fontSize: 10, padding: 4, textAlign: 'center' }}>(empty)</div>
                    )}
                    {bms.map((b) => {
                      const tile = tileFor(b.url, b.title);
                      const isEditing = editing === b.id;
                      const armed = confirmId === b.id;
                      const isDragging = dragId === b.id;
                      const showBefore = dropTarget && dropTarget.folder === folder.id && dropTarget.beforeId === b.id;
                      return (
                        <React.Fragment key={b.id}>
                          {showBefore && (
                            <div style={{
                              height: 2, background: 'var(--accent)',
                              boxShadow: '0 0 6px var(--accent)',
                              margin: '1px 0',
                            }} />
                          )}
                          <div
                            draggable={!isEditing}
                            onDragStart={(e) => onDragStart(b.id, e)}
                            onDragEnd={onDragEnd}
                            onDragOver={(e) => onDragOverBookmark(folder.id, b.id, e)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6,
                              padding: '3px 4px',
                              border: '1px solid var(--border)',
                              borderRadius: 2,
                              background: 'rgba(var(--accent-rgb),0.02)',
                              cursor: isEditing ? 'default' : 'pointer',
                              opacity: isDragging ? 0.4 : 1,
                            }}
                            onClick={() => !isEditing && open(b.url)}
                          >
                            <div style={{
                              width: 18, height: 18,
                              background: tile.color,
                              color: 'var(--bg)',
                              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              borderRadius: 2,
                              boxShadow: '0 0 4px ' + tile.color,
                              flexShrink: 0,
                            }}>{tile.letter}</div>
                            {isEditing ? (
                              <BookmarkEditForm
                                draft={draft}
                                setDraft={setDraft}
                                folders={state.folders}
                                onSave={saveEdit}
                                onCancel={cancelEdit}
                                onDelete={() => deleteBookmark(b.id)}
                                armed={armed}
                              />
                            ) : (
                              <>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{
                                    fontFamily: 'var(--mono)', fontSize: 11,
                                    color: 'var(--fg-bright)',
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    lineHeight: 1.3,
                                  }}>{b.title}</div>
                                  <div style={{
                                    fontFamily: 'var(--mono)', fontSize: 9,
                                    color: 'var(--fg-dim)',
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  }}>{hostnameOf(b.url) || b.url}</div>
                                </div>
                                {boardEdit && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); startEdit(b); }}
                                    title="edit"
                                    style={{
                                      background: 'transparent', border: 'none',
                                      color: 'var(--fg-dim)', cursor: 'pointer',
                                      fontFamily: 'var(--mono)', fontSize: 11, padding: '0 4px',
                                    }}
                                  >✎</button>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); deleteBookmark(b.id); }}
                                  title="delete"
                                  style={{
                                    background: 'transparent', border: 'none',
                                    color: armed ? 'var(--danger)' : 'var(--fg-dim)',
                                    cursor: 'pointer', fontFamily: 'var(--mono)',
                                    fontSize: armed ? 10 : 13,
                                    padding: '0 4px', lineHeight: 1,
                                  }}
                                >{armed ? '✓?' : '×'}</button>
                              </>
                            )}
                          </div>
                        </React.Fragment>
                      );
                    })}
                    {/* Inline new-bookmark form */}
                    {adding === folder.id && editing === '__new__' && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '3px 4px',
                        border: '1px dashed var(--accent)',
                        borderRadius: 2,
                        background: 'rgba(var(--accent-rgb),0.06)',
                      }}>
                        <div style={{
                          width: 18, height: 18,
                          border: '1px solid var(--border-bright)',
                          borderRadius: 2,
                          flexShrink: 0,
                        }} />
                        <BookmarkEditForm
                          draft={draft}
                          setDraft={setDraft}
                          folders={state.folders}
                          onSave={saveEdit}
                          onCancel={cancelEdit}
                          armed={false}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};

function BookmarkEditForm({ draft, setDraft, folders, onSave, onCancel, onDelete, armed }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <input
        value={draft.title}
        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        placeholder="title (optional)"
        autoFocus
        spellCheck={false}
        onKeyDown={(e) => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid var(--border)', borderRadius: 2,
          color: 'var(--fg-bright)',
          fontFamily: 'var(--mono)', fontSize: 11,
          outline: 'none', padding: '1px 4px',
        }}
      />
      <input
        value={draft.url}
        onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
        placeholder="https://…"
        spellCheck={false}
        onKeyDown={(e) => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid var(--border)', borderRadius: 2,
          color: 'var(--accent)',
          fontFamily: 'var(--mono)', fontSize: 10,
          outline: 'none', padding: '1px 4px',
        }}
      />
      <div className="p-row" style={{ gap: 2, marginTop: 2 }}>
        <select
          value={draft.folder}
          onChange={(e) => setDraft((d) => ({ ...d, folder: e.target.value }))}
          onClick={(e) => e.stopPropagation()}
          className="p-input"
          style={{ flex: 1, fontSize: 9, padding: '1px 4px' }}
        >
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{
              background: 'transparent', border: 'none',
              color: armed ? 'var(--danger)' : 'var(--fg-dim)',
              cursor: 'pointer', fontFamily: 'var(--mono)',
              fontSize: armed ? 9 : 11, padding: '0 4px',
              fontWeight: armed ? 700 : 400, lineHeight: 1,
            }}
          >{armed ? '✓ del' : '×'}</button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          className="p-btn"
          style={{ fontSize: 9, padding: '1px 6px' }}
        >cancel</button>
        <button
          onClick={(e) => { e.stopPropagation(); onSave(); }}
          className="p-btn"
          style={{ fontSize: 9, padding: '1px 8px' }}
        >save</button>
      </div>
    </div>
  );
}
