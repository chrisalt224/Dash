// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

export default {
  id: 'cognicore',
  name: 'Cognicore',
  width: 4,
  height: 4,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    // ── Storage keys ───────────────────────────────────────────────────────
    // Cognicore content lives in the central 'cognicore' vault — shared
    // across devices when sync is connected. Per-device UI state (last
    // opened note, expanded folders, sidebar tab) is in the deny-list and
    // does NOT sync — each device keeps its own.
    const LAST_KEY     = 'plugin:cognicore:last:v2';
    const STARRED_KEY  = 'plugin:cognicore:starred:v2';
    const EXPANDED_KEY = 'plugin:cognicore:expanded:v2';
    const SIDEBAR_KEY  = 'plugin:cognicore:rightTab:v2';
    const VAULT_NAME   = 'cognicore';

    // ── State ──────────────────────────────────────────────────────────────
    const [vaultPath, setVaultPath]         = useState('');  // display only
    const [notes, setNotes]                 = useState([]);   // [{ relPath, name, folder, mtime, content }]
    const [currentPath, setCurrentPath]     = useState(null); // relPath
    const [editorContent, setEditorContent] = useState('');
    const [dirty, setDirty]                 = useState(false);
    const [savedAt, setSavedAt]             = useState(0);
    const [isPreview, setIsPreview]         = useState(false);
    const [searchTerm, setSearchTerm]       = useState('');
    const [searchOpen, setSearchOpen]       = useState(false);
    const [showQuickSwitch, setShowQuickSwitch] = useState(false);
    const [quickQuery, setQuickQuery]       = useState('');
    const [showGraphFull, setShowGraphFull] = useState(false);
    const [rightTab, setRightTab]           = useState('backlinks'); // backlinks|tags|outline|graph
    const [expanded, setExpanded]           = useState({}); // { 'Daily': true }
    const [starred, setStarred]             = useState([]); // [relPath]
    const [renameTarget, setRenameTarget]   = useState(null); // { type:'note'|'folder', path }
    const [renameValue, setRenameValue]     = useState('');
    const [confirmDelete, setConfirmDelete] = useState(null); // path
    const [creatingIn, setCreatingIn]       = useState(null); // { kind:'note'|'folder', folder }
    const [createValue, setCreateValue]     = useState('');
    const [errorMsg, setErrorMsg]           = useState('');
    const [activeTag, setActiveTag]         = useState(null);

    // ── Refs ───────────────────────────────────────────────────────────────
    const editorRef       = useRef(null);
    const graphCanvasRef  = useRef(null);
    const miniGraphRef    = useRef(null);
    const errorTimerRef   = useRef(null);
    const saveTimerRef    = useRef(null);
    const rootRef         = useRef(null);
    // Force-directed graph simulation state — survives renders so positions persist
    const simRef          = useRef({
      nodes:   {},                                  // relPath -> { x, y, vx, vy }
      view:    { panX: 0, panY: 0, scale: 1 },
      hoverId: null,
      dragId:  null,
      panning: null,                                // { sx, sy, panX, panY }
      rafId:   null,
      warmed:  false,                               // mini-view: have we settled it once?
      forces:  { rep: 9000, att: 0.05, len: 95, cen: 0.006, damp: 0.82 },
    });
    // Stable refs read inside the animation loop (avoid stale closures)
    const graphDataRef = useRef({});
    const openNoteRef  = useRef(() => {});

    // Refs the vault.onChanged listener reads — that listener is registered
    // ONCE in a useEffect with [] deps, so the closures it captures never see
    // re-rendered values. Without these refs, scanVault would always read the
    // first-render currentPath/dirty/editorContent and clobber active edits
    // any time another device's change echoed back.
    const currentPathRef    = useRef(currentPath);
    const dirtyRef          = useRef(dirty);
    const editorContentRef  = useRef(editorContent);
    const initialMountRef   = useRef(true); // restore LAST_KEY only on first scan
    useEffect(() => { currentPathRef.current   = currentPath;   }, [currentPath]);
    useEffect(() => { dirtyRef.current         = dirty;         }, [dirty]);
    useEffect(() => { editorContentRef.current = editorContent; }, [editorContent]);

    // Our own device id — used to ignore vault:changed echoes of our own
    // writes (the SSE round-trip from host → us was clobbering edits).
    const myDeviceIdRef = useRef(null);
    useEffect(() => {
      if (window.dashboard.sync && window.dashboard.sync.deviceId) {
        window.dashboard.sync.deviceId().then((id) => { myDeviceIdRef.current = id || null; }).catch(() => {});
      }
    }, []);

    // ── Helpers: error banner ──────────────────────────────────────────────
    const showError = (msg) => {
      setErrorMsg(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setErrorMsg(''), 4000);
    };

    // ── Helpers: paths (use forward slashes, Node normalizes on Windows) ──
    const join = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
    const dirOf  = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
    const baseOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? rel : rel.slice(i + 1); };
    const stripExt = (n) => n.replace(/\.md$/i, '');

    // ── Init: load vault info, restore UI state, scan ──────────────────────
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          // The vault is managed by the host — we just need its display path.
          const info = await window.dashboard.vault.info(VAULT_NAME);
          if (cancelled) return;
          setVaultPath(info && info.dir ? info.dir : '(remote vault)');

          try {
            const stars = JSON.parse(localStorage.getItem(STARRED_KEY) || '[]');
            if (Array.isArray(stars)) setStarred(stars);
          } catch (_) {}
          try {
            const exp = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '{}');
            if (exp && typeof exp === 'object') setExpanded(exp);
          } catch (_) {}
          const tab = localStorage.getItem(SIDEBAR_KEY);
          if (tab) setRightTab(tab);

          await scanVault();
        } catch (e) {
          showError('Vault init failed: ' + e.message);
        }
      })();
      return () => { cancelled = true; };
    }, []);

    // Refresh on remote vault changes (another device wrote to cognicore).
    // Skip echoes of our own writes — createNote/etc. already updated state
    // locally; running scanVault again on the echo would race with the user's
    // typing and clobber the editor.
    useEffect(() => {
      const off = window.dashboard.vault.onChanged((info) => {
        if (!info || info.name !== VAULT_NAME) return;
        if (info.device && myDeviceIdRef.current && info.device === myDeviceIdRef.current) return;
        scanVault();
      });
      return () => off && off();
    }, []);

    // ── Persist UI state ───────────────────────────────────────────────────
    useEffect(() => { localStorage.setItem(STARRED_KEY,  JSON.stringify(starred));  }, [starred]);
    useEffect(() => { localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded)); }, [expanded]);
    useEffect(() => { localStorage.setItem(SIDEBAR_KEY,  rightTab);                 }, [rightTab]);

    // ── Vault scan: pull all .md notes (with bodies) from the central vault ──
    // On the FIRST scan after mount we restore the last-opened note from
    // LAST_KEY. On subsequent scans (triggered by remote vault-changed events
    // from other devices) we never auto-switch — that would yank the user out
    // of whatever they're currently editing. We also refuse to overwrite the
    // editor body when the user has unsaved local edits (`dirty === true`).
    const scanVault = async () => {
      try {
        const items = await window.dashboard.vault.listNotes(VAULT_NAME);
        const found = [];
        for (const it of items || []) {
          if (!/\.md$/i.test(it.path)) continue;
          const rel = it.path;
          const folder = dirOf(rel);
          const fileName = baseOf(rel);
          found.push({
            relPath: rel,
            name:    stripExt(fileName),
            folder,
            mtime:   it.mtime || 0,
            content: it.body || '',
          });
        }
        setNotes(found);

        const curPath = currentPathRef.current;
        const isFirst = initialMountRef.current;
        initialMountRef.current = false;

        if (isFirst) {
          // Cold start — restore last-opened note if it still exists.
          const last = localStorage.getItem(LAST_KEY);
          if (last && found.some(n => n.relPath === last)) {
            const f = found.find(n => n.relPath === last);
            setCurrentPath(last);
            setEditorContent(f.content || '');
            setDirty(false);
          }
          return;
        }

        // Subsequent scan (remote change): if the active note was deleted
        // remotely, drop it. Otherwise refresh its body ONLY when the user
        // has no unsaved edits — never clobber typing in progress.
        if (curPath) {
          const stillExists = found.find(n => n.relPath === curPath);
          if (!stillExists) {
            setCurrentPath(null);
            setEditorContent('');
            setDirty(false);
          } else if (!dirtyRef.current && stillExists.content !== editorContentRef.current) {
            setEditorContent(stillExists.content || '');
          }
        }
      } catch (e) {
        showError('Scan failed: ' + e.message);
      }
    };

    // ── Open note ──────────────────────────────────────────────────────────
    const openNote = (relPath) => {
      const note = notes.find(n => n.relPath === relPath);
      if (!note) { showError('Note not found'); return; }
      // Flush any pending save for previous note before switching
      if (dirty && currentPath) flushSave(currentPath, editorContent);
      setCurrentPath(relPath);
      setEditorContent(note.content || '');
      setDirty(false);
      setIsPreview(false);
      localStorage.setItem(LAST_KEY, relPath);
    };

    // ── Save current note (debounced) ──────────────────────────────────────
    const flushSave = async (rel, content) => {
      try {
        await window.dashboard.vault.write(VAULT_NAME, rel, content);
        setNotes(prev => prev.map(n => n.relPath === rel
          ? { ...n, content, mtime: Date.now() } : n));
        setSavedAt(Date.now());
        setDirty(false);
      } catch (e) {
        showError('Save failed: ' + e.message);
      }
    };

    useEffect(() => {
      if (!currentPath) return;
      if (!dirty) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        flushSave(currentPath, editorContent);
      }, 700);
      return () => clearTimeout(saveTimerRef.current);
    }, [editorContent, dirty, currentPath]);

    // Manual Ctrl+S save
    useEffect(() => {
      const onKey = (e) => {
        if (!rootRef.current || !rootRef.current.contains(document.activeElement)) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (currentPath && dirty) flushSave(currentPath, editorContent);
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          setShowQuickSwitch(true);
          setQuickQuery('');
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
          e.preventDefault();
          setIsPreview(p => !p);
        }
        if (e.key === 'Escape') {
          if (showQuickSwitch) setShowQuickSwitch(false);
          if (creatingIn)      setCreatingIn(null);
          if (renameTarget)    setRenameTarget(null);
          if (showGraphFull)   setShowGraphFull(false);
          if (searchOpen)      setSearchOpen(false);
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [currentPath, editorContent, dirty, showQuickSwitch, creatingIn, renameTarget, showGraphFull, searchOpen]);

    // Flush on unmount
    useEffect(() => {
      return () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      };
    }, []);

    // ── Folder operations ──────────────────────────────────────────────────
    const allFolders = useMemo(() => {
      const set = new Set(['']);
      for (const n of notes) {
        const parts = n.folder ? n.folder.split('/') : [];
        let acc = '';
        for (const part of parts) {
          acc = acc ? `${acc}/${part}` : part;
          set.add(acc);
        }
      }
      return Array.from(set).sort();
    }, [notes]);

    const createNote = async (folderRel, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const fileName = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
      const rel = folderRel ? `${folderRel}/${fileName}` : fileName;
      if (notes.some(n => n.relPath === rel)) { showError('Note already exists'); return; }
      try {
        await window.dashboard.vault.write(VAULT_NAME, rel, `# ${stripExt(fileName)}\n\n`);
        await scanVault();
        setCurrentPath(rel);
        setEditorContent(`# ${stripExt(fileName)}\n\n`);
        setDirty(false);
        setIsPreview(false);
        localStorage.setItem(LAST_KEY, rel);
      } catch (e) {
        showError('Create note failed: ' + e.message);
      }
    };

    const createFolder = async (parentRel, name) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed.includes('/')) { showError('Invalid folder name'); return; }
      const rel = parentRel ? `${parentRel}/${trimmed}` : trimmed;
      try {
        await window.dashboard.vault.mkdir(VAULT_NAME, rel);
        setExpanded(prev => ({ ...prev, [rel]: true }));
        await scanVault();
      } catch (e) {
        showError('Create folder failed: ' + e.message);
      }
    };

    const deleteEntry = async (path, isFolder) => {
      try {
        await window.dashboard.vault.delete(VAULT_NAME, path);
        if (!isFolder && currentPath === path) {
          setCurrentPath(null);
          setEditorContent('');
          setDirty(false);
        }
        if (isFolder && currentPath && currentPath.startsWith(path + '/')) {
          setCurrentPath(null);
          setEditorContent('');
          setDirty(false);
        }
        setStarred(prev => prev.filter(s => s !== path && !s.startsWith(path + '/')));
        setConfirmDelete(null);
        await scanVault();
      } catch (e) {
        showError('Delete failed: ' + e.message);
      }
    };

    const renameEntry = async (oldRel, newName, isFolder) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed.includes('/')) { showError('Invalid name'); return; }
      const parent = dirOf(oldRel);
      const finalName = isFolder
        ? trimmed
        : (/\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`);
      const newRel = parent ? `${parent}/${finalName}` : finalName;
      if (newRel === oldRel) { setRenameTarget(null); return; }
      try {
        await window.dashboard.vault.rename(VAULT_NAME, oldRel, newRel);
        if (currentPath === oldRel) {
          setCurrentPath(newRel);
          localStorage.setItem(LAST_KEY, newRel);
        } else if (isFolder && currentPath && currentPath.startsWith(oldRel + '/')) {
          const sub = currentPath.slice(oldRel.length);
          setCurrentPath(newRel + sub);
          localStorage.setItem(LAST_KEY, newRel + sub);
        }
        setStarred(prev => prev.map(s =>
          s === oldRel ? newRel : (s.startsWith(oldRel + '/') ? newRel + s.slice(oldRel.length) : s)));
        setRenameTarget(null);
        await scanVault();
      } catch (e) {
        showError('Rename failed: ' + e.message);
      }
    };

    const moveNote = async (noteRel, destFolder) => {
      const fileName = baseOf(noteRel);
      const newRel = destFolder ? `${destFolder}/${fileName}` : fileName;
      if (newRel === noteRel) return;
      if (notes.some(n => n.relPath === newRel)) { showError('Target already exists'); return; }
      try {
        await window.dashboard.vault.rename(VAULT_NAME, noteRel, newRel);
        if (currentPath === noteRel) {
          setCurrentPath(newRel);
          localStorage.setItem(LAST_KEY, newRel);
        }
        setStarred(prev => prev.map(s => s === noteRel ? newRel : s));
        await scanVault();
      } catch (e) {
        showError('Move failed: ' + e.message);
      }
    };

    // ── Star / Daily ───────────────────────────────────────────────────────
    const toggleStar = (rel) => {
      setStarred(prev => prev.includes(rel)
        ? prev.filter(s => s !== rel)
        : [...prev, rel]);
    };

    const openDailyNote = async () => {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const rel = `Daily/${today}.md`;
      const exists = notes.find(n => n.relPath === rel);
      if (exists) { openNote(rel); return; }
      try {
        const stamp = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        await window.dashboard.vault.write(VAULT_NAME, rel, `# ${today}\n\n*${stamp}*\n\n`);
        await scanVault();
        setCurrentPath(rel);
        setEditorContent(`# ${today}\n\n*${stamp}*\n\n`);
        setDirty(false);
        localStorage.setItem(LAST_KEY, rel);
        setExpanded(prev => ({ ...prev, Daily: true }));
      } catch (e) {
        showError('Daily note failed: ' + e.message);
      }
    };

    // Vault is host-managed — no user picker. Reveal only works on the host
    // (the device that actually has the files).
    const pickVault = () => {
      showError('Vault is managed by the dashboard host. Files live in: ' + vaultPath);
    };

    const revealInExplorer = () => {
      if (!vaultPath || vaultPath === '(remote vault)') {
        showError('Vault lives on a remote host — open Explorer there.');
        return;
      }
      try { window.dashboard.shell.open(vaultPath); } catch (_) {}
    };

    // ── Markdown rendering (XSS-safe block parser) ─────────────────────────
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    const renderInline = (s) => {
      let out = escapeHtml(s);
      // Inline code FIRST so other rules don't touch its contents
      const codeStash = [];
      out = out.replace(/`([^`]+)`/g, (_, c) => {
        codeStash.push(c);
        return ` CODE${codeStash.length - 1} `;
      });
      // Wikilinks: [[Note]] or [[Note|alias]]
      out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
        const label = (alias || target).trim();
        return `<span class="cog-wikilink" data-wikilink="${escapeHtml(target.trim())}">${escapeHtml(label)}</span>`;
      });
      // External links [text](url)
      out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) =>
        `<a href="${escapeHtml(u)}" data-extlink="1">${escapeHtml(t)}</a>`);
      // Bold
      out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/__([^_\n]+)__/g,    '<strong>$1</strong>');
      // Italic
      out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
      out = out.replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, '$1<em>$2</em>');
      // Highlight ==text==
      out = out.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
      // Strikethrough ~~text~~
      out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
      // Tags #tag (must be after escape; spaces or line start before)
      out = out.replace(/(^|\s)(#[A-Za-z0-9_/\-]+)/g, (_, pre, tag) =>
        `${pre}<span class="cog-tag" data-tag="${escapeHtml(tag.slice(1))}">${escapeHtml(tag)}</span>`);
      // Restore inline code
      out = out.replace(/ CODE(\d+) /g, (_, i) => `<code>${escapeHtml(codeStash[Number(i)])}</code>`);
      return out;
    };

    const renderMarkdown = (md) => {
      if (!md || !md.trim()) return '<p class="cog-empty">Empty note. Press <b>EDIT</b> or Ctrl+E to start writing.</p>';
      // Strip frontmatter for the preview (kept verbatim in file)
      let body = md;
      if (/^---\s*\n/.test(body)) {
        const m = body.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
        if (m) body = body.slice(m[0].length);
      }
      const lines = body.split('\n');
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        // Code fence
        if (/^```/.test(line)) {
          const lang = line.replace(/^```/, '').trim();
          i++;
          const buf = [];
          while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
          if (i < lines.length) i++; // skip closing fence
          out.push(`<pre class="cog-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
          continue;
        }
        // Header
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); i++; continue; }
        // Horizontal rule
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
        // Blockquote
        if (/^> ?/.test(line)) {
          const buf = [];
          while (i < lines.length && /^> ?/.test(lines[i])) { buf.push(lines[i].replace(/^> ?/, '')); i++; }
          out.push(`<blockquote>${renderInline(buf.join(' '))}</blockquote>`);
          continue;
        }
        // List (unordered, ordered, task)
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const ordered = /^\s*\d+\.\s+/.test(line);
          const tag = ordered ? 'ol' : 'ul';
          const items = [];
          while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            const stripped = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
            const t = stripped.match(/^\[([ xX])\]\s+(.*)$/);
            if (t) {
              const checked = t[1].toLowerCase() === 'x';
              items.push(`<li class="cog-task"><input type="checkbox" disabled${checked ? ' checked' : ''}/> ${renderInline(t[2])}</li>`);
            } else {
              items.push(`<li>${renderInline(stripped)}</li>`);
            }
            i++;
          }
          out.push(`<${tag}>${items.join('')}</${tag}>`);
          continue;
        }
        // Empty line
        if (!line.trim()) { i++; continue; }
        // Paragraph
        const buf = [];
        while (i < lines.length && lines[i].trim() &&
               !/^(#{1,6}\s|>|```|---|\*\*\*|___|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) {
          buf.push(lines[i]); i++;
        }
        out.push(`<p>${renderInline(buf.join(' '))}</p>`);
      }
      return out.join('\n');
    };

    // ── Click delegation for wikilinks/tags/external links ─────────────────
    const onPreviewClick = (e) => {
      const wl = e.target.closest('[data-wikilink]');
      if (wl) {
        e.preventDefault();
        const target = wl.getAttribute('data-wikilink');
        resolveWikilink(target);
        return;
      }
      const tg = e.target.closest('[data-tag]');
      if (tg) {
        e.preventDefault();
        setActiveTag(tg.getAttribute('data-tag'));
        setRightTab('tags');
        return;
      }
      const ext = e.target.closest('[data-extlink]');
      if (ext) {
        e.preventDefault();
        const url = ext.getAttribute('href');
        if (url) {
          try { window.dashboard.shell.openExternal(url); } catch (_) {}
        }
      }
    };

    const resolveWikilink = (target) => {
      const t = target.trim().toLowerCase();
      const exact = notes.find(n => n.name.toLowerCase() === t || n.relPath.toLowerCase() === t || stripExt(n.relPath).toLowerCase() === t);
      if (exact) { openNote(exact.relPath); return; }
      // Fuzzy: contains
      const sub = notes.find(n => n.name.toLowerCase().includes(t));
      if (sub) { openNote(sub.relPath); return; }
      // Create new note in vault root
      const rel = `${target.trim()}.md`;
      window.dashboard.vault.write(VAULT_NAME, rel, `# ${target.trim()}\n\n`)
        .then(() => scanVault())
        .then(() => {
          setCurrentPath(rel);
          setEditorContent(`# ${target.trim()}\n\n`);
          setDirty(false);
          localStorage.setItem(LAST_KEY, rel);
        })
        .catch(e => showError('Create from link failed: ' + e.message));
    };

    // ── Backlinks: parse [[Wikilinks]] in every note's content ─────────────
    const linkIndex = useMemo(() => {
      // Map of resolved-note-relPath -> list of source note relPaths that link to it
      const map = {};
      for (const n of notes) map[n.relPath] = [];
      const lcLookup = {};
      for (const n of notes) lcLookup[n.name.toLowerCase()] = n.relPath;
      for (const n of notes) {
        const seen = new Set();
        const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        let m;
        while ((m = re.exec(n.content || ''))) {
          const target = m[1].trim().toLowerCase();
          const resolved = lcLookup[target] || lcLookup[stripExt(target)];
          if (resolved && resolved !== n.relPath && !seen.has(resolved)) {
            seen.add(resolved);
            map[resolved].push(n.relPath);
          }
        }
      }
      return map;
    }, [notes]);

    const backlinks = useMemo(() => {
      if (!currentPath) return [];
      return (linkIndex[currentPath] || []).map(rel => notes.find(n => n.relPath === rel)).filter(Boolean);
    }, [linkIndex, notes, currentPath]);

    // ── Tags index ─────────────────────────────────────────────────────────
    const tagIndex = useMemo(() => {
      const map = {};
      for (const n of notes) {
        const seen = new Set();
        const re = /(^|\s)#([A-Za-z0-9_/\-]+)/g;
        let m;
        while ((m = re.exec(n.content || ''))) {
          const tag = m[2];
          if (seen.has(tag)) continue;
          seen.add(tag);
          if (!map[tag]) map[tag] = [];
          map[tag].push(n.relPath);
        }
      }
      return map;
    }, [notes]);

    // ── Outline of current note (headings) ─────────────────────────────────
    const outline = useMemo(() => {
      if (!editorContent) return [];
      const list = [];
      const lines = editorContent.split('\n');
      let inFence = false;
      lines.forEach((line, idx) => {
        if (/^```/.test(line)) { inFence = !inFence; return; }
        if (inFence) return;
        const m = line.match(/^(#{1,6})\s+(.*)$/);
        if (m) list.push({ level: m[1].length, text: m[2].trim(), line: idx });
      });
      return list;
    }, [editorContent]);

    const jumpToLine = (lineIdx) => {
      setIsPreview(false);
      setTimeout(() => {
        const ta = editorRef.current;
        if (!ta) return;
        const lines = editorContent.split('\n');
        let pos = 0;
        for (let i = 0; i < lineIdx && i < lines.length; i++) pos += lines[i].length + 1;
        ta.focus();
        ta.setSelectionRange(pos, pos);
        // Approximate scroll
        const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 16;
        ta.scrollTop = Math.max(0, (lineIdx - 2) * lineHeight);
      }, 30);
    };

    // ── Word / char count ──────────────────────────────────────────────────
    const stats = useMemo(() => {
      const text = editorContent.replace(/```[\s\S]*?```/g, '').replace(/[`*_#>\[\]\(\)]/g, '');
      const words = (text.match(/\S+/g) || []).length;
      const chars = editorContent.length;
      return { words, chars };
    }, [editorContent]);

    // ── File tree (flattened, with collapse state) ─────────────────────────
    const tree = useMemo(() => {
      // Build hierarchy
      const root = { folders: {}, notes: [] };
      const ensureFolder = (parts) => {
        let cur = root;
        for (const p of parts) {
          if (!cur.folders[p]) cur.folders[p] = { folders: {}, notes: [] };
          cur = cur.folders[p];
        }
        return cur;
      };
      for (const f of allFolders) {
        if (f) ensureFolder(f.split('/'));
      }
      for (const n of notes) {
        const parts = n.folder ? n.folder.split('/') : [];
        const node = ensureFolder(parts);
        node.notes.push(n);
      }
      // Flatten respecting expansion
      const flat = [];
      const walk = (node, parentRel, depth) => {
        const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));
        for (const fn of folderNames) {
          const rel = parentRel ? `${parentRel}/${fn}` : fn;
          flat.push({ kind: 'folder', name: fn, rel, depth });
          if (expanded[rel]) walk(node.folders[fn], rel, depth + 1);
        }
        const sortedNotes = node.notes.slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const nt of sortedNotes) {
          flat.push({ kind: 'note', name: nt.name, rel: nt.relPath, depth });
        }
      };
      walk(root, '', 0);
      return flat;
    }, [notes, allFolders, expanded]);

    const toggleFolder = (rel) => setExpanded(prev => ({ ...prev, [rel]: !prev[rel] }));

    // ── Search (full-text + name) ──────────────────────────────────────────
    const searchResults = useMemo(() => {
      const q = searchTerm.trim().toLowerCase();
      if (!q) return [];
      return notes
        .map(n => {
          const inName    = n.name.toLowerCase().includes(q);
          const inContent = (n.content || '').toLowerCase().includes(q);
          if (!inName && !inContent) return null;
          let snippet = '';
          if (inContent) {
            const lc = (n.content || '').toLowerCase();
            const idx = lc.indexOf(q);
            const s = Math.max(0, idx - 25);
            const e = Math.min(n.content.length, idx + q.length + 25);
            snippet = (s > 0 ? '...' : '') + n.content.slice(s, e).replace(/\s+/g, ' ') + (e < n.content.length ? '...' : '');
          }
          return { ...n, _snippet: snippet, _score: (inName ? 10 : 0) + (inContent ? 1 : 0) };
        })
        .filter(Boolean)
        .sort((a, b) => b._score - a._score)
        .slice(0, 20);
    }, [searchTerm, notes]);

    const quickResults = useMemo(() => {
      const q = quickQuery.trim().toLowerCase();
      if (!q) return notes.slice(0, 12);
      return notes
        .filter(n => n.name.toLowerCase().includes(q) || n.relPath.toLowerCase().includes(q))
        .slice(0, 12);
    }, [quickQuery, notes]);

    // ── Editor key handlers (markdown shortcuts) ───────────────────────────
    const onEditorKey = (e) => {
      const ta = e.currentTarget;
      const wrap = (before, after) => {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const sel = editorContent.slice(s, en);
        const newText = editorContent.slice(0, s) + before + sel + after + editorContent.slice(en);
        setEditorContent(newText);
        setDirty(true);
        setTimeout(() => {
          ta.focus();
          if (sel) ta.setSelectionRange(s + before.length, en + before.length);
          else     ta.setSelectionRange(s + before.length, s + before.length);
        }, 0);
      };
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') return wrap('**', '**');
        if (k === 'i') return wrap('*', '*');
        if (k === 'k') return wrap('[[', ']]');
        if (k === '`') return wrap('`', '`');
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart;
        setEditorContent(editorContent.slice(0, s) + '  ' + editorContent.slice(ta.selectionEnd));
        setDirty(true);
        setTimeout(() => ta.setSelectionRange(s + 2, s + 2), 0);
      }
    };

    // ── Force-directed graph simulation (Obsidian-style) ───────────────────
    // Edges (deduped, undirected for layout purposes)
    const edges = useMemo(() => {
      const seen = new Set();
      const out = [];
      for (const target of Object.keys(linkIndex)) {
        for (const src of linkIndex[target]) {
          const key = src < target ? `${src}|${target}` : `${target}|${src}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ a: src, b: target });
        }
      }
      return out;
    }, [linkIndex]);

    // Adjacency for hover-highlight
    const adjacency = useMemo(() => {
      const m = {};
      for (const e of edges) {
        if (!m[e.a]) m[e.a] = new Set();
        if (!m[e.b]) m[e.b] = new Set();
        m[e.a].add(e.b);
        m[e.b].add(e.a);
      }
      return m;
    }, [edges]);

    // Degree (connection count) — drives node size like Obsidian
    const degrees = useMemo(() => {
      const m = {};
      for (const n of notes) m[n.relPath] = (adjacency[n.relPath]?.size) || 0;
      return m;
    }, [notes, adjacency]);

    // Keep the data the loop reads in a ref so the effect doesn't tear down on every change
    graphDataRef.current = { notes, edges, adjacency, degrees, currentPath };
    openNoteRef.current  = openNote;

    // Sync simulation node set with current notes (add new, prune deleted)
    useEffect(() => {
      const sim = simRef.current;
      const valid = new Set(notes.map(n => n.relPath));
      for (const id of Object.keys(sim.nodes)) {
        if (!valid.has(id)) delete sim.nodes[id];
      }
      notes.forEach((n, i) => {
        if (!sim.nodes[n.relPath]) {
          // Seed at random position on a ring so the simulation has something to spread from
          const a = (i / Math.max(1, notes.length)) * Math.PI * 2 + Math.random() * 0.3;
          const r = 80 + Math.random() * 120;
          sim.nodes[n.relPath] = { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
        }
      });
      sim.warmed = false; // ask the mini view to re-warm with the new node set
    }, [notes]);

    // One physics tick of the verlet-ish integrator
    const tickPhysics = () => {
      const sim  = simRef.current;
      const data = graphDataRef.current;
      const ids  = Object.keys(sim.nodes);
      if (ids.length === 0) return;
      const F = sim.forces;

      // Reset accumulated forces
      for (const id of ids) {
        const n = sim.nodes[id];
        n.fx = 0; n.fy = 0;
      }

      // Repulsion: every pair pushes apart (~1/r²)
      for (let i = 0; i < ids.length; i++) {
        const a = sim.nodes[ids[i]];
        for (let j = i + 1; j < ids.length; j++) {
          const b = sim.nodes[ids[j]];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx*dx + dy*dy + 0.01; }
          const d = Math.sqrt(d2);
          const f = F.rep / d2;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.fx += fx; a.fy += fy;
          b.fx -= fx; b.fy -= fy;
        }
      }

      // Attraction along edges (spring toward rest length)
      for (const e of data.edges) {
        const a = sim.nodes[e.a], b = sim.nodes[e.b];
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 0.001;
        const f = F.att * (d - F.len);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.fx += fx; a.fy += fy;
        b.fx -= fx; b.fy -= fy;
      }

      // Centering — pulls everything gently toward origin so the graph doesn't drift
      for (const id of ids) {
        const n = sim.nodes[id];
        n.fx -= n.x * F.cen;
        n.fy -= n.y * F.cen;
      }

      // Integrate (velocity-damped) — pinned nodes (being dragged) stay put
      const maxV = 30;
      for (const id of ids) {
        const n = sim.nodes[id];
        if (sim.dragId === id) { n.vx = 0; n.vy = 0; continue; }
        n.vx = (n.vx + n.fx) * F.damp;
        n.vy = (n.vy + n.fy) * F.damp;
        const v = Math.hypot(n.vx, n.vy);
        if (v > maxV) { n.vx = (n.vx / v) * maxV; n.vy = (n.vy / v) * maxV; }
        n.x += n.vx;
        n.y += n.vy;
      }
    };

    const drawSim = (canvas, w, h, opts) => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = _cv('--bg', '#050a05');
      ctx.fillRect(0, 0, w, h);

      const sim  = simRef.current;
      const data = graphDataRef.current;
      const isMini = opts && opts.miniView;

      // Mini view: auto-fit to canvas; full view: use interactive pan/zoom
      let scale, panX, panY;
      if (isMini) {
        let maxR = 1;
        for (const id of Object.keys(sim.nodes)) {
          const n = sim.nodes[id];
          const r = Math.hypot(n.x, n.y);
          if (r > maxR) maxR = r;
        }
        scale = Math.min(w, h) * 0.42 / maxR;
        panX = 0; panY = 0;
      } else {
        scale = sim.view.scale;
        panX  = sim.view.panX;
        panY  = sim.view.panY;
      }
      const cx = w / 2 + panX, cy = h / 2 + panY;
      const toScreen = (x, y) => ({ x: cx + x * scale, y: cy + y * scale });

      const hovered   = isMini ? null : sim.hoverId;
      const neighbors = hovered ? data.adjacency[hovered] : null;
      const litNode = (id) => !hovered || id === hovered || (neighbors && neighbors.has(id));
      const litEdge = (e) => !hovered || e.a === hovered || e.b === hovered;

      // ── Edges ──
      ctx.lineWidth = 1;
      for (const e of data.edges) {
        const a = sim.nodes[e.a], b = sim.nodes[e.b];
        if (!a || !b) continue;
        const lit = litEdge(e);
        ctx.strokeStyle = lit ? _cv('--accent', '#39ff14') : _cv('--border-bright', '#2f4a2f');
        ctx.globalAlpha = lit ? (hovered ? 0.85 : 0.45) : 0.1;
        ctx.lineWidth   = lit && hovered ? 1.4 : 1;
        const ap = toScreen(a.x, a.y), bp = toScreen(b.x, b.y);
        ctx.beginPath();
        ctx.moveTo(ap.x, ap.y);
        ctx.lineTo(bp.x, bp.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // ── Nodes ── (current note last so it draws on top)
      const ids = Object.keys(sim.nodes).sort((a, b) => {
        if (a === data.currentPath) return 1;
        if (b === data.currentPath) return -1;
        return 0;
      });
      const noteById = {};
      for (const n of data.notes) noteById[n.relPath] = n;

      for (const id of ids) {
        const n = sim.nodes[id];
        const note = noteById[id];
        if (!note) continue;
        const sp = toScreen(n.x, n.y);
        const deg = data.degrees[id] || 0;
        // Node size grows with degree, like Obsidian
        const baseR = 4 + Math.sqrt(deg) * 2.6;
        const r = isMini ? Math.max(2, baseR * Math.min(1, scale * 1.3)) : baseR;
        const isCurrent = data.currentPath === id;
        const isHover   = hovered === id;
        const lit       = litNode(id);

        ctx.globalAlpha = lit ? 1 : 0.18;

        // Glow ring for current note
        if (isCurrent && !isMini) {
          ctx.fillStyle = _cv('--accent', '#39ff14');
          ctx.globalAlpha = lit ? 0.22 : 0.08;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, r + 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = lit ? 1 : 0.18;
        }

        ctx.fillStyle   = isCurrent
          ? _cv('--accent', '#39ff14')
          : (isHover
              ? _cv('--fg-bright', '#9cff9c')
              : (deg === 0
                  ? _cv('--border', '#1a2a1a')
                  : _cv('--fg-dim', '#6f9a6f')));
        ctx.strokeStyle = isCurrent ? _cv('--fg-bright', '#9cff9c') : _cv('--accent', '#39ff14');
        ctx.lineWidth   = isCurrent || isHover ? 2 : 1;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Labels — fullscreen only, dense at higher zoom
        if (!isMini) {
          const showLabel = scale > 0.6 || isCurrent || isHover || deg >= 3;
          if (showLabel && lit) {
            ctx.fillStyle = isCurrent
              ? _cv('--accent', '#39ff14')
              : (isHover ? _cv('--fg', '#c8f0c8') : _cv('--fg-dim', '#6f9a6f'));
            const fs = Math.max(9, Math.min(13, 9 + scale * 1.5));
            ctx.font = `${fs}px ${_cv('--mono', 'JetBrains Mono, monospace')}`;
            ctx.textAlign = 'center';
            const label = note.name.length > 22 ? note.name.slice(0, 20) + '...' : note.name;
            ctx.fillText(label, sp.x, sp.y + r + fs + 1);
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    // Mini graph: render once with a quick warm-up so it looks settled
    useEffect(() => {
      if (rightTab !== 'graph') return;
      const c = miniGraphRef.current;
      if (!c) return;
      c.width  = c.clientWidth  || 180;
      c.height = c.clientHeight || 160;
      const sim = simRef.current;
      if (!sim.warmed && Object.keys(sim.nodes).length > 0) {
        for (let i = 0; i < 250; i++) tickPhysics();
        sim.warmed = true;
      }
      drawSim(c, c.width, c.height, { miniView: true });
    }, [rightTab, notes, currentPath, edges]);

    // Hit-test helper (in world coords)
    const hitTestWorld = (wx, wy) => {
      const sim  = simRef.current;
      const data = graphDataRef.current;
      let hit = null, bestD2 = Infinity;
      for (const id of Object.keys(sim.nodes)) {
        const n = sim.nodes[id];
        const deg = data.degrees[id] || 0;
        const r = (4 + Math.sqrt(deg) * 2.6) * 1.6;
        const dx = wx - n.x, dy = wy - n.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < r*r && d2 < bestD2) { bestD2 = d2; hit = id; }
      }
      return hit;
    };

    // Reset / center actions exposed to the graph header buttons
    const resetGraphLayout = () => {
      const sim = simRef.current;
      sim.nodes = {};
      sim.warmed = false;
      // Re-seed by triggering the sync effect
      const data = graphDataRef.current;
      data.notes.forEach((n, i) => {
        const a = (i / Math.max(1, data.notes.length)) * Math.PI * 2;
        const r = 80 + Math.random() * 120;
        sim.nodes[n.relPath] = { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
      });
    };
    const centerGraphView = () => {
      const sim = simRef.current;
      sim.view.panX = 0;
      sim.view.panY = 0;
      sim.view.scale = 1;
    };

    // Fullscreen graph: live simulation + pan / zoom / drag / hover / click
    useEffect(() => {
      if (!showGraphFull) return;
      const canvas = graphCanvasRef.current;
      if (!canvas) return;
      const sim = simRef.current;

      const resize = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth  || canvas.parentElement?.clientWidth  || 600;
        const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 400;
        canvas.width  = w * dpr;
        canvas.height = h * dpr;
        canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      if (canvas.parentElement) ro.observe(canvas.parentElement);

      const tick = () => {
        tickPhysics();
        const w = canvas.clientWidth  || canvas.parentElement?.clientWidth  || 600;
        const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 400;
        drawSim(canvas, w, h);
        sim.rafId = requestAnimationFrame(tick);
      };
      sim.rafId = requestAnimationFrame(tick);

      // Mouse / wheel state ────────────────────────────────────────────────
      let press = null;
      let didDrag = false;

      const screenToWorld = (sx, sy) => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const cx = w / 2 + sim.view.panX;
        const cy = h / 2 + sim.view.panY;
        return { x: (sx - cx) / sim.view.scale, y: (sy - cy) / sim.view.scale };
      };

      const onDown = (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const wp = screenToWorld(sx, sy);
        const hit = hitTestWorld(wp.x, wp.y);
        press = { sx, sy, t: Date.now(), nodeId: hit };
        didDrag = false;
        if (hit) {
          sim.dragId = hit;
          canvas.style.cursor = 'grabbing';
        } else {
          sim.panning = { sx, sy, panX: sim.view.panX, panY: sim.view.panY };
          canvas.style.cursor = 'grabbing';
        }
      };

      const onMove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        if (press) {
          const dx = sx - press.sx, dy = sy - press.sy;
          if (Math.hypot(dx, dy) > 3) didDrag = true;
        }
        if (sim.dragId) {
          const wp = screenToWorld(sx, sy);
          const n = sim.nodes[sim.dragId];
          if (n) { n.x = wp.x; n.y = wp.y; n.vx = 0; n.vy = 0; }
        } else if (sim.panning) {
          sim.view.panX = sim.panning.panX + (sx - sim.panning.sx);
          sim.view.panY = sim.panning.panY + (sy - sim.panning.sy);
        } else {
          const wp = screenToWorld(sx, sy);
          const hit = hitTestWorld(wp.x, wp.y);
          sim.hoverId = hit;
          canvas.style.cursor = hit ? 'pointer' : 'grab';
        }
      };

      const onUp = () => {
        // Click (no drag) on a node → open it
        if (press && press.nodeId && !didDrag) {
          openNoteRef.current(press.nodeId);
        }
        sim.dragId = null;
        sim.panning = null;
        press = null;
        didDrag = false;
        canvas.style.cursor = sim.hoverId ? 'pointer' : 'grab';
      };

      const onWheel = (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const wp = screenToWorld(sx, sy);
        const factor = Math.exp(-e.deltaY * 0.0015);
        const newScale = Math.max(0.15, Math.min(4, sim.view.scale * factor));
        sim.view.scale = newScale;
        // Keep the world point under the cursor stationary
        sim.view.panX = sx - w / 2 - wp.x * newScale;
        sim.view.panY = sy - h / 2 - wp.y * newScale;
      };

      const onLeave = () => { sim.hoverId = null; };

      canvas.addEventListener('mousedown',  onDown);
      window.addEventListener('mousemove',  onMove);
      window.addEventListener('mouseup',    onUp);
      canvas.addEventListener('wheel',      onWheel, { passive: false });
      canvas.addEventListener('mouseleave', onLeave);
      canvas.style.cursor = 'grab';

      return () => {
        if (sim.rafId) cancelAnimationFrame(sim.rafId);
        sim.rafId = null;
        sim.hoverId = null;
        sim.dragId  = null;
        sim.panning = null;
        ro.disconnect();
        canvas.removeEventListener('mousedown',  onDown);
        window.removeEventListener('mousemove',  onMove);
        window.removeEventListener('mouseup',    onUp);
        canvas.removeEventListener('wheel',      onWheel);
        canvas.removeEventListener('mouseleave', onLeave);
      };
    }, [showGraphFull]);

    // ── Current note convenience accessor ──────────────────────────────────
    const currentNote = currentPath ? notes.find(n => n.relPath === currentPath) : null;

    // ── Styles ─────────────────────────────────────────────────────────────
    const css = `
      .cog-root      { background:var(--bg); color:var(--fg-bright); height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative; font-size:11px; }
      .cog-topbar    { display:flex; align-items:center; gap:6px; padding:5px 8px; background:var(--bg-elev); border-bottom:1px solid var(--border); flex-shrink:0; }
      .cog-brand     { color:var(--accent); font-weight:700; font-size:11px; letter-spacing:1px; }
      .cog-body      { display:flex; flex:1; overflow:hidden; min-height:0; }
      .cog-side      { background:var(--bg-elev); overflow-y:auto; flex-shrink:0; }
      .cog-left      { width:200px; border-right:1px solid var(--border); }
      .cog-right     { width:210px; border-left:1px solid var(--border); display:flex; flex-direction:column; }
      .cog-label     { font-size:8px; color:var(--fg-dim); padding:6px 8px 3px; letter-spacing:1px; }
      .cog-row       { padding:2px 6px; font-size:10px; cursor:pointer; user-select:none; display:flex; align-items:center; gap:3px; border-radius:2px; }
      .cog-row:hover { background:var(--border); }
      .cog-row.active{ background:var(--border); color:var(--accent); }
      .cog-row .star { margin-left:auto; opacity:0.4; }
      .cog-row:hover .star, .cog-row .star.on { opacity:1; }
      .cog-folder-toggle { width:10px; display:inline-block; color:var(--fg-dim); }
      .cog-tabs      { display:flex; border-bottom:1px solid var(--border); }
      .cog-tab       { flex:1; padding:5px 4px; font-size:8px; text-align:center; cursor:pointer; color:var(--fg-dim); border-bottom:1px solid transparent; letter-spacing:0.5px; }
      .cog-tab.active{ color:var(--accent); border-bottom-color:var(--accent); }
      .cog-main      { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }
      .cog-noteHead  { display:flex; align-items:center; padding:4px 8px; background:var(--bg-elev); border-bottom:1px solid var(--border); gap:6px; }
      .cog-noteHead .title { flex:1; color:var(--accent); font-weight:600; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .cog-editor textarea { width:100%; height:100%; border:none; outline:none; background:var(--bg); color:var(--fg); font-family:var(--mono, monospace); font-size:12px; padding:14px 18px; resize:none; line-height:1.6; }
      .cog-preview   { padding:14px 20px; color:var(--fg); font-size:12px; line-height:1.65; overflow-y:auto; height:100%; }
      .cog-preview h1{ color:var(--accent); font-size:18px; border-bottom:1px solid var(--border-bright); padding-bottom:4px; margin:8px 0; }
      .cog-preview h2{ color:var(--accent); font-size:15px; margin:8px 0 4px; }
      .cog-preview h3{ color:var(--fg-bright); font-size:13px; margin:6px 0 3px; }
      .cog-preview h4, .cog-preview h5, .cog-preview h6 { color:var(--fg-bright); font-size:12px; margin:4px 0 2px; }
      .cog-preview p { margin:4px 0; }
      .cog-preview ul, .cog-preview ol { margin:4px 0; padding-left:20px; }
      .cog-preview li { margin:1px 0; }
      .cog-preview blockquote { border-left:2px solid var(--accent); padding:2px 10px; color:var(--fg-bright); margin:6px 0; background:var(--bg-elev); }
      .cog-preview hr { border:none; border-top:1px solid var(--border-bright); margin:10px 0; }
      .cog-preview code { background:var(--bg-elev); color:var(--accent-warm); padding:0 4px; border-radius:2px; font-family:var(--mono, monospace); }
      .cog-preview pre.cog-pre { background:var(--bg-elev); border:1px solid var(--border); padding:8px 10px; overflow-x:auto; border-radius:3px; margin:6px 0; }
      .cog-preview pre.cog-pre code { background:none; color:var(--fg); padding:0; }
      .cog-preview a { color:var(--fg-bright); text-decoration:underline; cursor:pointer; }
      .cog-wikilink  { color:var(--accent); cursor:pointer; padding:0 2px; border-bottom:1px dashed var(--accent); }
      .cog-wikilink:hover { background:var(--border); }
      .cog-tag       { color:var(--accent-warm); cursor:pointer; }
      .cog-tag:hover { text-decoration:underline; }
      .cog-preview mark { background:rgba(var(--accent-rgb), 0.18); color:var(--accent-warm); padding:0 2px; }
      .cog-preview .cog-task input { vertical-align:middle; margin:0 4px 0 -16px; }
      .cog-empty     { color:var(--fg-dim); font-style:italic; }
      .cog-statusbar { display:flex; align-items:center; gap:10px; padding:3px 10px; background:var(--bg-elev); border-top:1px solid var(--border); font-size:8px; color:var(--fg-dim); flex-shrink:0; }
      .cog-modal     { position:absolute; inset:0; background:rgba(0,0,0,0.55); display:flex; align-items:flex-start; justify-content:center; z-index:100; padding-top:60px; }
      .cog-modalBox  { background:var(--bg-elev); border:1px solid var(--accent); border-radius:4px; padding:10px; width:420px; max-height:60%; overflow:hidden; display:flex; flex-direction:column; }
      .cog-search-overlay { position:absolute; left:200px; right:210px; top:32px; background:var(--bg-elev); border:1px solid var(--accent); border-radius:0 0 3px 3px; max-height:280px; overflow-y:auto; z-index:50; }
      .cog-result    { padding:6px 10px; border-bottom:1px solid var(--border); cursor:pointer; }
      .cog-result:hover { background:var(--border); }
      .cog-banner    { background:rgba(255,107,107,0.12); border-top:1px solid var(--danger); color:var(--danger); font-size:9px; padding:4px 10px; flex-shrink:0; }
      .cog-icon-btn  { background:transparent; border:1px solid var(--border); color:var(--fg-bright); padding:1px 6px; border-radius:2px; cursor:pointer; font-size:9px; }
      .cog-icon-btn:hover { border-color:var(--accent); color:var(--accent); }
      .cog-icon-btn.active { border-color:var(--accent); color:var(--accent); background:var(--border); }
      .cog-input     { background:var(--bg); border:1px solid var(--border); color:var(--fg); padding:3px 6px; font-family:var(--mono, monospace); font-size:10px; outline:none; border-radius:2px; }
      .cog-input:focus { border-color:var(--accent); }
      .cog-graph-mini{ display:block; width:100%; height:160px; border:1px solid var(--border); background:var(--bg); cursor:pointer; }
      .cog-graph-full{ display:block; position:absolute; inset:0; width:100%; height:100%; }
      .cog-dirtydot  { width:6px; height:6px; border-radius:50%; background:var(--accent-warm); display:inline-block; margin-right:4px; }
      .cog-saved     { color:var(--fg-dim); font-size:8px; }
      .cog-tagchip   { display:inline-block; padding:1px 6px; margin:2px; background:var(--bg-elev); border:1px solid var(--border-bright); border-radius:10px; cursor:pointer; font-size:9px; color:var(--accent-warm); }
      .cog-tagchip.active { border-color:var(--accent-warm); background:rgba(255,180,84,0.12); }
      .cog-outline-h { padding:3px 8px; cursor:pointer; font-size:10px; }
      .cog-outline-h:hover { background:var(--border); color:var(--accent); }
    `;

    // ── Render ─────────────────────────────────────────────────────────────
    return (
      <div className="cog-root" ref={rootRef}>
        <style>{css}</style>

        {/* Top Bar */}
        <div className="cog-topbar">
          <div className="cog-brand">COGNICORE</div>

          <input className="cog-input" placeholder="Search vault... (text & names)"
            value={searchTerm}
            onChange={e => { setSearchTerm(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            style={{ flex: 1, fontSize: 10 }} />

          <button className="cog-icon-btn" title="Quick switcher (Ctrl+P)"
            onClick={() => { setShowQuickSwitch(true); setQuickQuery(''); }}>
            ⌕
          </button>
          <button className="cog-icon-btn" title="New note in root"
            onClick={() => { setCreatingIn({ kind: 'note', folder: '' }); setCreateValue(''); }}>
            + NOTE
          </button>
          <button className="cog-icon-btn" title="Open today's daily note" onClick={openDailyNote}>
            DAILY
          </button>
          <button className={'cog-icon-btn' + (showGraphFull ? ' active' : '')}
            title="Toggle graph view"
            onClick={() => setShowGraphFull(g => !g)}>
            GRAPH
          </button>
          <button className="cog-icon-btn" title="Pick vault folder" onClick={pickVault}>VAULT</button>
          <button className="cog-icon-btn" title="Reveal in file explorer" onClick={revealInExplorer}>↗</button>
        </div>

        <div className="cog-body">
          {/* ── Left sidebar: file tree + starred ── */}
          <div className="cog-side cog-left">
            {starred.length > 0 && (
              <>
                <div className="cog-label">STARRED</div>
                {starred.map(rel => {
                  const n = notes.find(x => x.relPath === rel);
                  if (!n) return null;
                  return (
                    <div key={rel} className={'cog-row' + (currentPath === rel ? ' active' : '')}
                      onClick={() => openNote(rel)}>
                      <span style={{ color: 'var(--accent-warm)' }}>★</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                    </div>
                  );
                })}
              </>
            )}

            <div className="cog-label" style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ flex: 1 }}>VAULT</span>
              <button className="cog-icon-btn" style={{ padding: '0 4px', fontSize: 8 }}
                title="New folder in root"
                onClick={() => { setCreatingIn({ kind: 'folder', folder: '' }); setCreateValue(''); }}>
                +D
              </button>
            </div>

            {tree.length === 0 && (
              <div style={{ padding: '8px 10px', fontSize: 9, color: 'var(--fg-dim)' }}>
                Empty vault. Create your first note.
              </div>
            )}

            {tree.map(node => {
              const indent = node.depth * 10;
              const isCurrent = node.kind === 'note' && currentPath === node.rel;
              const isRenaming = renameTarget && renameTarget.path === node.rel;
              if (node.kind === 'folder') {
                const open = !!expanded[node.rel];
                return (
                  <div key={'f:' + node.rel} className="cog-row"
                    style={{ paddingLeft: 6 + indent, color: 'var(--fg-bright)' }}
                    onClick={() => toggleFolder(node.rel)}
                    onDoubleClick={(e) => { e.stopPropagation(); setRenameTarget({ type: 'folder', path: node.rel }); setRenameValue(node.name); }}>
                    <span className="cog-folder-toggle">{open ? '▾' : '▸'}</span>
                    {isRenaming ? (
                      <input className="cog-input" autoFocus
                        value={renameValue}
                        onClick={e => e.stopPropagation()}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') renameEntry(node.rel, renameValue, true);
                          if (e.key === 'Escape') setRenameTarget(null);
                        }}
                        onBlur={() => renameEntry(node.rel, renameValue, true)}
                        style={{ flex: 1, fontSize: 9 }} />
                    ) : (
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {node.name}
                      </span>
                    )}
                    <span title="New note here" onClick={e => { e.stopPropagation(); setCreatingIn({ kind: 'note', folder: node.rel }); setCreateValue(''); setExpanded(p => ({ ...p, [node.rel]: true })); }} style={{ color: 'var(--fg-dim)', padding: '0 3px' }}>+</span>
                    <span title="Delete folder" onClick={e => { e.stopPropagation(); setConfirmDelete(node.rel); }}
                      style={{ color: confirmDelete === node.rel ? 'var(--danger)' : 'var(--fg-dim)', padding: '0 3px' }}>
                      {confirmDelete === node.rel ? '?' : '×'}
                    </span>
                    {confirmDelete === node.rel && (
                      <span onClick={e => { e.stopPropagation(); deleteEntry(node.rel, true); }}
                        style={{ color: 'var(--danger)', padding: '0 3px' }}>
                        DEL
                      </span>
                    )}
                  </div>
                );
              }
              return (
                <div key={'n:' + node.rel}
                  className={'cog-row' + (isCurrent ? ' active' : '')}
                  style={{ paddingLeft: 6 + indent + 12 }}
                  onClick={() => openNote(node.rel)}
                  onDoubleClick={(e) => { e.stopPropagation(); setRenameTarget({ type: 'note', path: node.rel }); setRenameValue(node.name); }}>
                  {isRenaming ? (
                    <input className="cog-input" autoFocus
                      value={renameValue}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') renameEntry(node.rel, renameValue, false);
                        if (e.key === 'Escape') setRenameTarget(null);
                      }}
                      onBlur={() => renameEntry(node.rel, renameValue, false)}
                      style={{ flex: 1, fontSize: 9 }} />
                  ) : (
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {node.name}
                    </span>
                  )}
                  <span className={'star' + (starred.includes(node.rel) ? ' on' : '')}
                    title="Star" onClick={e => { e.stopPropagation(); toggleStar(node.rel); }}
                    style={{ color: starred.includes(node.rel) ? 'var(--accent-warm)' : 'var(--fg-dim)' }}>
                    {starred.includes(node.rel) ? '★' : '☆'}
                  </span>
                </div>
              );
            })}

            {/* Create input */}
            {creatingIn && (
              <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', display: 'flex', gap: 4 }}>
                <input className="cog-input" autoFocus
                  placeholder={creatingIn.kind === 'note' ? `Note in ${creatingIn.folder || 'Root'}…` : `Folder in ${creatingIn.folder || 'Root'}…`}
                  value={createValue}
                  onChange={e => setCreateValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      if (creatingIn.kind === 'note') createNote(creatingIn.folder, createValue);
                      else                            createFolder(creatingIn.folder, createValue);
                      setCreatingIn(null);
                    }
                    if (e.key === 'Escape') setCreatingIn(null);
                  }}
                  onBlur={() => setCreatingIn(null)}
                  style={{ flex: 1, fontSize: 9 }} />
              </div>
            )}
          </div>

          {/* ── Main pane: editor / preview / fullscreen graph ── */}
          <div className="cog-main">
            {showGraphFull ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
                <div className="cog-noteHead">
                  <div className="title">
                    GRAPH VIEW — {notes.length} notes · {edges.length} links
                  </div>
                  <button className="cog-icon-btn" title="Re-randomize node positions" onClick={resetGraphLayout}>RESET</button>
                  <button className="cog-icon-btn" title="Reset pan & zoom"             onClick={centerGraphView}>CENTER</button>
                  <button className="cog-icon-btn" onClick={() => setShowGraphFull(false)}>CLOSE</button>
                </div>
                <div style={{ flex: 1, position: 'relative' }}>
                  <canvas ref={graphCanvasRef} className="cog-graph-full" />
                  <div style={{ position: 'absolute', bottom: 8, left: 12, fontSize: 8, color: 'var(--fg-dim)', pointerEvents: 'none' }}>
                    drag node · drag empty to pan · wheel to zoom · hover to highlight · click to open
                  </div>
                </div>
              </div>
            ) : currentNote ? (
              <>
                <div className="cog-noteHead">
                  <div className="title">
                    {dirty && <span className="cog-dirtydot" title="Unsaved" />}
                    {currentNote.name}
                    <span style={{ color: 'var(--fg-dim)', fontSize: 9, marginLeft: 8 }}>
                      {currentNote.folder || 'Root'}
                    </span>
                  </div>
                  <button className="cog-icon-btn"
                    title={starred.includes(currentPath) ? 'Unstar' : 'Star'}
                    onClick={() => toggleStar(currentPath)}
                    style={{ color: starred.includes(currentPath) ? 'var(--accent-warm)' : undefined, borderColor: starred.includes(currentPath) ? 'var(--accent-warm)' : undefined }}>
                    {starred.includes(currentPath) ? '★' : '☆'}
                  </button>
                  <select className="cog-input" value={currentNote.folder || ''}
                    onChange={e => moveNote(currentPath, e.target.value)}
                    title="Move to folder" style={{ fontSize: 9, maxWidth: 130 }}>
                    {allFolders.map(f => <option key={f} value={f}>{f || 'Root'}</option>)}
                  </select>
                  <button className={'cog-icon-btn' + (isPreview ? ' active' : '')}
                    title="Toggle preview (Ctrl+E)"
                    onClick={() => setIsPreview(p => !p)}>
                    {isPreview ? 'EDIT' : 'PREVIEW'}
                  </button>
                  <button className="cog-icon-btn"
                    style={{ color: confirmDelete === currentPath ? 'var(--danger)' : undefined, borderColor: confirmDelete === currentPath ? 'var(--danger)' : undefined }}
                    onClick={() => {
                      if (confirmDelete === currentPath) deleteEntry(currentPath, false);
                      else { setConfirmDelete(currentPath); setTimeout(() => setConfirmDelete(c => c === currentPath ? null : c), 3000); }
                    }}>
                    {confirmDelete === currentPath ? 'CONFIRM' : 'DELETE'}
                  </button>
                </div>

                <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                  {isPreview ? (
                    <div className="cog-preview"
                      onClick={onPreviewClick}
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(editorContent) }} />
                  ) : (
                    <div className="cog-editor" style={{ height: '100%' }}>
                      <textarea ref={editorRef}
                        value={editorContent}
                        spellCheck={false}
                        onChange={e => { setEditorContent(e.target.value); setDirty(true); }}
                        onKeyDown={onEditorKey}
                        placeholder="Start writing markdown… [[link]], #tag, ```code```, - [ ] task" />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-dim)', fontSize: 11, padding: 24, textAlign: 'center' }}>
                <div>
                  <div style={{ fontSize: 14, color: 'var(--accent)', marginBottom: 8 }}>COGNICORE</div>
                  <div>Pick a note from the sidebar, or:</div>
                  <div style={{ marginTop: 12, display: 'flex', gap: 6, justifyContent: 'center' }}>
                    <button className="cog-icon-btn" onClick={() => { setCreatingIn({ kind: 'note', folder: '' }); setCreateValue(''); }}>+ NEW NOTE</button>
                    <button className="cog-icon-btn" onClick={openDailyNote}>DAILY</button>
                    <button className="cog-icon-btn" onClick={() => { setShowQuickSwitch(true); setQuickQuery(''); }}>⌕ QUICK SWITCH</button>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 8 }}>Vault: {vaultPath || '(loading…)'}</div>
                </div>
              </div>
            )}
          </div>

          {/* ── Right sidebar: tabs ── */}
          <div className="cog-side cog-right">
            <div className="cog-tabs">
              {['backlinks', 'tags', 'outline', 'graph'].map(t => (
                <div key={t} className={'cog-tab' + (rightTab === t ? ' active' : '')}
                  onClick={() => setRightTab(t)}>
                  {t.toUpperCase()}
                </div>
              ))}
            </div>

            {rightTab === 'backlinks' && (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <div className="cog-label">BACKLINKS</div>
                {backlinks.length === 0 ? (
                  <div style={{ padding: '4px 10px', fontSize: 9, color: 'var(--fg-dim)' }}>
                    {currentPath ? 'No notes link here yet.' : 'Open a note to see backlinks.'}
                  </div>
                ) : backlinks.map(b => (
                  <div key={b.relPath} className="cog-row" onClick={() => openNote(b.relPath)}>
                    <span style={{ color: 'var(--accent)' }}>←</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {b.name}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {rightTab === 'tags' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px' }}>
                <div className="cog-label" style={{ padding: '2px 4px' }}>TAGS</div>
                {Object.keys(tagIndex).length === 0 && (
                  <div style={{ padding: '4px 6px', fontSize: 9, color: 'var(--fg-dim)' }}>
                    No tags. Use #tag in any note.
                  </div>
                )}
                <div>
                  {Object.keys(tagIndex).sort().map(t => (
                    <span key={t} className={'cog-tagchip' + (activeTag === t ? ' active' : '')}
                      onClick={() => setActiveTag(activeTag === t ? null : t)}>
                      #{t} <span style={{ color: 'var(--fg-dim)' }}>{tagIndex[t].length}</span>
                    </span>
                  ))}
                </div>
                {activeTag && (
                  <>
                    <div className="cog-label" style={{ padding: '8px 4px 2px' }}>NOTES WITH #{activeTag}</div>
                    {tagIndex[activeTag].map(rel => {
                      const n = notes.find(x => x.relPath === rel);
                      if (!n) return null;
                      return (
                        <div key={rel} className={'cog-row' + (currentPath === rel ? ' active' : '')}
                          onClick={() => openNote(rel)}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {n.name}
                          </span>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {rightTab === 'outline' && (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <div className="cog-label">OUTLINE</div>
                {outline.length === 0 ? (
                  <div style={{ padding: '4px 10px', fontSize: 9, color: 'var(--fg-dim)' }}>
                    No headings. Use # in your note.
                  </div>
                ) : outline.map((h, i) => (
                  <div key={i} className="cog-outline-h"
                    style={{ paddingLeft: 8 + (h.level - 1) * 10, color: h.level === 1 ? 'var(--accent)' : 'var(--fg-bright)' }}
                    onClick={() => jumpToLine(h.line)}>
                    {h.text}
                  </div>
                ))}
              </div>
            )}

            {rightTab === 'graph' && (
              <div style={{ flex: 1, padding: '6px 8px' }}>
                <div className="cog-label" style={{ padding: 0 }}>GRAPH</div>
                <canvas ref={miniGraphRef} className="cog-graph-mini"
                  onClick={() => setShowGraphFull(true)} />
                <div style={{ fontSize: 8, color: 'var(--fg-dim)', textAlign: 'center', marginTop: 4 }}>
                  {notes.length} notes · click to expand
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Status bar */}
        <div className="cog-statusbar">
          <span>{notes.length} notes</span>
          <span>·</span>
          <span>{stats.words} words · {stats.chars} chars</span>
          <span style={{ flex: 1 }} />
          {dirty && <span style={{ color: 'var(--accent-warm)' }}>● editing…</span>}
          {!dirty && savedAt > 0 && <span className="cog-saved">saved</span>}
          <span>·</span>
          <span>vault: {vaultPath ? vaultPath.split('/').slice(-2).join('/') : '(none)'}</span>
        </div>

        {/* Error banner */}
        {errorMsg && <div className="cog-banner">! {errorMsg}</div>}

        {/* Search overlay */}
        {searchOpen && searchTerm.trim() && (
          <div className="cog-search-overlay" onClick={e => e.stopPropagation()}>
            {searchResults.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: 9, color: 'var(--fg-dim)' }}>No matches.</div>
            ) : searchResults.map(r => (
              <div key={r.relPath} className="cog-result"
                onClick={() => { openNote(r.relPath); setSearchOpen(false); setSearchTerm(''); }}>
                <div style={{ color: 'var(--accent)', fontSize: 10 }}>{r.name}</div>
                <div style={{ color: 'var(--fg-dim)', fontSize: 8 }}>{r.relPath}</div>
                {r._snippet && (
                  <div style={{ color: 'var(--fg-bright)', fontSize: 9, marginTop: 2 }}>{r._snippet}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Quick switcher modal (Ctrl+P) */}
        {showQuickSwitch && (
          <div className="cog-modal" onClick={() => setShowQuickSwitch(false)}>
            <div className="cog-modalBox" onClick={e => e.stopPropagation()}>
              <input className="cog-input" autoFocus
                placeholder="Jump to note..."
                value={quickQuery}
                onChange={e => setQuickQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && quickResults[0]) {
                    openNote(quickResults[0].relPath);
                    setShowQuickSwitch(false);
                  }
                  if (e.key === 'Escape') setShowQuickSwitch(false);
                }}
                style={{ fontSize: 12, padding: '6px 10px' }} />
              <div style={{ overflowY: 'auto', marginTop: 8 }}>
                {quickResults.map(r => (
                  <div key={r.relPath} className="cog-result"
                    onClick={() => { openNote(r.relPath); setShowQuickSwitch(false); }}>
                    <div style={{ color: 'var(--accent)', fontSize: 10 }}>{r.name}</div>
                    <div style={{ color: 'var(--fg-dim)', fontSize: 8 }}>{r.relPath}</div>
                  </div>
                ))}
                {quickResults.length === 0 && (
                  <div style={{ padding: '6px 10px', fontSize: 9, color: 'var(--fg-dim)' }}>No notes match.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
};
