const STORAGE_KEY = 'plugin:invoice-ocr:state:v1';

export default {
  id: 'invoice-ocr',
  name: 'Invoice OCR',
  width: 3,
  height: 4,
  component: ({ React, useState, useEffect, useRef, useCallback }) => {
    const [persist, setPersist] = useState(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : { lastText: '', lastPath: null, recent: [] };
      } catch {
        return { lastText: '', lastPath: null, recent: [] };
      }
    });

    useEffect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
      } catch {}
    }, [persist]);

    const [imagePath, setImagePath] = useState(null);
    const [imageBase64, setImageBase64] = useState(null);
    const [imageName, setImageName] = useState('');
    const [ocrText, setOcrText] = useState(persist.lastText || '');
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState('Ready — select a photo');
    const [error, setError] = useState(null);
    const [tesseractReady, setTesseractReady] = useState(false);

    const loadRecentNotes = useCallback(async () => {
      try {
        const allNotes = await window.dashboard.notes.list();
        const invoiceNotes = allNotes
          .filter(n => n.path.startsWith('invoices/'))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 4);
        setPersist(p => ({ ...p, recent: invoiceNotes }));
      } catch (e) {
        // silent
      }
    }, []);

    useEffect(() => {
      loadRecentNotes();
    }, [loadRecentNotes]);

    // Cleanup any lingering Tesseract worker (defensive)
    useEffect(() => {
      return () => {
        if (window.Tesseract && window.Tesseract.terminate) {
          try { window.Tesseract.terminate(); } catch {}
        }
      };
    }, []);

    const selectPhoto = async () => {
      setError(null);
      setStatus('Opening file picker...');
      try {
        const path = await window.dashboard.dialog.openFile({
          title: 'Choose invoice photo',
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }
          ]
        });
        if (!path) {
          setStatus('Ready — select a photo');
          return;
        }
        const base64 = await window.dashboard.fs.read(path, 'base64');
        const name = path.split(/[\\/]/).pop();
        setImagePath(path);
        setImageBase64(base64);
        setImageName(name);
        setOcrText('');
        setProgress(0);
        setStatus('Photo loaded — click RUN OCR');
      } catch (e) {
        setError('Could not load image: ' + (e.message || e));
        setStatus('Error loading photo');
      }
    };

    const clearEverything = () => {
      setImagePath(null);
      setImageBase64(null);
      setImageName('');
      setOcrText('');
      setProgress(0);
      setError(null);
      setStatus('Ready — select a photo');
    };

    const runOCR = async () => {
      if (!imageBase64 || isProcessing) return;

      setIsProcessing(true);
      setError(null);
      setProgress(0);
      setStatus('Loading OCR engine...');

      try {
        if (!window.Tesseract) {
          throw new Error('Tesseract.js not loaded — check renderer/index.html');
        }
        setTesseractReady(true);

        setStatus('Running OCR (first run downloads ~10 MB lang data)...');
        const dataUrl = `data:image/*;base64,${imageBase64}`;

        // Point worker + WASM core at locally-bundled files (CSP blocks CDN imports).
        // Lang data still streams from the project CDN — allowed by connect-src https:.
        const baseUrl = new URL('../node_modules/', window.location.href).href;
        const workerPath = baseUrl + 'tesseract.js/dist/worker.min.js';
        const corePath = baseUrl + 'tesseract.js-core';

        const result = await window.Tesseract.recognize(
          dataUrl,
          'eng',
          {
            workerPath,
            corePath,
            workerBlobURL: false,
            langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast_int',
            logger: (msg) => {
              if (msg.status === 'recognizing text') {
                const pct = Math.round((msg.progress || 0) * 100);
                setProgress(pct);
                setStatus(`Recognizing text… ${pct}%`);
              } else if (msg.status) {
                setStatus(msg.status);
              }
            }
          }
        );

        const extracted = (result.data.text || '').trim();
        const confidence = result.data.confidence || 0;

        setOcrText(extracted);
        setPersist(p => ({ ...p, lastText: extracted }));
        setProgress(100);
        setStatus(`Done — ${confidence.toFixed(0)}% confidence`);

      } catch (e) {
        setError('OCR failed: ' + (e.message || String(e)));
        setStatus('OCR error');
      } finally {
        setIsProcessing(false);
      }
    };

    const generateMarkdown = (raw, origName, detectedVendor) => {
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      let dateStr = '';
      let invNum = '';
      let totalStr = '';
      const items = [];

      for (const line of lines) {
        if (!dateStr) {
          const dm = line.match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})|((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
          if (dm) dateStr = dm[0];
        }
        if (!invNum) {
          const im = line.match(/(?:invoice|inv|no\.?|#)\s*[:#]?\s*([A-Z0-9-]{4,20})/i);
          if (im) invNum = im[1];
        }
        if (!totalStr) {
          const tm = line.match(/(?:total|amount due|balance due|grand total)[:\s]*\$?\s*([\d,]+\.?\d{0,2})/i);
          if (tm) totalStr = tm[1];
        }
        // crude line-item detection
        const imatch = line.match(/^(.{8,60}?)\s+([\d,]+\.?\d{0,2})\s*$/);
        if (imatch && !/total|subtotal|tax|shipping/i.test(line)) {
          items.push({ desc: imatch[1].trim(), amt: imatch[2] });
        }
      }

      let md = `# Invoice — ${detectedVendor}\n\n`;
      md += `**Photo:** ${origName || 'unknown.jpg'}\n`;
      if (dateStr) md += `**Date:** ${dateStr}\n`;
      if (invNum) md += `**Invoice #:** ${invNum}\n`;
      if (totalStr) md += `**Total:** $${totalStr}\n\n`;

      if (items.length > 0) {
        md += `## Line Items\n\n| Description | Amount |\n|-------------|--------|\n`;
        items.slice(0, 10).forEach(it => {
          md += `| ${it.desc} | $${it.amt} |\n`;
        });
        md += `\n`;
      }

      md += `## Raw OCR Output\n\n\`\`\`\n${raw}\n\`\`\`\n\n`;
      md += `*Created by Dashboard Invoice OCR • ${new Date().toLocaleString()}*`;
      return md;
    };

    const saveToNotes = async () => {
      if (!ocrText.trim()) {
        setError('No extracted text to save');
        return;
      }
      setError(null);
      setStatus('Saving to Notes...');

      try {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
        let vendor = 'Unknown-Vendor';

        for (const line of lines.slice(0, 6)) {
          if (/inc|corp|llc|ltd|company|enterprises|services|supply/i.test(line) && line.length > 4 && line.length < 50) {
            vendor = line.replace(/[^a-z0-9\s-]/gi, ' ').trim().replace(/\s+/g, ' ').slice(0, 28);
            break;
          }
        }
        if (vendor === 'Unknown-Vendor' && lines[0]) {
          vendor = lines[0].replace(/[^a-z0-9\s-]/gi, ' ').trim().slice(0, 25) || 'Invoice';
        }

        const safe = vendor.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const relPath = `invoices/INV-${today}-${safe}.md`;

        const markdown = generateMarkdown(ocrText, imageName, vendor);
        await window.dashboard.notes.write(relPath, markdown);

        setPersist(p => ({ ...p, lastPath: relPath }));
        setStatus(`Saved → ${relPath}`);

        await loadRecentNotes();

        // friendly confirmation without alert
        setTimeout(() => {
          if (!error) setStatus('Saved successfully — open Notes folder to view');
        }, 1200);
      } catch (e) {
        setError('Failed to save note: ' + (e.message || e));
        setStatus('Save failed');
      }
    };

    const openNotesFolder = async () => {
      try {
        await window.dashboard.notes.openFolder();
      } catch (e) {
        setError('Could not open Notes folder: ' + e.message);
      }
    };

    return React.createElement('div', {
      className: 'p-col',
      style: {
        height: '100%',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 8,
        gap: 8,
        overflow: 'hidden',
        fontFamily: 'var(--mono)'
      }
    },
      // Header
      React.createElement('div', {
        className: 'p-row',
        style: { justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          React.createElement('span', { className: 'p-accent', style: { fontSize: 13, fontWeight: 600 } }, '📄 INVOICE OCR'),
          React.createElement('span', { className: 'p-dim', style: { fontSize: 9 } }, `[${status}]`)
        ),
        React.createElement('div', { className: 'p-row', style: { gap: 4 } },
          React.createElement('button', {
            className: 'p-btn',
            onClick: selectPhoto,
            disabled: isProcessing,
            style: { fontSize: 10 }
          }, 'Select Photo'),
          React.createElement('button', {
            className: 'p-btn',
            onClick: clearEverything,
            disabled: isProcessing || !imagePath,
            style: { fontSize: 10 }
          }, 'Clear')
        )
      ),

      // Main content area
      React.createElement('div', {
        style: {
          flex: 1,
          display: 'flex',
          gap: 8,
          minHeight: 0,
          overflow: 'hidden'
        }
      },
        // Image preview pane
        React.createElement('div', {
          className: 'p-col',
          style: {
            flex: 1,
            minWidth: 110,
            background: '#0a120a',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 6,
            overflow: 'hidden'
          }
        },
          React.createElement('div', { className: 'p-label', style: { marginBottom: 4, fontSize: 9 } }, 'PREVIEW'),
          imageBase64
            ? React.createElement('img', {
                src: `data:image/*;base64,${imageBase64}`,
                style: { maxWidth: '100%', maxHeight: 'calc(100% - 22px)', objectFit: 'contain', borderRadius: 2, display: 'block' },
                alt: 'Invoice preview'
              })
            : React.createElement('div', {
                style: {
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--fg-dim)',
                  fontSize: 10,
                  textAlign: 'center'
                }
              }, 'No photo selected\nClick "Select Photo" above'),
          imageName && React.createElement('div', {
            className: 'p-dim',
            style: { fontSize: 8, marginTop: 4, textAlign: 'center', wordBreak: 'break-all' }
          }, imageName)
        ),

        // Extracted text pane
        React.createElement('div', {
          className: 'p-col',
          style: {
            flex: 1.15,
            minWidth: 130,
            background: '#0a120a',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 6,
            overflow: 'hidden'
          }
        },
          React.createElement('div', {
            className: 'p-row',
            style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }
          },
            React.createElement('div', { className: 'p-label', style: { fontSize: 9 } }, 'EXTRACTED TEXT'),
            progress > 0 && progress < 100 && React.createElement('div', {
              style: { fontSize: 9, color: 'var(--accent)' }
            }, `${progress}%`)
          ),
          React.createElement('textarea', {
            className: 'p-input',
            style: {
              flex: 1,
              fontSize: 10,
              lineHeight: 1.35,
              resize: 'none',
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border-bright)'
            },
            value: ocrText,
            onChange: (e) => setOcrText(e.target.value),
            placeholder: 'OCR text will appear here after processing...',
            spellCheck: false
          })
        )
      ),

      // Progress bar
      isProcessing && React.createElement('div', {
        style: {
          height: 3,
          background: 'var(--border)',
          borderRadius: 2,
          overflow: 'hidden',
          flexShrink: 0
        }
      },
        React.createElement('div', {
          style: {
            height: '100%',
            width: `${progress}%`,
            background: 'var(--accent)',
            transition: 'width 120ms linear'
          }
        })
      ),

      // Action row
      React.createElement('div', {
        className: 'p-row',
        style: { gap: 6, flexShrink: 0, flexWrap: 'wrap' }
      },
        React.createElement('button', {
          className: 'p-btn',
          onClick: runOCR,
          disabled: !imageBase64 || isProcessing,
          style: { flex: 1, minWidth: 110, fontSize: 11 }
        }, isProcessing ? 'PROCESSING…' : '▶ RUN OCR'),

        React.createElement('button', {
          className: 'p-btn',
          onClick: saveToNotes,
          disabled: !ocrText.trim() || isProcessing,
          style: {
            flex: 1,
            minWidth: 130,
            fontSize: 11,
            background: 'var(--accent)',
            color: 'var(--bg)',
            borderColor: 'var(--accent)'
          }
        }, '💾 SAVE AS MARKDOWN'),

        React.createElement('button', {
          className: 'p-btn',
          onClick: openNotesFolder,
          style: { minWidth: 70, fontSize: 10 }
        }, '📁 Notes')
      ),

      // Error banner
      error && React.createElement('div', {
        style: {
          padding: '3px 8px',
          background: 'rgba(255, 107, 107, 0.12)',
          border: '1px solid var(--danger)',
          borderRadius: 3,
          fontSize: 9,
          color: 'var(--danger)',
          flexShrink: 0
        }
      }, '! ' + error),

      // Recent invoices
      persist.recent && persist.recent.length > 0 && React.createElement('div', {
        style: { fontSize: 8, color: 'var(--fg-dim)', flexShrink: 0 }
      },
        'Recent: ',
        persist.recent.map((note, idx) =>
          React.createElement('span', {
            key: idx,
            style: { marginRight: 6, cursor: 'pointer', textDecoration: 'underline' },
            onClick: () => window.dashboard.shell.open(note.path) // best effort
          }, note.path.split('/').pop().replace('.md', ''))
        )
      ),

      // Footer
      React.createElement('div', {
        className: 'p-dim',
        style: { fontSize: 7, textAlign: 'center', marginTop: 'auto', flexShrink: 0, opacity: 0.6 }
      }, '100% local • Tesseract.js • Edit text before saving • No cloud upload')
    );
  }
};
