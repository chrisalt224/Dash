// File explorer — browse the filesystem, open files with their default app.
// Single-click a folder to navigate. Single-click a file to open it.
// Right-click any entry to reveal it in Windows Explorer.
// Edit the path bar and press Enter to jump anywhere.

const LAST_PATH_KEY = 'plugin:explorer:lastPath:v1';

const fmtSize = (n) => {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const parentOf = (p) => {
  if (!p) return p;
  // Handle both Windows and POSIX
  const sep = p.includes('\\') ? '\\' : '/';
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  if (parts.length <= 1) return p;
  parts.pop();
  // Drive root case: 'C:' → 'C:\\'
  if (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) return parts[0] + '\\';
  return parts.join(sep) || sep;
};

export default {
  id: 'file-explorer',
  name: 'Files',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const [path, setPath] = useState(() => localStorage.getItem(LAST_PATH_KEY) || '');
    const [pathDraft, setPathDraft] = useState(path);
    const [entries, setEntries] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const reqId = useRef(0);

    useEffect(() => {
      let cancelled = false;
      const myReq = ++reqId.current;
      const load = async () => {
        let p = path;
        if (!p) {
          p = await window.dashboard.fs.home();
          if (cancelled || myReq !== reqId.current) return;
          setPath(p);
          setPathDraft(p);
          return;
        }
        setLoading(true);
        try {
          const list = await window.dashboard.fs.list(p);
          if (cancelled || myReq !== reqId.current) return;
          setEntries(list);
          setError(null);
          localStorage.setItem(LAST_PATH_KEY, p);
          setPathDraft(p);
        } catch (err) {
          if (cancelled || myReq !== reqId.current) return;
          setError(err.message || String(err));
          setEntries([]);
        } finally {
          if (!cancelled && myReq === reqId.current) setLoading(false);
        }
      };
      load();
      return () => { cancelled = true; };
    }, [path]);

    const goUp = () => {
      const parent = parentOf(path);
      if (parent && parent !== path) setPath(parent);
    };

    const goHome = async () => {
      setPath(await window.dashboard.fs.home());
    };

    const openEntry = (entry) => {
      if (entry.isDir) setPath(entry.path);
      else window.dashboard.shell.open(entry.path);
    };

    const reveal = (entry) => window.dashboard.shell.reveal(entry.path);

    const sorted = entries.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        <div className="p-row" style={{ gap: 4 }}>
          <button className="p-btn" onClick={goUp} title="parent folder">↑</button>
          <button className="p-btn" onClick={goHome} title="home">⌂</button>
          <input
            className="p-input"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setPath(pathDraft); }}
            spellCheck={false}
            style={{ fontSize: 11, flex: 1 }}
          />
        </div>
        {error && (
          <div style={{
            color: 'var(--danger)',
            fontSize: 11,
            padding: 6,
            border: '1px dashed var(--danger)',
            borderRadius: 4,
          }}>{error}</div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', fontSize: 12 }}>
          {loading && <div className="p-dim p-label">loading...</div>}
          {!loading && sorted.length === 0 && !error && (
            <div className="p-dim p-label">empty folder</div>
          )}
          {sorted.map((ent) => (
            <div
              key={ent.path}
              onClick={() => openEntry(ent)}
              onContextMenu={(e) => { e.preventDefault(); reveal(ent); }}
              className="p-row"
              style={{
                padding: '3px 6px',
                cursor: 'pointer',
                borderRadius: 3,
                gap: 8,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--accent-rgb),0.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
              title={`${ent.path}\nclick: open · right-click: reveal in Explorer`}
            >
              <span style={{
                width: 14,
                color: ent.isDir ? 'var(--accent)' : 'var(--fg-dim)',
                textAlign: 'center',
              }}>{ent.isDir ? '▸' : '·'}</span>
              <span style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: ent.isDir ? 'var(--fg-bright)' : 'var(--fg)',
              }}>{ent.name}</span>
              {ent.isFile && (
                <span className="p-dim" style={{ fontSize: 10, flexShrink: 0 }}>
                  {fmtSize(ent.size)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  },
};
