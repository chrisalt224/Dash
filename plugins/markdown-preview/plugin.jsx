// Markdown Preview — read-only viewer for the same .md files the scratchpad
// writes. Browse the notes folder, click any note to render it in styled
// terminal markdown. Click ← to return to the list. Click ⌖ to open the
// raw file in your system's default editor (Notepad, VS Code, etc.).

const ACTIVE_KEY = 'plugin:markdown-preview:active:v1';
const COLLAPSED_KEY = 'plugin:markdown-preview:collapsed:v1';

const TERM_BG = 'var(--bg)';
const TERM_BORDER = 'var(--border)';
const TERM_GREEN = 'var(--accent)';
const TERM_GREEN_DIM = 'var(--fg-dim)';
const TERM_GREEN_BRIGHT = 'var(--fg-bright)';
const TERM_AMBER = 'var(--accent-warm)';
const TERM_DANGER = 'var(--danger)';

const titleFromPath = (p) => p.replace(/\.md$/i, '');
const parseTitle = (title) => {
  const slash = title.lastIndexOf('/');
  if (slash <= 0) return { folder: null, name: title };
  return { folder: title.slice(0, slash), name: title.slice(slash + 1) || 'untitled' };
};

// ---- Tree helpers (shared shape with the scratchpad) ----
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

// ---- Inline markdown → HTML ----
const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Unique sentinels for stashing inline-code contents before other regex runs.
// Control chars won't ever appear in normal user text.
const SENT_OPEN = '\x00\x01';
const SENT_CLOSE = '\x01\x00';
const SENT_RESTORE = new RegExp(SENT_OPEN + '(\\d+)' + SENT_CLOSE, 'g');

const renderInline = (text) => {
  let s = escapeHtml(text);
  // Inline code first (so we don't process markdown inside code)
  // Use placeholders so subsequent regex doesn't touch the contents
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return SENT_OPEN + (codes.length - 1) + SENT_CLOSE;
  });
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  // Auto-link bare URLs
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2">$2</a>');
  // Bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  // Strikethrough
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // Restore inline code placeholders
  s = s.replace(SENT_RESTORE, (_, i) => '<code>' + escapeHtml(codes[Number(i)]) + '</code>');
  return s;
};

const mdToHtml = (text) => {
  const lines = (text || '').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const code = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        code.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        '<pre data-lang="' + escapeHtml(lang) + '"><code>' +
        escapeHtml(code.join('\n')) + '</code></pre>'
      );
      continue;
    }

    // Heading (atx)
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      out.push('<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^\s*([-*_])\s*\1\s*\1[\s\1]*$/)) {
      out.push('<hr/>');
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderInline(quote.join(' ')) + '</blockquote>');
      continue;
    }

    // Unordered list (with simple [ ] / [x] task list support)
    if (line.match(/^\s*[-*+]\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\s*[-*+]\s+/)) {
        let item = lines[i].replace(/^\s*[-*+]\s+/, '');
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          items.push(
            '<li class="task ' + (checked ? 'done' : '') + '">' +
            (checked ? '☑' : '☐') + ' ' + renderInline(task[2]) + '</li>'
          );
        } else {
          items.push('<li>' + renderInline(item) + '</li>');
        }
        i++;
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    // Ordered list
    if (line.match(/^\s*\d+\.\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\s*\d+\.\s+/)) {
        items.push('<li>' + renderInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
        i++;
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    // Empty line
    if (line.trim() === '') { i++; continue; }

    // Paragraph: collect until blank or another block element starts
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^(#{1,6}\s|>|```|\s*[-*+]\s|\s*\d+\.\s)/) &&
      !lines[i].match(/^\s*([-*_])\s*\1\s*\1/)
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length > 0) {
      out.push('<p>' + renderInline(para.join(' ')) + '</p>');
    }
  }

  return out.join('\n');
};

// ---- Stylesheet for the rendered HTML, scoped under .md-preview ----
const PREVIEW_CSS = `
.md-preview { color: ${TERM_GREEN_BRIGHT}; line-height: 1.55; font-size: 12.5px; }
.md-preview > *:first-child { margin-top: 0; }
.md-preview > *:last-child { margin-bottom: 0; }
.md-preview p { margin: 0 0 10px; text-shadow: 0 0 4px rgba(var(--accent-rgb),0.25); }
.md-preview h1, .md-preview h2, .md-preview h3,
.md-preview h4, .md-preview h5, .md-preview h6 {
  color: ${TERM_GREEN};
  text-shadow: 0 0 6px ${TERM_GREEN};
  margin: 16px 0 8px;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.md-preview h1 { font-size: 18px; border-bottom: 1px dashed ${TERM_BORDER}; padding-bottom: 4px; }
.md-preview h2 { font-size: 16px; }
.md-preview h3 { font-size: 14px; }
.md-preview h4 { font-size: 13px; color: ${TERM_GREEN_BRIGHT}; }
.md-preview h5, .md-preview h6 { font-size: 12px; color: ${TERM_GREEN_DIM}; text-transform: uppercase; letter-spacing: 0.1em; }
.md-preview strong { color: ${TERM_GREEN}; text-shadow: 0 0 4px ${TERM_GREEN}; font-weight: 700; }
.md-preview em { color: ${TERM_GREEN_BRIGHT}; font-style: italic; opacity: 0.9; }
.md-preview del { color: ${TERM_GREEN_DIM}; text-decoration: line-through; opacity: 0.6; }
.md-preview a {
  color: ${TERM_AMBER};
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-style: dotted;
  cursor: pointer;
  text-shadow: 0 0 4px rgba(255,180,84,0.4);
}
.md-preview a:hover { color: #ffd089; text-shadow: 0 0 6px ${TERM_AMBER}; }
.md-preview code {
  background: rgba(255,180,84,0.1);
  border: 1px solid rgba(255,180,84,0.25);
  color: ${TERM_AMBER};
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11.5px;
  font-family: var(--mono);
}
.md-preview pre {
  background: rgba(0,0,0,0.45);
  border: 1px solid ${TERM_BORDER};
  border-left: 2px solid ${TERM_GREEN};
  border-radius: 4px;
  padding: 10px 12px;
  margin: 0 0 12px;
  overflow-x: auto;
  font-size: 11.5px;
  position: relative;
}
.md-preview pre code {
  background: none;
  border: none;
  color: ${TERM_GREEN_BRIGHT};
  padding: 0;
  font-size: inherit;
  text-shadow: 0 0 3px rgba(var(--accent-rgb),0.2);
}
.md-preview pre[data-lang]:not([data-lang=""])::before {
  content: attr(data-lang);
  position: absolute;
  top: 4px;
  right: 8px;
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${TERM_GREEN_DIM};
  font-family: var(--mono);
}
.md-preview blockquote {
  margin: 0 0 10px;
  padding: 4px 12px;
  border-left: 3px solid ${TERM_GREEN_DIM};
  color: ${TERM_GREEN_DIM};
  font-style: italic;
  background: rgba(var(--accent-rgb),0.03);
}
.md-preview ul, .md-preview ol { margin: 0 0 10px; padding-left: 22px; }
.md-preview li { margin: 2px 0; }
.md-preview ul { list-style: none; padding-left: 0; }
.md-preview ul > li::before {
  content: "▸ ";
  color: ${TERM_GREEN};
  text-shadow: 0 0 4px ${TERM_GREEN};
}
.md-preview ul > li.task::before { content: ""; }
.md-preview li.task.done { color: ${TERM_GREEN_DIM}; text-decoration: line-through; opacity: 0.7; }
.md-preview ol { color: ${TERM_GREEN_BRIGHT}; }
.md-preview ol li::marker { color: ${TERM_GREEN}; font-weight: 600; }
.md-preview hr {
  border: none;
  border-top: 1px dashed ${TERM_BORDER};
  margin: 16px 0;
}
`;

// ---- UI helpers ----
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

const NoteRow = ({ note, name, depth, onOpen, useState }) => {
  const [hover, setHover] = useState(false);
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
        background: hover ? 'rgba(var(--accent-rgb),0.08)' : 'transparent',
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
  id: 'markdown-preview',
  name: 'MD Preview',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [notes, setNotes] = useState([]);
    const [activePath, setActivePath] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
    const [view, setView] = useState('browse');
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState('');
    const [collapsedFolders, setCollapsedFolders] = useState(() => {
      try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []); }
      catch { return new Set(); }
    });
    const [notesDir, setNotesDir] = useState('');
    const previewRef = useRef(null);

    useEffect(() => {
      if (activePath) localStorage.setItem(ACTIVE_KEY, activePath);
      else localStorage.removeItem(ACTIVE_KEY);
    }, [activePath]);

    useEffect(() => {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedFolders]));
    }, [collapsedFolders]);

    // Load notes from disk
    const refresh = async () => {
      try {
        const list = await window.dashboard.notes.list();
        setNotes(list);
        setError(null);
      } catch (e) {
        setError('failed to load: ' + (e.message || e));
      }
    };

    const changeFolder = async () => {
      const picked = await window.dashboard.dialog.openDirectory({
        title: 'Choose notes folder',
        defaultPath: notesDir,
      });
      if (!picked) return;
      try {
        const newDir = await window.dashboard.notes.setDir(picked);
        setNotesDir(newDir);
        const list = await window.dashboard.notes.list();
        setNotes(list);
        setActivePath(null);
        setView('browse');
        setError(null);
      } catch (e) {
        setError('switch failed: ' + (e.message || e));
        setTimeout(() => setError(null), 4000);
      }
    };

    // React to dir changes from anywhere (e.g., the scratchpad changed it)
    useEffect(() => {
      const off = window.dashboard.notes.onDirChanged(async (newDir) => {
        setNotesDir(newDir);
        try {
          const list = await window.dashboard.notes.list();
          setNotes(list);
          setActivePath(null);
          setView('browse');
        } catch {}
      });
      return off;
    }, []);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const dir = await window.dashboard.notes.getDir();
          if (cancelled) return;
          setNotesDir(dir);
          const list = await window.dashboard.notes.list();
          if (cancelled) return;
          setNotes(list);
          // Decide initial view
          const wantPath = localStorage.getItem(ACTIVE_KEY);
          if (wantPath && list.some((n) => n.path === wantPath)) setView('preview');
          setLoaded(true);
        } catch (e) {
          if (!cancelled) {
            setError('failed to load: ' + (e.message || e));
            setLoaded(true);
          }
        }
      })();
      return () => { cancelled = true; };
    }, []);

    // Scroll preview to top when switching notes
    useEffect(() => {
      if (view === 'preview' && previewRef.current) {
        previewRef.current.scrollTop = 0;
      }
    }, [activePath, view]);

    const active = notes.find((n) => n.path === activePath);

    const openNote = (path) => {
      setActivePath(path);
      setView('preview');
    };

    const closePreview = () => setView('browse');

    const openInEditor = () => {
      if (!active || !notesDir) return;
      const sep = notesDir.includes('\\') ? '\\' : '/';
      const fullPath = notesDir + sep + active.path.replace(/\//g, sep);
      window.dashboard.shell.open(fullPath);
    };

    const toggleFolder = (folder) => {
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folder)) next.delete(folder);
        else next.add(folder);
        return next;
      });
    };

    // Intercept link clicks → open in default browser
    const onPreviewClick = (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (a && a.getAttribute('href')) {
        e.preventDefault();
        const href = a.getAttribute('href');
        if (/^https?:\/\//i.test(href)) window.dashboard.shell.openExternal(href);
        else window.dashboard.shell.open(href);
      }
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
              onOpen={() => openNote(child.note.path)}
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
      position: 'relative',
    };

    // ============ BROWSE VIEW ============
    if (view === 'browse') {
      const totalNotes = notes.length;
      const matched = countNotes(tree);

      return (
        <div style={containerStyle}>
          <style>{PREVIEW_CSS}</style>
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
            <span style={{ color: TERM_GREEN_DIM }}>$ cat</span>
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
            {folderPaths.length > 0 && (
              <HoverBtn
                useState={useState}
                onClick={anyExpanded ? closeAllFolders : openAllFolders}
                title={anyExpanded ? 'collapse all folders' : 'expand all folders'}
              >{anyExpanded ? '▸▸' : '▾▾'}</HoverBtn>
            )}
            <HoverBtn useState={useState} onClick={refresh} title="reload from disk">↻</HoverBtn>
            <HoverBtn useState={useState} onClick={changeFolder} title="change notes folder...">cd</HoverBtn>
            <HoverBtn useState={useState} onClick={() => window.dashboard.notes.openFolder()} title="open notes folder">⌘</HoverBtn>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
            {!loaded && (
              <div style={{ padding: 24, color: TERM_GREEN_DIM, fontSize: 11, textAlign: 'center' }}>
                ▸ loading notes...
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
                  create some in the <span style={{ color: TERM_GREEN }}>scratchpad</span> first
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

    // ============ PREVIEW VIEW ============
    if (!active) {
      return (
        <div style={containerStyle}>
          <style>{PREVIEW_CSS}</style>
          <div style={{ padding: 24, color: TERM_GREEN_DIM, textAlign: 'center', fontSize: 11 }}>
            ▸ note not found
            <br />
            <HoverBtn useState={useState} onClick={closePreview} style={{ marginTop: 8 }}>← back to list</HoverBtn>
          </div>
        </div>
      );
    }

    const html = mdToHtml(active.body);
    const displayTitle = titleFromPath(active.path);
    const charCount = active.body.length;
    const lineCount = (active.body.match(/\n/g) || []).length + 1;

    return (
      <div style={containerStyle}>
        <style>{PREVIEW_CSS}</style>

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
          <HoverBtn useState={useState} onClick={closePreview} title="back to list">←</HoverBtn>
          <span style={{
            flex: 1,
            color: TERM_GREEN_BRIGHT,
            fontSize: 11,
            padding: '2px 6px',
            textShadow: '0 0 4px rgba(var(--accent-rgb),0.5)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{displayTitle}</span>
          <HoverBtn useState={useState} onClick={openInEditor} title="open file in default editor">⌖</HoverBtn>
        </div>

        <div
          ref={previewRef}
          className="md-preview"
          onClick={onPreviewClick}
          dangerouslySetInnerHTML={{ __html: html }}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '14px 16px',
            background: TERM_BG,
          }}
        />

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
          <span style={{ opacity: 0.6 }}>updated {fmtAgo(active.mtime)}</span>
        </div>
      </div>
    );
  },
};
