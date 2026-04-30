export default {
  id: 'voice-recorder',
  name: 'VOICE RECORDER',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const META_KEY = 'plugin:voice-recorder:meta:v2';

    // ── State ──────────────────────────────────────────────────────────────
    const [folders, setFolders]             = useState(['Root']);
    const [currentFolder, setCurrentFolder] = useState('Root');
    const [recordings, setRecordings]       = useState([]);   // metadata only
    const [isRecording, setIsRecording]     = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [pendingAudio, setPendingAudio]   = useState(null); // { blob, folder, duration }
    const [pendingName, setPendingName]     = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState(null);
    const [playingId, setPlayingId]         = useState(null);
    const [renamingId, setRenamingId]       = useState(null);
    const [renameValue, setRenameValue]     = useState('');
    const [errorMsg, setErrorMsg]           = useState('');
    const [showNewFolder, setShowNewFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');

    // ── Refs ───────────────────────────────────────────────────────────────
    const mediaRecorderRef  = useRef(null);
    const audioChunksRef    = useRef([]);
    const timerRef          = useRef(null);
    const streamRef         = useRef(null);
    const recordingTimeRef  = useRef(0);   // accurate duration, not subject to stale closure
    const dbRef             = useRef(null);
    const currentAudioRef   = useRef(null);
    const errorTimerRef     = useRef(null);

    // ── Error helper ───────────────────────────────────────────────────────
    const showError = (msg) => {
      setErrorMsg(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setErrorMsg(''), 4000);
    };

    // ── IndexedDB helpers ──────────────────────────────────────────────────
    const getDB = () => new Promise((resolve, reject) => {
      if (dbRef.current) { resolve(dbRef.current); return; }
      const req = indexedDB.open('vr-audio-v1', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('blobs', { keyPath: 'id' });
      req.onsuccess = e => { dbRef.current = e.target.result; resolve(dbRef.current); };
      req.onerror   = e => reject(e.target.error);
    });

    const saveBlob = async (id, blob) => {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put({ id, blob });
        tx.oncomplete = () => resolve();
        tx.onerror    = e => reject(e.target.error);
      });
    };

    const loadBlob = async (id) => {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction('blobs', 'readonly').objectStore('blobs').get(id);
        req.onsuccess = e => resolve(e.target.result?.blob ?? null);
        req.onerror   = e => reject(e.target.error);
      });
    };

    const removeBlob = async (id) => {
      try {
        const db = await getDB();
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').delete(id);
      } catch (_) {}
    };

    // ── Init ───────────────────────────────────────────────────────────────
    useEffect(() => {
      getDB().catch(() => showError('Audio storage init failed'));
      try {
        const saved = localStorage.getItem(META_KEY);
        if (saved) {
          const d = JSON.parse(saved);
          if (d.folders)       setFolders(d.folders);
          if (d.recordings)    setRecordings(d.recordings);
          if (d.currentFolder) setCurrentFolder(d.currentFolder);
        }
      } catch (_) {}
      return () => {
        if (timerRef.current)       clearInterval(timerRef.current);
        if (streamRef.current)      streamRef.current.getTracks().forEach(t => t.stop());
        if (currentAudioRef.current) { currentAudioRef.current.pause(); }
        if (dbRef.current)          { dbRef.current.close(); dbRef.current = null; }
        if (errorTimerRef.current)  clearTimeout(errorTimerRef.current);
      };
    }, []);

    // ── Persist metadata ───────────────────────────────────────────────────
    useEffect(() => {
      localStorage.setItem(META_KEY, JSON.stringify({ folders, recordings, currentFolder }));
    }, [folders, recordings, currentFolder]);

    // ── Recording timer ────────────────────────────────────────────────────
    useEffect(() => {
      if (isRecording) {
        timerRef.current = setInterval(() => {
          recordingTimeRef.current += 1;
          setRecordingTime(recordingTimeRef.current);
        }, 1000);
      } else {
        clearInterval(timerRef.current);
        timerRef.current = null;
        setRecordingTime(0);
        // recordingTimeRef.current is intentionally NOT reset here
        // so that onstop (which fires after setIsRecording(false)) can still read it
      }
      return () => clearInterval(timerRef.current);
    }, [isRecording]);

    const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

    // ── Start / Stop recording ─────────────────────────────────────────────
    const startRecording = async () => {
      if (pendingAudio) { showError('Save or discard the current recording first'); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
        });
        streamRef.current = stream;

        const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', '']
          .find(t => !t || MediaRecorder.isTypeSupported(t)) || '';
        const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
        mediaRecorderRef.current = mr;
        audioChunksRef.current = [];

        // Snapshot folder and reset duration ref BEFORE async onstop fires
        const folderSnap = currentFolder;
        recordingTimeRef.current = 0;

        mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
        mr.onstop = () => {
          const duration = recordingTimeRef.current; // accurate because ref, not state
          const blob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' });
          stream.getTracks().forEach(t => t.stop());
          streamRef.current = null;
          setPendingAudio({ blob, folder: folderSnap, duration });
          setPendingName(`Recording ${new Date().toLocaleTimeString()}`);
        };

        mr.start(1000); // collect chunks every 1s so nothing is lost on stop
        setIsRecording(true);
      } catch (_) {
        showError('Microphone access denied or unavailable');
      }
    };

    const stopRecording = () => {
      if (mediaRecorderRef.current && isRecording) {
        mediaRecorderRef.current.stop();
        setIsRecording(false);
        // onstop fires asynchronously after this — see timer effect comment above
      }
    };

    // ── Save / discard pending ─────────────────────────────────────────────
    const savePending = async () => {
      if (!pendingAudio) return;
      const name = pendingName.trim() || `Recording ${new Date().toLocaleTimeString()}`;
      const id   = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      try {
        await saveBlob(id, pendingAudio.blob);
      } catch (e) {
        showError('Failed to save audio: ' + e.message);
        return;
      }
      setRecordings(prev => [...prev, {
        id, name,
        folder:    pendingAudio.folder,
        timestamp: Date.now(),
        duration:  pendingAudio.duration,
        size:      pendingAudio.blob.size,
      }]);
      setPendingAudio(null);
      setPendingName('');
    };

    const discardPending = () => { setPendingAudio(null); setPendingName(''); };

    // ── Playback ───────────────────────────────────────────────────────────
    const mediaErrorText = (code) => ({
      1: 'aborted',
      2: 'network',
      3: 'decode error — file may be corrupt',
      4: 'source not supported (CSP may be blocking blob/data URLs)',
    }[code] || `error ${code}`);

    const togglePlay = async (id) => {
      // Stop any current playback
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        const prev = currentAudioRef.current;
        currentAudioRef.current = null;
        if (prev._url) URL.revokeObjectURL(prev._url);
        if (playingId === id) { setPlayingId(null); return; } // toggle off
        setPlayingId(null);
      }
      try {
        const blob = await loadBlob(id);
        if (!blob) { showError('Audio data not found — may have been cleared'); return; }
        const url   = URL.createObjectURL(blob);
        const audio = new Audio();
        audio._url  = url;
        currentAudioRef.current = audio;
        setPlayingId(id);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (currentAudioRef.current === audio) currentAudioRef.current = null;
          setPlayingId(p => p === id ? null : p);
        };
        audio.onerror = () => {
          const code = audio.error ? audio.error.code : 0;
          URL.revokeObjectURL(url);
          if (currentAudioRef.current === audio) currentAudioRef.current = null;
          setPlayingId(p => p === id ? null : p);
          showError('Playback failed: ' + mediaErrorText(code));
        };
        audio.src = url;
        try {
          await audio.play();
        } catch (e) {
          showError('Playback rejected: ' + (e.message || e.name || 'unknown'));
        }
      } catch (e) {
        showError('Playback error: ' + e.message);
      }
    };

    // ── Delete (two-click confirm) ─────────────────────────────────────────
    const handleDelete = (id) => {
      if (confirmDeleteId === id) {
        removeBlob(id);
        setRecordings(prev => prev.filter(r => r.id !== id));
        if (playingId === id && currentAudioRef.current) {
          currentAudioRef.current.pause();
          if (currentAudioRef.current._url) URL.revokeObjectURL(currentAudioRef.current._url);
          currentAudioRef.current = null;
          setPlayingId(null);
        }
        setConfirmDeleteId(null);
      } else {
        setConfirmDeleteId(id);
        setTimeout(() => setConfirmDeleteId(c => c === id ? null : c), 3000);
      }
    };

    // ── Rename (double-click on name) ──────────────────────────────────────
    const startRename  = (rec) => { setRenamingId(rec.id); setRenameValue(rec.name); };
    const commitRename = () => {
      if (renameValue.trim()) {
        setRecordings(prev => prev.map(r =>
          r.id === renamingId ? { ...r, name: renameValue.trim() } : r
        ));
      }
      setRenamingId(null);
    };

    // ── Folders ────────────────────────────────────────────────────────────
    const createFolder = () => {
      const name = newFolderName.trim();
      if (!name) return;
      if (folders.includes(name)) { showError('Folder already exists'); return; }
      setFolders(prev => [...prev, name]);
      setNewFolderName('');
      setShowNewFolder(false);
    };

    const deleteFolder = (name) => {
      if (name === 'Root') return;
      setRecordings(prev => prev.map(r => r.folder === name ? { ...r, folder: 'Root' } : r));
      setFolders(prev => prev.filter(f => f !== name));
      if (currentFolder === name) setCurrentFolder('Root');
    };

    const moveToFolder = (id, folder) => {
      setRecordings(prev => prev.map(r => r.id === id ? { ...r, folder } : r));
    };

    // ── Export ─────────────────────────────────────────────────────────────
    const exportRec = async (rec) => {
      try {
        const blob = await loadBlob(rec.id);
        if (!blob) { showError('Audio not found'); return; }
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = `${rec.name}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (_) { showError('Export failed'); }
    };

    // ── Derived ────────────────────────────────────────────────────────────
    const visible = recordings
      .filter(r => r.folder === currentFolder)
      .sort((a, b) => b.timestamp - a.timestamp);

    // ── Shared style snippets ──────────────────────────────────────────────
    const row = { display: 'flex', alignItems: 'center' };
    const col = { display: 'flex', flexDirection: 'column' };

    // ── Render ─────────────────────────────────────────────────────────────
    return (
      <div style={{ ...col, height: '100%', gap: 4, padding: '4px 6px', background: 'var(--bg)', overflow: 'hidden' }}>

        {/* Error Banner */}
        {errorMsg && (
          <div style={{ flexShrink: 0, background: 'rgba(255,107,107,0.12)', border: '1px solid var(--danger)', borderRadius: 3, padding: '3px 8px', fontSize: 9, color: 'var(--danger)' }}>
            ! {errorMsg}
          </div>
        )}

        {/* Header */}
        <div style={{ ...row, justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div className="p-label" style={{ fontSize: 9 }}>VOICE RECORDER</div>
            <div style={{ fontSize: 8, color: 'var(--fg-dim)' }}>
              {currentFolder} &middot; {visible.length} recording{visible.length !== 1 ? 's' : ''}
            </div>
          </div>
          <button className="p-btn" style={{ fontSize: 8, padding: '1px 6px' }}
            onClick={() => setShowNewFolder(v => !v)}>
            + FOLDER
          </button>
        </div>

        {/* Folder Tabs */}
        <div style={{ flexShrink: 0, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 5px', maxHeight: 54, overflowY: 'auto' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {folders.map(f => (
              <div key={f} style={{
                ...row, gap: 3, cursor: 'pointer', fontSize: 8, borderRadius: 2, padding: '1px 5px',
                background:   currentFolder === f ? 'var(--border)' : 'transparent',
                border:       currentFolder === f ? '1px solid var(--accent)' : '1px solid transparent',
              }} onClick={() => setCurrentFolder(f)}>
                {f}
                {f !== 'Root' && (
                  <span style={{ color: 'var(--danger)', marginLeft: 3, lineHeight: 1 }}
                    onClick={e => { e.stopPropagation(); deleteFolder(f); }}>
                    &times;
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* New Folder Input */}
        {showNewFolder && (
          <div style={{ ...row, gap: 4, flexShrink: 0 }}>
            <input className="p-input" placeholder="Folder name" value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createFolder()}
              style={{ flex: 1, fontSize: 9 }} autoFocus />
            <button className="p-btn" style={{ fontSize: 8, padding: '2px 8px' }} onClick={createFolder}>
              CREATE
            </button>
            <button className="p-btn" style={{ fontSize: 8, padding: '2px 5px' }}
              onClick={() => setShowNewFolder(false)}>
              &times;
            </button>
          </div>
        )}

        {/* Pending Recording — name it before saving */}
        {pendingAudio && (
          <div style={{ flexShrink: 0, background: 'rgba(var(--accent-rgb), 0.08)', border: '1px solid var(--accent)', borderRadius: 3, padding: '5px 7px', ...col, gap: 4 }}>
            <div style={{ fontSize: 8, color: 'var(--accent)' }}>
              SAVE RECORDING &mdash; {fmt(pendingAudio.duration)} &mdash; folder: {pendingAudio.folder}
            </div>
            <div style={{ ...row, gap: 4 }}>
              <input className="p-input" placeholder="Name this recording..."
                value={pendingName} onChange={e => setPendingName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && savePending()}
                style={{ flex: 1, fontSize: 9 }} autoFocus />
              <button className="p-btn"
                style={{ fontSize: 8, padding: '2px 8px', borderColor: 'var(--accent)', color: 'var(--accent)' }}
                onClick={savePending}>
                SAVE
              </button>
              <button className="p-btn"
                style={{ fontSize: 8, padding: '2px 5px', borderColor: 'var(--danger)', color: 'var(--danger)' }}
                onClick={discardPending}>
                &times;
              </button>
            </div>
          </div>
        )}

        {/* Recordings List */}
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 5px' }}>
          {visible.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--fg-dim)', padding: '20px 8px', fontSize: 9 }}>
              No recordings in this folder.<br />Press RECORD to start.
            </div>
          ) : visible.map(rec => (
            <div key={rec.id} style={{
              ...row, gap: 5, padding: '3px 4px', borderBottom: '1px solid var(--border)',
              background: playingId === rec.id ? 'rgba(var(--accent-rgb), 0.1)' : 'transparent',
            }}>
              {/* Name + date */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {renamingId === rec.id ? (
                  <input className="p-input" value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null); }}
                    onBlur={commitRename}
                    style={{ fontSize: 9, width: '100%' }} autoFocus />
                ) : (
                  <div
                    style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                    onDoubleClick={() => startRename(rec)}
                    title="Double-click to rename">
                    {rec.name}
                  </div>
                )}
                <div style={{ fontSize: 7, color: 'var(--fg-dim)' }}>
                  {new Date(rec.timestamp).toLocaleDateString()} &middot; {fmt(rec.duration)} &middot; {(rec.size / 1024).toFixed(0)}KB
                </div>
              </div>

              {/* Controls */}
              <div style={{ ...row, gap: 2, flexShrink: 0 }}>
                {/* Play / Stop */}
                <button className="p-btn"
                  style={{ padding: '1px 5px', fontSize: 9, ...(playingId === rec.id ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {}) }}
                  onClick={() => togglePlay(rec.id)}>
                  {playingId === rec.id ? '■' : '▶'}
                </button>

                {/* Export */}
                <button className="p-btn" style={{ padding: '1px 5px', fontSize: 9 }}
                  onClick={() => exportRec(rec)} title="Download .webm">
                  &darr;
                </button>

                {/* Move to folder */}
                <select className="p-input"
                  style={{ fontSize: 7, padding: '0 2px', width: 62 }}
                  value={rec.folder}
                  onChange={e => moveToFolder(rec.id, e.target.value)}>
                  {folders.map(f => <option key={f} value={f}>{f}</option>)}
                </select>

                {/* Delete (two-click) */}
                <button className="p-btn"
                  style={{
                    padding: '1px 5px',
                    fontSize: confirmDeleteId === rec.id ? 7 : 10,
                    color:       confirmDeleteId === rec.id ? 'var(--danger)' : undefined,
                    borderColor: confirmDeleteId === rec.id ? 'var(--danger)' : undefined,
                  }}
                  onClick={() => handleDelete(rec.id)}>
                  {confirmDeleteId === rec.id ? 'DEL?' : '×'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Record Controls */}
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <div style={{ ...row, justifyContent: 'center' }}>
            {!isRecording ? (
              <button className="p-btn"
                style={{ padding: '5px 18px', fontSize: 11, background: 'rgba(255,107,107,0.15)', borderColor: 'var(--danger)', color: 'var(--danger)', fontWeight: 600, opacity: pendingAudio ? 0.45 : 1 }}
                onClick={startRecording}
                disabled={!!pendingAudio}>
                &#9679; RECORD
              </button>
            ) : (
              <button className="p-btn"
                style={{ padding: '5px 18px', fontSize: 11, background: 'var(--border)', borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }}
                onClick={stopRecording}>
                &#9632; STOP {fmt(recordingTime)}
              </button>
            )}
          </div>
          <div style={{ fontSize: 7, color: 'var(--fg-dim)', marginTop: 2 }}>
            {isRecording ? 'RECORDING...' : pendingAudio ? 'Name and save your recording above' : 'Click to start recording'}
          </div>
        </div>
      </div>
    );
  },
};
