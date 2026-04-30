// Scratchpad — terminal-style notes backed by real .md files on disk.
//
// Files live at <userData>/notes/ (path shown in the footer; click 📁 to open).
// Title `work/standup` → file `work/standup.md`. Folder structure on disk
// mirrors the title prefix, so you can edit notes externally (VS Code, etc.)
// and they'll show up here on next refresh.
//
// Browse view (default) lists all notes grouped by folder. Click to open.
// Edit view: ← back · ✎ rename (use folder/name to organize) · × delete (×× to confirm).

const MIGRATION_KEY = 'plugin:notes:migrated:disk:v1';
const ACTIVE_KEY = 'plugin:notes:active:disk';
const COLLAPSED_KEY = 'plugin:notes:collapsed:v3';

const TERM_BG = 'var(--bg)';
const TERM_BORDER = 'var(--border)';
const TERM_GREEN = 'var(--accent)';
const TERM_GREEN_DIM = 'var(--fg-dim)';
const TERM_GREEN_BRIGHT = 'var(--fg-bright)';
const TERM_AMBER = 'var(--accent-warm)';
const TERM_DANGER = 'var(--danger)';

const titleFromPath = (p) => p.replace(/\.md$/i, '');
const titleToPath = (title) => {
  const safe = String(title || '').split('/')
    .map((seg) => seg.replace(/[<>:"|?*\\]/g, '_').trim())
    .filter(Boolean)
    .join('/');
  return (safe || 'untitled') + '.md';
};
const parseTitle = (title) => {
  const slash = title.lastIndexOf('/');
  if (slash <= 0) return { folder: null, name: title };
  return { folder: title.slice(0, slash), name: title.slice(slash + 1) || 'untitled' };
};

// ---- Tree helpers (work for arbitrarily deep folder structures) ----
const buildTree = (notes) => {
  const root = { type: 'folder', name: '', fullPath: '', children: [] };
  for (const n of notes) {
    const segs = titleFromPath(n.path).split('/').filter((s) => s.length > 0);
    if (segs.length === 0) segs.push('(unnamed)');
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (i === segs.length - 1) {
        cur.children.push({ type: 'note', name: seg, fullPath: n.path, note: n });
      } else {
        const fp = segs.slice(0, i + 1).join('/');
        let f = cur.children.find((c) => c.type === 'folder' && c.fullPath === fp);
        if (!f) { f = { type: 'folder', name: seg, fullPath: fp, children: [] }; cur.children.push(f); }
        cur = f;
      }
    }
  }
  const sortNode = (node) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      if (a.type === 'folder') return a.name.localeCompare(b.name);
      return b.note.mtime - a.note.mtime;
    });
    for (const c of node.children) if (c.type === 'folder') sortNode(c);
  };
  sortNode(root);
  return root;
};

const allFolderPaths = (node, out) => {
  out = out || [];
  for (const c of node.children) {
    if (c.type === 'folder') { out.push(c.fullPath); allFolderPaths(c, out); }
  }
  return out;
};

const countNotes = (node) => {
  let n = 0;
  for (const c of node.children) {
    if (c.type === 'note') n++;
    else n += countNotes(c);
  }
  return n;
};

const fmtAgo = (ts) => {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 4000) return 'just now';
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const HoverBtn = ({ children, color, onClick, title, useState, style }) => {
  const [hover, setHover] = useState(false);
  const c = color || TERM_GREEN_DIM;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? 'rgba(var(--accent-rgb),0.08)' : 'transparent',
        border: '1px solid ' + (hover ? c : 'transparent'),
        color: hover ? (color || TERM_GREEN_BRIGHT) : c,
        cursor: 'pointer',
        padding: '3px 8px',
        fontSize: 12,
        fontFamily: 'var(--mono)',
        borderRadius: 3,
        lineHeight: 1,
        transition: 'all 0.12s ease',
        textShadow: hover ? '0 0 4px ' + c : 'none',
        ...(style || {}),
      }}
    >{children}</button>
  );
};

const INDENT_PX = 14;

const TreeIndent = ({ depth }) => {
  const out = [];
  for (let i = 0; i < depth; i++) {
    out.push(
      <span key={i} style={{
        display: 'inline-block',
        width: INDENT_PX,
        textAlign: 'center',
        color: TERM_GREEN_DIM,
        opacity: 0.25,
        userSelect: 'none',
      }}>│</span>
    );
  }
  return <>{out}</>;
};

const NoteRow = ({ note, name, depth, confirming, onOpen, onDelete, useState }) => {
  const [hover, setHover] = useState(false);
  const showButton = hover || confirming;
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        cursor: 'pointer',
        background: confirming
          ? 'rgba(255,107,107,0.08)'
          : (hover ? 'rgba(var(--accent-rgb),0.08)' : 'transparent'),
        borderRadius: 3,
        fontSize: 11,
        color: TERM_GREEN_BRIGHT,
        textShadow: '0 0 3px rgba(var(--accent-rgb),0.3)',
        userSelect: 'none',
      }}
    >
      <TreeIndent depth={depth} />
      <span style={{ color: TERM_GREEN_DIM, width: 12, textAlign: 'center' }}>·</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 2 }}>
        {name}
      </span>
      <span style={{ color: TERM_GREEN_DIM, fontSize: 9 }}>
        {fmtAgo(note.mtime)}
      </span>
      {showButton && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title={confirming ? 'click again to confirm' : 'delete note'}
          style={{
            background: confirming ? 'rgba(255,107,107,0.12)' : 'transparent',
            border: '1px solid ' + TERM_DANGER,
            color: TERM_DANGER,
            cursor: 'pointer',
            padding: '0 5px',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            borderRadius: 2,
            lineHeight: 1.2,
          }}
        >{confirming ? '✓?' : '×'}</button>
      )}
    </div>
  );
};

const FolderRow = ({ name, depth, count, collapsed, onToggle, useState }) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        cursor: 'pointer',
        color: TERM_GREEN,
        fontSize: 11,
        fontWeight: 600,
        background: hover ? 'rgba(var(--accent-rgb),0.04)' : 'transparent',
        textShadow: '0 0 4px ' + TERM_GREEN,
        letterSpacing: '0.04em',
        userSelect: 'none',
      }}
    >
      <TreeIndent depth={depth} />
      <span style={{ color: TERM_GREEN, width: 12, textAlign: 'center' }}>{collapsed ? '▸' : '▾'}</span>
      <span style={{ flex: 1, marginLeft: 2 }}>{name}/</span>
      <span style={{ color: TERM_GREEN_DIM, fontSize: 9, fontWeight: 400 }}>{count}</span>
    </div>
  );
};

export default {
  id: 'notes',
  name: 'Scratchpad',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [notes, setNotes] = useState([]); // [{ path, body, mtime }]
    const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
    const [view, setView] = useState('browse');
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState('');
    const [collapsedFolders, setCollapsedFolders] = useState(() => {
      try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []); }
      catch { return new Set(); }
    });
    const [renaming, setRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState('');
    const [savedAt, setSavedAt] = useState(Date.now());
    const [savePending, setSavePending] = useState(false);
    const [blink, setBlink] = useState(true);
    const [, tickAgo] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [notesDir, setNotesDir] = useState('');

    const textareaRef = useRef(null);
    const saveTimer = useRef(null);
    const confirmTimer = useRef(null);
    const notesRef = useRef(notes);
    const activeIdRef = useRef(activeId);
    const pendingBodyRef = useRef(null);

    useEffect(() => { notesRef.current = notes; }, [notes]);
    useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

    useEffect(() => {
      if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
      else localStorage.removeItem(ACTIVE_KEY);
    }, [activeId]);

    useEffect(() => {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedFolders]));
    }, [collapsedFolders]);

    useEffect(() => {
      const id = setInterval(() => setBlink((b) => !b), 600);
      return () => clearInterval(id);
    }, []);

    useEffect(() => {
      const id = setInterval(() => tickAgo((t) => t + 1), 10000);
      return () => clearInterval(id);
    }, []);

    // ----- Initial load + one-time migration from localStorage -----
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          // Migrate v3 localStorage notes to disk on first run
          if (!localStorage.getItem(MIGRATION_KEY)) {
            try {
              const old = JSON.parse(localStorage.getItem('plugin:notes:list:v3'));
              if (Array.isArray(old)) {
                for (const n of old) {
                  if (!n || !n.title) continue;
                  const p = titleToPath(n.title);
                  try { await window.dashboard.notes.write(p, n.body || ''); }
                  catch (e) { console.warn('migrate skipped', n.title, e); }
                }
              }
            } catch (e) { console.warn('migration parse failed', e); }
            localStorage.setItem(MIGRATION_KEY, '1');
          }
          const dir = await window.dashboard.notes.getDir();
          if (cancelled) return;
          setNotesDir(dir);
          const list = await window.dashboard.notes.list();
          if (cancelled) return;
          setNotes(list);
          // Decide initial view
          const wantId = localStorage.getItem(ACTIVE_KEY);
          if (wantId && list.some((n) => n.path === wantId)) setView('edit');
          else setView('browse');
          setLoaded(true);
        } catch (e) {
          if (!cancelled) {
            setError('failed to load notes: ' + (e.message || e));
            setLoaded(true);
          }
        }
      })();
      return () => { cancelled = true; };
    }, []);

    // Clear delete-confirm when navigating
    useEffect(() => {
      setConfirmDelete(null);
      if (confirmTimer.current) {
        clearTimeout(confirmTimer.current);
        confirmTimer.current = null;
      }
    }, [view, activeId]);

    // Stay in sync if any other plugin (e.g., MD Preview) changes the folder
    useEffect(() => {
      const off = window.dashboard.notes.onDirChanged(async (newDir) => {
        setNotesDir(newDir);
        try {
          const list = await window.dashboard.notes.list();
          setNotes(list);
          setActiveId(null);
          setView('browse');
        } catch {}
      });
      return off;
    }, []);

    // Auto-focus textarea on edit view
    useEffect(() => {
      if (view !== 'edit') return;
      const tryFocus = () => {
        const ta = textareaRef.current;
        if (ta && document.activeElement !== ta) ta.focus();
      };
      const t1 = setTimeout(tryFocus, 0);
      const t2 = setTimeout(tryFocus, 100);
      const t3 = setTimeout(tryFocus, 250);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }, [view, activeId]);

    const active = notes.find((n) => n.path === activeId);

    // ---- writes ----
    const flushSave = async () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const pending = pendingBodyRef.current;
      pendingBodyRef.current = null;
      if (!pending) return;
      try {
        await window.dashboard.notes.write(pending.path, pending.body);
        setSavedAt(Date.now());
      } catch (e) {
        setError('save failed: ' + (e.message || e));
      } finally {
        setSavePending(false);
      }
    };

    const updateBody = (body) => {
      const id = activeIdRef.current;
      if (!id) return;
      // Optimistically update memory so the textarea shows the new text immediately
      setNotes((prev) => prev.map((n) =>
        n.path === id ? { ...n, body, mtime: Date.now() } : n
      ));
      pendingBodyRef.current = { path: id, body };
      setSavePending(true);
      setError(null);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const pending = pendingBodyRef.current;
        pendingBodyRef.current = null;
        saveTimer.current = null;
        if (!pending) { setSavePending(false); return; }
        try {
          await window.dashboard.notes.write(pending.path, pending.body);
          setSavedAt(Date.now());
        } catch (e) {
          setError('save failed: ' + (e.message || e));
        } finally {
          setSavePending(false);
        }
      }, 500);
    };

    const startRename = () => {
      if (!active) return;
      setRenameDraft(titleFromPath(active.path));
      setRenaming(true);
    };

    const commitRename = async () => {
      if (!active) { setRenaming(false); return; }
      const newPath = titleToPath(renameDraft);
      if (newPath === active.path) {
        setRenaming(false);
        return;
      }
      // Conflict check
      if (notes.some((n) => n.path !== active.path && n.path.toLowerCase() === newPath.toLowerCase())) {
        setError('a note named "' + titleFromPath(newPath) + '" already exists');
        setTimeout(() => setError(null), 4000);
        return;
      }
      // Flush any pending body save FIRST so the rename moves the latest content
      await flushSave();
      try {
        await window.dashboard.notes.rename(active.path, newPath);
        setNotes((prev) => prev.map((n) =>
          n.path === active.path ? { ...n, path: newPath, mtime: Date.now() } : n
        ));
        setActiveId(newPath);
        setSavedAt(Date.now());
        setRenaming(false);
      } catch (e) {
        setError('rename failed: ' + (e.message || e));
        setTimeout(() => setError(null), 4000);
      }
    };

    const createNote = async () => {
      // Find a unique untitled-N name at root
      const existing = new Set(notes.map((n) => n.path.toLowerCase()));
      let n = 1;
      let p;
      do {
        p = (n === 1 ? 'untitled' : 'untitled-' + n) + '.md';
        n++;
      } while (existing.has(p.toLowerCase()));
      try {
        await window.dashboard.notes.write(p, '');
        const newNote = { path: p, body: '', mtime: Date.now() };
        setNotes((prev) => [...prev, newNote]);
        setActiveId(p);
        setView('edit');
        setSavedAt(Date.now());
      } catch (e) {
        setError('create failed: ' + (e.message || e));
        setTimeout(() => setError(null), 4000);
      }
    };

    const openNote = (path) => {
      setActiveId(path);
      setView('edit');
    };

    const closeNote = async () => {
      await flushSave();
      setRenaming(false);
      setView('browse');
    };

    // Two-click delete (no native confirm — that broke window focus)
    const deleteNote = async (id) => {
      if (!notesRef.current.some((n) => n.path === id)) return;
      if (confirmDelete === id) {
        if (confirmTimer.current) {
          clearTimeout(confirmTimer.current);
          confirmTimer.current = null;
        }
        setConfirmDelete(null);
        try {
          await window.dashboard.notes.delete(id);
          setNotes((prev) => prev.filter((n) => n.path !== id));
          if (activeIdRef.current === id) {
            setActiveId(null);
            setView('browse');
          }
          setSavedAt(Date.now());
        } catch (e) {
          setError('delete failed: ' + (e.message || e));
          setTimeout(() => setError(null), 4000);
        }
        return;
      }
      setConfirmDelete(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => {
        setConfirmDelete(null);
        confirmTimer.current = null;
      }, 3000);
    };

    const refresh = async () => {
      try {
        const list = await window.dashboard.notes.list();
        setNotes(list);
        setError(null);
      } catch (e) {
        setError('refresh failed: ' + (e.message || e));
      }
    };

    const changeFolder = async () => {
      const picked = await window.dashboard.dialog.openDirectory({
        title: 'Choose notes folder',
        defaultPath: notesDir,
      });
      if (!picked) return;
      // Flush any pending save against the OLD location before switching
      await flushSave();
      try {
        const newDir = await window.dashboard.notes.setDir(picked);
        setNotesDir(newDir);
        // setDir broadcasts notes:dirChanged, which triggers our reload listener
        // — but reload here too in case the listener races, then return to browse.
        const list = await window.dashboard.notes.list();
        setNotes(list);
        setActiveId(null);
        setView('browse');
        setError(null);
      } catch (e) {
        setError('switch failed: ' + (e.message || e));
        setTimeout(() => setError(null), 4000);
      }
    };

    const onEditorKey = (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const body = ta.value;
        const next = body.substring(0, start) + '  ' + body.substring(end);
        updateBody(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (renaming) setRenaming(false);
        else closeNote();
      }
    };

    const toggleFolder = (folder) => {
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folder)) next.delete(folder);
        else next.add(folder);
        return next;
      });
    };

    const tree = useMemo(() => {
      const q = search.trim().toLowerCase();
      const filtered = q
        ? notes.filter((n) => {
            const t = titleFromPath(n.path).toLowerCase();
            return t.includes(q) || n.body.toLowerCase().includes(q);
          })
        : notes;
      return buildTree(filtered);
    }, [notes, search]);

    const folderPaths = useMemo(() => allFolderPaths(tree), [tree]);
    const anyExpanded = folderPaths.some((p) => !collapsedFolders.has(p));

    // When searching, override collapsed state so matches inside collapsed
    // folders aren't hidden. User's collapse choices persist for after.
    const isFolderCollapsed = (folderPath) => {
      if (search.trim()) return false;
      return collapsedFolders.has(folderPath);
    };

    const closeAllFolders = () => setCollapsedFolders(new Set(folderPaths));
    const openAllFolders = () => setCollapsedFolders(new Set());

    const renderTree = (node, depth) => {
      const out = [];
      for (const child of node.children) {
        if (child.type === 'folder') {
          const collapsed = isFolderCollapsed(child.fullPath);
          out.push(
            <FolderRow
              key={'f:' + child.fullPath}
              useState={useState}
              name={child.name}
              depth={depth}
              count={countNotes(child)}
              collapsed={collapsed}
              onToggle={() => toggleFolder(child.fullPath)}
            />
          );
          if (!collapsed) {
            for (const el of renderTree(child, depth + 1)) out.push(el);
          }
        } else {
          out.push(
            <NoteRow
              key={'n:' + child.fullPath}
              useState={useState}
              note={child.note}
              name={child.name}
              depth={depth}
              confirming={confirmDelete === child.note.path}
              onOpen={() => openNote(child.note.path)}
              onDelete={() => deleteNote(child.note.path)}
            />
          );
        }
      }
      return out;
    };

    const containerStyle = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: TERM_BG,
      border: '1px solid ' + TERM_BORDER,
      borderRadius: 4,
      overflow: 'hidden',
      fontFamily: 'var(--mono)',
      boxShadow: 'inset 0 0 24px rgba(0,0,0,0.55)',
    };

    // ============ BROWSE VIEW ============
    if (view === 'browse') {
      const totalNotes = notes.length;
      const matched = countNotes(tree);

      return (
        <div style={containerStyle}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 8px',
            borderBottom: '1px solid ' + TERM_BORDER,
            background: 'rgba(0,0,0,0.35)',
            fontSize: 11,
            color: TERM_GREEN,
          }}>
            <span style={{ color: TERM_GREEN_DIM }}>$ ls</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search title or body..."
              style={{
                flex: 1,
                background: 'transparent',
                border: '1px solid ' + TERM_BORDER,
                color: TERM_GREEN_BRIGHT,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                padding: '3px 7px',
                outline: 'none',
                borderRadius: 3,
                minWidth: 0,
              }}
            />
            <HoverBtn useState={useState} onClick={createNote} title="new note (rename to folder/name to organize)">+ new</HoverBtn>
            {folderPaths.length > 0 && (
              <HoverBtn
                useState={useState}
                onClick={anyExpanded ? closeAllFolders : openAllFolders}
                title={anyExpanded ? 'collapse all folders' : 'expand all folders'}
              >{anyExpanded ? '▸▸' : '▾▾'}</HoverBtn>
            )}
            <HoverBtn useState={useState} onClick={refresh} title="reload from disk">↻</HoverBtn>
            <HoverBtn useState={useState} onClick={changeFolder} title="change notes folder...">cd</HoverBtn>
            <HoverBtn useState={useState} onClick={() => window.dashboard.notes.openFolder()} title="open notes folder in Explorer">⌘</HoverBtn>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
            {!loaded && (
              <div style={{ padding: 24, color: TERM_GREEN_DIM, fontSize: 11, textAlign: 'center' }}>
                ▸ loading notes from disk...
              </div>
            )}
            {loaded && totalNotes === 0 && (
              <div style={{
                padding: 24,
                textAlign: 'center',
                color: TERM_GREEN_DIM,
                fontSize: 11,
                lineHeight: 1.6,
              }}>
                ▸ no notes yet
                <br />
                <span style={{ fontSize: 10, opacity: 0.7 }}>
                  click <span style={{ color: TERM_GREEN }}>+ new</span> to create one
                </span>
              </div>
            )}
            {loaded && totalNotes > 0 && matched === 0 && (
              <div style={{ padding: 12, color: TERM_GREEN_DIM, fontSize: 11, textAlign: 'center' }}>
                no matches for "{search}"
              </div>
            )}
            {renderTree(tree, 0)}
          </div>

          {error && (
            <div style={{
              padding: '4px 10px',
              borderTop: '1px solid ' + TERM_DANGER,
              background: 'rgba(255,107,107,0.08)',
              color: TERM_DANGER,
              fontSize: 10,
            }}>! {error}</div>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 10px',
            borderTop: '1px solid ' + TERM_BORDER,
            background: 'rgba(0,0,0,0.35)',
            fontSize: 10,
            color: TERM_GREEN_DIM,
            letterSpacing: '0.06em',
          }}>
            <span>{totalNotes} note{totalNotes === 1 ? '' : 's'}</span>
            <span style={{ flex: 1 }} />
            <span style={{ opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={notesDir}>
              {notesDir || '...'}
            </span>
          </div>
        </div>
      );
    }

    // ============ EDIT VIEW ============
    if (!active) {
      return (
        <div style={containerStyle}>
          <div style={{ padding: 24, color: TERM_GREEN_DIM, textAlign: 'center', fontSize: 11 }}>
            ▸ note not found
            <br />
            <HoverBtn useState={useState} onClick={closeNote} style={{ marginTop: 8 }}>← back to list</HoverBtn>
          </div>
        </div>
      );
    }

    const lineCount = (active.body.match(/\n/g) || []).length + 1;
    const charCount = active.body.length;
    const status = savePending ? 'saving...' : 'saved ' + fmtAgo(savedAt);
    const displayTitle = titleFromPath(active.path);

    return (
      <div style={containerStyle}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 8px',
          borderBottom: '1px solid ' + TERM_BORDER,
          background: 'rgba(0,0,0,0.35)',
          fontSize: 11,
          color: TERM_GREEN,
        }}>
          <HoverBtn useState={useState} onClick={closeNote} title="back to list (esc)">←</HoverBtn>
          {renaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              style={{
                flex: 1,
                background: 'transparent',
                border: '1px solid ' + TERM_GREEN,
                color: TERM_GREEN_BRIGHT,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                padding: '2px 6px',
                outline: 'none',
                minWidth: 60,
                boxShadow: '0 0 6px rgba(var(--accent-rgb),0.4)',
                borderRadius: 3,
              }}
            />
          ) : (
            <span
              onClick={startRename}
              title="click to rename · use folder/name to organize"
              style={{
                flex: 1,
                color: TERM_GREEN_BRIGHT,
                fontSize: 11,
                padding: '2px 6px',
                cursor: 'text',
                textShadow: '0 0 4px rgba(var(--accent-rgb),0.5)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >{displayTitle}</span>
          )}
          <HoverBtn
            useState={useState}
            onClick={renaming ? commitRename : startRename}
            title={renaming ? 'save name (enter)' : 'rename'}
          >{renaming ? '✓' : '✎'}</HoverBtn>
          <HoverBtn
            useState={useState}
            color={TERM_DANGER}
            onClick={() => deleteNote(active.path)}
            title={confirmDelete === active.path ? 'click again to confirm' : 'delete this note'}
          >{confirmDelete === active.path ? '✓?' : '×'}</HoverBtn>
        </div>

        <textarea
          key={active.path}
          ref={textareaRef}
          autoFocus
          value={active.body}
          onChange={(e) => updateBody(e.target.value)}
          onKeyDown={onEditorKey}
          spellCheck={false}
          placeholder="▸ start typing..."
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            color: TERM_GREEN_BRIGHT,
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            lineHeight: 1.55,
            padding: '12px 14px',
            textShadow: '0 0 5px rgba(var(--accent-rgb), 0.5)',
            caretColor: TERM_GREEN,
            letterSpacing: '0.02em',
          }}
        />

        {error && (
          <div style={{
            padding: '4px 10px',
            borderTop: '1px solid ' + TERM_DANGER,
            background: 'rgba(255,107,107,0.08)',
            color: TERM_DANGER,
            fontSize: 10,
          }}>! {error}</div>
        )}

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderTop: '1px solid ' + TERM_BORDER,
          background: 'rgba(0,0,0,0.35)',
          fontSize: 10,
          color: TERM_GREEN_DIM,
          letterSpacing: '0.06em',
        }}>
          <span>L{lineCount}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{charCount}c</span>
          <span style={{ flex: 1 }} />
          <span style={{
            color: savePending ? TERM_AMBER : TERM_GREEN_DIM,
            fontStyle: savePending ? 'italic' : 'normal',
          }}>{status}</span>
          <span style={{
            color: TERM_GREEN,
            opacity: blink ? 1 : 0.15,
            transition: 'opacity 0.08s',
            textShadow: '0 0 5px ' + TERM_GREEN,
            fontSize: 12,
            marginLeft: 4,
          }}>▮</span>
        </div>
      </div>
    );
  },
};
