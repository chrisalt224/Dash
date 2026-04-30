// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

const PLUGIN_ID = 'payroll';
const HOURS_KEY_V1 = `plugin:${PLUGIN_ID}:hours:v1`;
const HOURS_KEY = `plugin:${PLUGIN_ID}:hours:v2`;
const DATES_KEY = `plugin:${PLUGIN_ID}:dates:v1`;
const LOGO_KEY = `plugin:${PLUGIN_ID}:logo:v1`;
const EMPLOYEES_KEY = `plugin:${PLUGIN_ID}:employees:v1`;

const TERM_BG = () => _cv('--bg', '#0a0e0a');
const TERM_BG_ALT = () => 'rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.08)';
const TERM_BORDER = () => _cv('--border', '#1f2a1f');
const TERM_BORDER_BRIGHT = () => _cv('--border-bright', '#2f4a2f');
const TERM_GREEN = () => _cv('--accent', '#39ff14');
const TERM_GREEN_DIM = () => _cv('--fg-dim', '#6f9a6f');
const TERM_GREEN_BRIGHT = () => _cv('--fg-bright', '#9cff9c');
const TERM_AMBER = () => _cv('--accent-warm', '#ffb454');
const TERM_DANGER = () => _cv('--danger', '#ff6b6b');

const slugId = (name) =>
  'emp_' +
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const randId = () => 'emp_' + Math.random().toString(36).slice(2, 10);

const DEFAULT_EMPLOYEES = [
  { name: 'Christopher Altomare', type: 'salary', rate: 900.0 },
  { name: 'John Hansel', type: 'salary', rate: 900.0 },
  { name: 'Phil Konrad', type: 'hourly', rate: 22.0, overtimeRate: 33.0 },
  { name: 'Bella Walters', type: 'hourly', rate: 10.0, overtimeRate: 15.0 },
  { name: 'Shammah Hill', type: 'hourly', rate: 10.0, overtimeRate: 15.0 },
  { name: 'Danielle Hollidge', type: 'hourly', rate: 10.0, overtimeRate: 15.0 },
  { name: 'Lenny Walters', type: 'hourly', rate: 10.0, overtimeRate: 15.0 },
  { name: 'Hayden Dugan', type: 'hourly', rate: 8.0, overtimeRate: 12.0 },
  { name: 'Robert Moser', type: 'hourly', rate: 7.0, overtimeRate: 10.5 },
  { name: 'Jason Lagana', type: 'hourly', rate: 6.0, overtimeRate: 9.0 },
  { name: 'Sam Wilkinskey', type: 'hourly', rate: 8.0, overtimeRate: 12.0 },
  { name: 'Sergio Guerra Leon', type: 'daily', rate: 215.0 },
  { name: 'Ludin Fuentes', type: 'daily', rate: 175.0 },
  { name: 'Ernesto Guerra', type: 'daily', rate: 165.0 },
  { name: 'Maria Guerra', type: 'daily', rate: 145.0 },
].map((e) => ({ ...e, id: slugId(e.name) }));

const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const loadEmployees = () => {
  const stored = loadJSON(EMPLOYEES_KEY, null);
  if (Array.isArray(stored) && stored.length) {
    return stored.map((e) => ({
      id: e.id || slugId(e.name) || randId(),
      name: e.name || 'Unnamed',
      type: e.type || 'hourly',
      rate: Number(e.rate) || 0,
      ...(e.overtimeRate != null ? { overtimeRate: Number(e.overtimeRate) } : {}),
    }));
  }
  return DEFAULT_EMPLOYEES.map((e) => ({ ...e }));
};

const loadHoursWithMigration = (employees) => {
  const v2 = loadJSON(HOURS_KEY, null);
  if (v2 && typeof v2 === 'object') return v2;
  const v1 = loadJSON(HOURS_KEY_V1, null);
  if (v1 && typeof v1 === 'object') {
    const migrated = {};
    employees.forEach((e) => {
      if (v1[e.name] != null) migrated[e.id] = v1[e.name];
    });
    return migrated;
  }
  return {};
};

const calculateRow = (emp, hours) => {
  let total = 0;
  let overtimePay = 0;
  let overtimeHours = 0;
  if (emp.type === 'hourly') {
    const ot = emp.overtimeRate != null ? Number(emp.overtimeRate) : Number(emp.rate) * 1.5;
    const regular = Math.min(hours, 40);
    overtimeHours = Math.max(hours - 40, 0);
    total = regular * Number(emp.rate) + overtimeHours * ot;
    overtimePay = overtimeHours * ot;
  } else if (emp.type === 'daily') {
    total = hours * Number(emp.rate);
  } else if (emp.type === 'salary') {
    total = Number(emp.rate);
  }
  return { total, overtimePay, overtimeHours };
};

const offsetDates = (start, end) => {
  const sd = new Date(start);
  const ed = new Date(end);
  const ds = new Date(sd);
  ds.setDate(sd.getDate() + 1);
  const de = new Date(ed);
  de.setDate(ed.getDate() + 1);
  return { ds, de, sd, ed };
};

const downloadFile = (content, fileName, mimeType) => {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

export default {
  id: PLUGIN_ID,
  name: "Tony's Payroll",
  width: 3,
  height: 5,
  component: ({ React, useState, useEffect, useMemo, useRef }) => {
    const [employees, setEmployees] = useState(() => loadEmployees());
    const [hours, setHours] = useState(() => loadHoursWithMigration(loadEmployees()));
    const [dates, setDates] = useState(() => loadJSON(DATES_KEY, { start: '', end: '' }));
    const [logo, setLogo] = useState(() => localStorage.getItem(LOGO_KEY) || '');
    const [payrollData, setPayrollData] = useState(null);
    const [error, setError] = useState(null);
    const [toast, setToast] = useState(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const [confirmRemoveId, setConfirmRemoveId] = useState(null);
    const [confirmDefaults, setConfirmDefaults] = useState(false);
    const [cursorOn, setCursorOn] = useState(true);
    const [view, setView] = useState('payroll');
    const [draft, setDraft] = useState({ name: '', type: 'hourly', rate: '', overtimeRate: '' });

    const errorTimerRef = useRef(null);
    const toastTimerRef = useRef(null);
    const resetTimerRef = useRef(null);
    const removeTimerRef = useRef(null);
    const defaultsTimerRef = useRef(null);
    const fileInputRef = useRef(null);
    const payrollRef = useRef(payrollData);
    const logoRef = useRef(logo);

    useEffect(() => { payrollRef.current = payrollData; }, [payrollData]);
    useEffect(() => { logoRef.current = logo; }, [logo]);

    useEffect(() => { localStorage.setItem(EMPLOYEES_KEY, JSON.stringify(employees)); }, [employees]);
    useEffect(() => { localStorage.setItem(HOURS_KEY, JSON.stringify(hours)); }, [hours]);
    useEffect(() => { localStorage.setItem(DATES_KEY, JSON.stringify(dates)); }, [dates]);
    useEffect(() => {
      if (logo) localStorage.setItem(LOGO_KEY, logo);
      else localStorage.removeItem(LOGO_KEY);
    }, [logo]);

    useEffect(() => {
      const id = setInterval(() => setCursorOn((c) => !c), 530);
      return () => clearInterval(id);
    }, []);

    const showError = (msg) => {
      setError(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setError(null), 4000);
    };
    const showToast = (msg) => {
      setToast(msg);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToast(null), 2200);
    };

    const liveTotals = useMemo(() => {
      const rows = {};
      let grand = 0;
      employees.forEach((emp) => {
        const h = parseFloat(hours[emp.id]) || 0;
        const r = calculateRow(emp, h);
        rows[emp.id] = r;
        if (h > 0 || emp.type === 'salary') grand += r.total;
      });
      return { rows, grand };
    }, [hours, employees]);

    const setHoursFor = (id, val) => setHours((prev) => ({ ...prev, [id]: val }));

    const calculatePayroll = () => {
      if (!dates.start || !dates.end) {
        showError('Select both start and end date');
        return;
      }
      const sd = new Date(dates.start);
      const ed = new Date(dates.end);
      if (ed < sd) {
        showError('End date must be after start date');
        return;
      }
      let total = 0;
      const rows = [];
      employees.forEach((emp) => {
        const h = parseFloat(hours[emp.id]) || 0;
        const r = calculateRow(emp, h);
        if (h > 0 || emp.type === 'salary') {
          rows.push({
            name: emp.name,
            type: emp.type,
            rate: Number(emp.rate),
            hours: h,
            overtimePay: r.overtimePay,
            total: r.total,
          });
          total += r.total;
        }
      });
      setPayrollData({
        weekStart: dates.start,
        weekEnd: dates.end,
        employees: rows,
        totalPayroll: total,
      });
      showToast('Payroll calculated');
    };

    const requirePayroll = () => {
      if (!payrollRef.current) {
        showError('Calculate payroll first');
        return false;
      }
      return true;
    };

    const printPayroll = () => {
      if (!requirePayroll()) return;
      const data = payrollRef.current;
      const { ds, de } = offsetDates(data.weekStart, data.weekEnd);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const padding = 20;
      const lineHeight = 25;
      const columnWidths = [200, 100, 100, 120, 120, 150];
      const tableWidth = columnWidths.reduce((a, b) => a + b, 0);
      canvas.width = 816;
      canvas.height = 200 + data.employees.length * lineHeight + 100;

      const drawReport = (startY) => {
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'center';
        ctx.fillText("Tony's Pizza and Catering", canvas.width / 2, startY);
        ctx.font = '16px Arial';
        ctx.fillText(
          `Payroll Report for ${ds.toLocaleDateString()} - ${de.toLocaleDateString()}`,
          canvas.width / 2,
          startY + lineHeight,
        );

        const tableX = (canvas.width - tableWidth) / 2;
        let y = startY + lineHeight * 2;
        ctx.fillStyle = '#E63946';
        ctx.fillRect(tableX, y, tableWidth, lineHeight);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'left';
        const headers = ['Employee', 'Pay Type', 'Rate', 'Hours/Days', 'Overtime', 'Total Pay'];
        let xOff = tableX;
        headers.forEach((h, i) => {
          ctx.fillText(h, xOff + 5, y + lineHeight - 5);
          xOff += columnWidths[i];
        });

        ctx.font = '14px Arial';
        data.employees.forEach((emp, idx) => {
          y += lineHeight;
          ctx.fillStyle = idx % 2 === 0 ? '#F5F5F5' : '#FFFFFF';
          ctx.fillRect(tableX, y, tableWidth, lineHeight);
          ctx.fillStyle = '#000000';
          xOff = tableX;
          ctx.fillText(emp.name, xOff + 5, y + lineHeight - 5);
          xOff += columnWidths[0];
          ctx.fillText(emp.type, xOff + 5, y + lineHeight - 5);
          xOff += columnWidths[1];
          ctx.fillText(`$${emp.rate.toFixed(2)}`, xOff + 5, y + lineHeight - 5);
          xOff += columnWidths[2];
          ctx.fillText(
            `${emp.hours}${emp.type === 'hourly' ? ' hrs' : emp.type === 'daily' ? ' days' : ''}`,
            xOff + 5,
            y + lineHeight - 5,
          );
          xOff += columnWidths[3];
          ctx.fillText(`$${emp.overtimePay.toFixed(2)}`, xOff + 5, y + lineHeight - 5);
          xOff += columnWidths[4];
          ctx.fillText(`$${emp.total.toFixed(2)}`, xOff + 5, y + lineHeight - 5);
          ctx.strokeStyle = '#E0E0E0';
          ctx.strokeRect(tableX, y, tableWidth, lineHeight);
        });

        y += lineHeight * 2;
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(
          `Total Payroll: $${data.totalPayroll.toFixed(2)}`,
          canvas.width - padding,
          y,
        );

        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#666';
        ctx.fillText(
          `Generated on ${new Date().toLocaleString()}`,
          canvas.width / 2,
          y + lineHeight * 2,
        );
      };

      const finalize = () => {
        const dataUrl = canvas.toDataURL('image/png');
        const iframe = document.createElement('iframe');
        Object.assign(iframe.style, {
          position: 'fixed',
          right: '-9999px',
          bottom: '-9999px',
          width: '0',
          height: '0',
          border: '0',
        });
        document.body.appendChild(iframe);
        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(
          `<!DOCTYPE html><html><head><title>Payroll</title>` +
            `<style>@page{margin:0.5in}body{margin:0;font-family:Arial}img{width:100%;display:block}</style>` +
            `</head><body><img src="${dataUrl}"/></body></html>`,
        );
        doc.close();
        const img = doc.querySelector('img');
        const doPrint = () => {
          try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
          } catch (e) {
            showError('Print failed: ' + e.message);
          }
          setTimeout(() => {
            try { document.body.removeChild(iframe); } catch {}
          }, 1500);
        };
        if (img && img.complete) doPrint();
        else if (img) img.onload = doPrint;
        else doPrint();
      };

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const currentLogo = logoRef.current;
      if (currentLogo) {
        const img = new Image();
        img.onload = () => {
          const lw = 150;
          const lh = (img.height / img.width) * lw;
          ctx.drawImage(img, (canvas.width - lw) / 2, padding, lw, lh);
          drawReport(lh + padding * 2 + 10);
          finalize();
        };
        img.onerror = () => {
          drawReport(padding + 10);
          finalize();
        };
        img.src = currentLogo;
      } else {
        drawReport(padding + 10);
        finalize();
      }
    };

    const exportCSV = () => {
      if (!requirePayroll()) return;
      const data = payrollRef.current;
      const { ds, de } = offsetDates(data.weekStart, data.weekEnd);
      let csv = "Tony's Pizza and Catering Payroll\n";
      csv += `${ds.toLocaleDateString()} - ${de.toLocaleDateString()}\n`;
      csv += 'Employee,Pay Type,Rate,Hours/Days,Overtime,Total Pay\n';
      data.employees.forEach((emp) => {
        csv += [
          emp.name,
          emp.type,
          `$${emp.rate.toFixed(2)}`,
          emp.hours,
          `$${emp.overtimePay.toFixed(2)}`,
          `$${emp.total.toFixed(2)}`,
        ].join(',') + '\n';
      });
      csv += `\nTotal Payroll,,$${data.totalPayroll.toFixed(2)}`;
      const fileDate = new Date(data.weekStart).toISOString().split('T')[0];
      downloadFile(csv, `payroll_${fileDate}.csv`, 'text/csv');
      showToast('Exported CSV');
    };

    const exportTXT = () => {
      if (!requirePayroll()) return;
      const data = payrollRef.current;
      const { ds, de } = offsetDates(data.weekStart, data.weekEnd);
      let txt = `Tony's Pizza and Catering Payroll\n`;
      txt += `${ds.toLocaleDateString()} - ${de.toLocaleDateString()}\n\n`;
      data.employees.forEach((emp) => {
        txt += `${emp.name}\n`;
        txt += `Type: ${emp.type}\n`;
        txt += `Rate: $${emp.rate.toFixed(2)}\n`;
        txt += `Hours/Days: ${emp.hours}\n`;
        txt += `Overtime: $${emp.overtimePay.toFixed(2)}\n`;
        txt += `Total: $${emp.total.toFixed(2)}\n\n`;
      });
      txt += `Total Payroll: $${data.totalPayroll.toFixed(2)}`;
      const fileDate = new Date(data.weekStart).toISOString().split('T')[0];
      downloadFile(txt, `payroll_${fileDate}.txt`, 'text/plain');
      showToast('Exported TXT');
    };

    const exportHTML = () => {
      if (!requirePayroll()) return;
      const data = payrollRef.current;
      const { ds, de } = offsetDates(data.weekStart, data.weekEnd);
      const currentLogo = logoRef.current;
      let html = `<!DOCTYPE html><html><head><title>Tony's Pizza and Catering Payroll</title>`;
      html += `<style>body{font-family:Arial,sans-serif;margin:20px;background:#FFF;color:#000}`;
      html += `table{border-collapse:collapse;width:100%;margin:20px 0}`;
      html += `th,td{border:1px solid #E0E0E0;padding:8px;text-align:left}`;
      html += `th{background:#E63946;color:#FFF}h2{text-align:center}.logo{max-width:150px;display:block;margin:0 auto}h3{text-align:right}</style>`;
      html += `</head><body><h2>`;
      if (currentLogo) html += `<img src="${currentLogo}" class="logo" alt="Logo">`;
      html += `Tony's Pizza and Catering<br>Payroll Report for ${ds.toLocaleDateString()} - ${de.toLocaleDateString()}</h2>`;
      html += `<table><tr><th>Employee</th><th>Pay Type</th><th>Rate</th><th>Hours/Days</th><th>Overtime</th><th>Total Pay</th></tr>`;
      data.employees.forEach((emp) => {
        html += `<tr><td>${emp.name}</td><td>${emp.type}</td><td>$${emp.rate.toFixed(2)}</td>`;
        html += `<td>${emp.hours}</td><td>$${emp.overtimePay.toFixed(2)}</td><td>$${emp.total.toFixed(2)}</td></tr>`;
      });
      html += `</table><h3>Total Payroll: $${data.totalPayroll.toFixed(2)}</h3></body></html>`;
      const fileDate = new Date(data.weekStart).toISOString().split('T')[0];
      downloadFile(html, `payroll_${fileDate}.html`, 'text/html');
      showToast('Exported HTML');
    };

    const handleLogoUpload = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        setLogo(ev.target.result);
        showToast('Logo updated');
      };
      reader.onerror = () => showError('Failed to read logo');
      reader.readAsDataURL(file);
      e.target.value = '';
    };

    const handleClearLogo = () => {
      setLogo('');
      showToast('Logo cleared');
    };

    const handleResetClick = () => {
      if (confirmReset) {
        setHours({});
        setPayrollData(null);
        setConfirmReset(false);
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        showToast('Hours cleared');
        return;
      }
      setConfirmReset(true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setConfirmReset(false), 3000);
    };

    const updateEmployee = (id, patch) => {
      setEmployees((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e;
          const next = { ...e, ...patch };
          if (next.type === 'hourly' && (next.overtimeRate == null || next.overtimeRate === '')) {
            next.overtimeRate = Number(next.rate) * 1.5;
          }
          return next;
        }),
      );
    };

    const handleRemoveClick = (id) => {
      if (confirmRemoveId === id) {
        setEmployees((prev) => prev.filter((e) => e.id !== id));
        setHours((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setConfirmRemoveId(null);
        if (removeTimerRef.current) clearTimeout(removeTimerRef.current);
        showToast('Employee removed');
        return;
      }
      setConfirmRemoveId(id);
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current);
      removeTimerRef.current = setTimeout(() => setConfirmRemoveId(null), 3000);
    };

    const handleAddEmployee = () => {
      const name = (draft.name || '').trim();
      if (!name) {
        showError('Name required');
        return;
      }
      const rate = parseFloat(draft.rate);
      if (!isFinite(rate) || rate < 0) {
        showError('Valid rate required');
        return;
      }
      const id = randId();
      const next = { id, name, type: draft.type, rate };
      if (draft.type === 'hourly') {
        const ot = parseFloat(draft.overtimeRate);
        next.overtimeRate = isFinite(ot) && ot >= 0 ? ot : rate * 1.5;
      }
      setEmployees((prev) => [...prev, next]);
      setDraft({ name: '', type: 'hourly', rate: '', overtimeRate: '' });
      showToast('Employee added');
    };

    const handleRestoreDefaults = () => {
      if (confirmDefaults) {
        const fresh = DEFAULT_EMPLOYEES.map((e) => ({ ...e }));
        setEmployees(fresh);
        setConfirmDefaults(false);
        if (defaultsTimerRef.current) clearTimeout(defaultsTimerRef.current);
        showToast('Defaults restored');
        return;
      }
      setConfirmDefaults(true);
      if (defaultsTimerRef.current) clearTimeout(defaultsTimerRef.current);
      defaultsTimerRef.current = setTimeout(() => setConfirmDefaults(false), 3000);
    };

    const btnBase = {
      background: 'transparent',
      border: `1px solid ${TERM_BORDER_BRIGHT()}`,
      color: TERM_GREEN(),
      padding: '5px 10px',
      fontFamily: 'var(--mono)',
      fontSize: 11,
      cursor: 'pointer',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      borderRadius: 3,
      transition: 'all 0.15s ease',
      whiteSpace: 'nowrap',
    };

    const inputBase = {
      background: TERM_BG_ALT(),
      border: `1px solid ${TERM_BORDER_BRIGHT()}`,
      color: TERM_GREEN(),
      padding: '4px 6px',
      fontFamily: 'var(--mono)',
      fontSize: 11,
      borderRadius: 3,
      outline: 'none',
    };

    const tabBtn = (active) => ({
      ...btnBase,
      padding: '4px 10px',
      color: active ? TERM_GREEN_BRIGHT : TERM_GREEN_DIM(),
      borderColor: active ? TERM_GREEN_DIM : TERM_BORDER(),
      background: active ? 'rgba(var(--accent-rgb),0.06)' : 'transparent',
    });

    const thStyle = {
      textAlign: 'left',
      padding: '6px 8px',
      color: TERM_GREEN_DIM(),
      fontSize: 10,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      borderBottom: `1px solid ${TERM_BORDER_BRIGHT()}`,
      fontWeight: 600,
    };

    return (
      <div
        className="p-col"
        style={{
          height: '100%',
          background: TERM_BG(),
          color: TERM_GREEN(),
          fontFamily: 'var(--mono)',
          boxShadow: 'inset 0 0 24px var(--sunken-strong)',
          padding: 10,
          gap: 8,
          overflow: 'hidden',
          borderRadius: 4,
        }}
      >
        <div
          className="p-row"
          style={{
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: `1px solid ${TERM_BORDER()}`,
            paddingBottom: 6,
            flexWrap: 'wrap',
            gap: 6,
          }}
        >
          <div style={{ color: TERM_GREEN_DIM(), fontSize: 11 }}>
            <span style={{ color: TERM_GREEN_BRIGHT() }}>$</span> tony --{view}
          </div>
          <div className="p-row" style={{ gap: 4 }}>
            <button style={tabBtn(view === 'payroll')} onClick={() => setView('payroll')}>
              payroll
            </button>
            <button style={tabBtn(view === 'settings')} onClick={() => setView('settings')}>
              settings
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '4px 10px',
              color: TERM_DANGER(),
              border: `1px dashed ${TERM_DANGER()}`,
              borderRadius: 4,
              fontSize: 11,
            }}
          >
            ! {error}
          </div>
        )}

        {view === 'payroll' && (
          <>
            <div className="p-row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 10, color: TERM_GREEN_DIM(), letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                start
                <input
                  type="date"
                  value={dates.start}
                  onChange={(e) => setDates((d) => ({ ...d, start: e.target.value }))}
                  style={{ ...inputBase, marginLeft: 6, colorScheme: 'dark' }}
                />
              </label>
              <label style={{ fontSize: 10, color: TERM_GREEN_DIM(), letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                end
                <input
                  type="date"
                  value={dates.end}
                  onChange={(e) => setDates((d) => ({ ...d, end: e.target.value }))}
                  style={{ ...inputBase, marginLeft: 6, colorScheme: 'dark' }}
                />
              </label>
              <div style={{ flex: 1 }} />
              {logo ? (
                <img
                  src={logo}
                  alt="logo"
                  style={{
                    height: 28,
                    maxWidth: 80,
                    objectFit: 'contain',
                    border: `1px solid ${TERM_BORDER_BRIGHT()}`,
                    borderRadius: 3,
                    background: TERM_BG_ALT(),
                    padding: 2,
                  }}
                />
              ) : null}
            </div>

            <div className="p-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <button
                style={{ ...btnBase, color: TERM_GREEN_BRIGHT(), borderColor: TERM_GREEN_DIM() }}
                onClick={calculatePayroll}
              >
                ▸ calc
              </button>
              <button style={btnBase} onClick={printPayroll}>▸ print</button>
              <button style={btnBase} onClick={exportCSV}>▸ csv</button>
              <button style={btnBase} onClick={exportTXT}>▸ txt</button>
              <button style={btnBase} onClick={exportHTML}>▸ html</button>
              <div style={{ flex: 1 }} />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleLogoUpload}
              />
              <button style={btnBase} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                ▸ logo
              </button>
              {logo && (
                <button
                  style={{ ...btnBase, color: TERM_AMBER(), borderColor: TERM_AMBER() }}
                  onClick={handleClearLogo}
                  title="clear logo"
                >
                  ×
                </button>
              )}
              <button
                style={{
                  ...btnBase,
                  color: confirmReset ? TERM_DANGER : TERM_GREEN_DIM(),
                  borderColor: confirmReset ? TERM_DANGER : TERM_BORDER_BRIGHT(),
                }}
                onClick={handleResetClick}
                title="clear all hours"
              >
                {confirmReset ? '✓?' : 'reset'}
              </button>
            </div>

            <div
              style={{
                flex: 1,
                overflow: 'auto',
                border: `1px solid ${TERM_BORDER()}`,
                borderRadius: 4,
                background: 'var(--sunken)',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 480 }}>
                <thead>
                  <tr style={{ background: TERM_BG_ALT(), position: 'sticky', top: 0, zIndex: 1 }}>
                    {['name', 'type', 'rate', 'hrs/days', 'ot', 'total'].map((h) => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employees.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: 16, color: TERM_GREEN_DIM(), fontStyle: 'italic', textAlign: 'center' }}>
                        no employees — add some in settings
                      </td>
                    </tr>
                  )}
                  {employees.map((emp, idx) => {
                    const live = liveTotals.rows[emp.id] || { total: 0, overtimePay: 0 };
                    const h = parseFloat(hours[emp.id]) || 0;
                    const active = h > 0 || emp.type === 'salary';
                    const unit = emp.type === 'hourly' ? '/hr' : emp.type === 'daily' ? '/day' : '/wk';
                    return (
                      <tr
                        key={emp.id}
                        style={{
                          background: idx % 2 === 0 ? 'transparent' : 'rgba(var(--accent-rgb),0.025)',
                          opacity: active ? 1 : 0.55,
                        }}
                      >
                        <td style={{ padding: '4px 8px', color: TERM_GREEN(), whiteSpace: 'nowrap' }}>{emp.name}</td>
                        <td
                          style={{
                            padding: '4px 8px',
                            color:
                              emp.type === 'salary'
                                ? TERM_AMBER
                                : emp.type === 'daily'
                                ? TERM_GREEN_BRIGHT
                                : TERM_GREEN_DIM(),
                            fontSize: 10,
                            textTransform: 'uppercase',
                            letterSpacing: '0.1em',
                          }}
                        >
                          {emp.type}
                        </td>
                        <td style={{ padding: '4px 8px', color: TERM_GREEN_DIM(), whiteSpace: 'nowrap' }}>
                          ${Number(emp.rate).toFixed(2)}
                          <span style={{ opacity: 0.6 }}>{unit}</span>
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            type="number"
                            min="0"
                            step={emp.type === 'daily' ? '0.5' : '0.25'}
                            value={hours[emp.id] ?? ''}
                            onChange={(e) => setHoursFor(emp.id, e.target.value)}
                            placeholder={emp.type === 'salary' ? '—' : '0'}
                            style={{ ...inputBase, width: 64 }}
                          />
                        </td>
                        <td style={{ padding: '4px 8px', color: live.overtimePay > 0 ? TERM_AMBER : TERM_GREEN_DIM(), whiteSpace: 'nowrap' }}>
                          {live.overtimePay > 0 ? `$${live.overtimePay.toFixed(2)}` : '—'}
                        </td>
                        <td
                          style={{
                            padding: '4px 8px',
                            color: active ? TERM_GREEN_BRIGHT : TERM_GREEN_DIM(),
                            textShadow: active && live.total > 0 ? '0 0 6px rgba(var(--accent-rgb),0.45)' : 'none',
                            whiteSpace: 'nowrap',
                            fontWeight: 600,
                          }}
                        >
                          ${live.total.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div
              className="p-row"
              style={{
                justifyContent: 'space-between',
                alignItems: 'center',
                borderTop: `1px solid ${TERM_BORDER()}`,
                paddingTop: 6,
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 10,
                    color: TERM_GREEN_DIM(),
                    textTransform: 'uppercase',
                    letterSpacing: '0.18em',
                  }}
                >
                  total payroll
                </span>
                <span
                  style={{
                    fontSize: 22,
                    color: TERM_GREEN_BRIGHT(),
                    fontWeight: 600,
                    textShadow: '0 0 8px rgba(var(--accent-rgb),0.55)',
                  }}
                >
                  ${liveTotals.grand.toFixed(2)}
                </span>
                {payrollData && (
                  <span style={{ fontSize: 10, color: TERM_GREEN_DIM() }}>
                    snapshot: ${payrollData.totalPayroll.toFixed(2)} · {payrollData.employees.length} emp
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: TERM_GREEN_DIM(), display: 'flex', alignItems: 'center', gap: 6 }}>
                {toast && <span style={{ color: TERM_GREEN_BRIGHT() }}>» {toast}</span>}
                <span style={{ color: TERM_GREEN(), opacity: cursorOn ? 1 : 0 }}>▮</span>
              </div>
            </div>
          </>
        )}

        {view === 'settings' && (
          <>
            <div
              style={{
                fontSize: 10,
                color: TERM_GREEN_DIM(),
                letterSpacing: '0.08em',
                lineHeight: 1.5,
              }}
            >
              edit roster · changes save automatically · overtime auto-fills at 1.5× when blank
            </div>

            <div
              style={{
                flex: 1,
                overflow: 'auto',
                border: `1px solid ${TERM_BORDER()}`,
                borderRadius: 4,
                background: 'var(--sunken)',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 520 }}>
                <thead>
                  <tr style={{ background: TERM_BG_ALT(), position: 'sticky', top: 0, zIndex: 1 }}>
                    {['name', 'type', 'rate', 'overtime', ''].map((h, i) => (
                      <th key={i} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ background: 'rgba(var(--accent-rgb),0.05)' }}>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="text"
                        placeholder="new employee"
                        value={draft.name}
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                        style={{ ...inputBase, width: '100%', minWidth: 120 }}
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <select
                        value={draft.type}
                        onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
                        style={{ ...inputBase, width: 80 }}
                      >
                        <option value="hourly">hourly</option>
                        <option value="daily">daily</option>
                        <option value="salary">salary</option>
                      </select>
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={draft.rate}
                        onChange={(e) => setDraft((d) => ({ ...d, rate: e.target.value }))}
                        style={{ ...inputBase, width: 80 }}
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {draft.type === 'hourly' ? (
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="auto 1.5×"
                          value={draft.overtimeRate}
                          onChange={(e) => setDraft((d) => ({ ...d, overtimeRate: e.target.value }))}
                          style={{ ...inputBase, width: 90 }}
                        />
                      ) : (
                        <span style={{ color: TERM_GREEN_DIM() }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <button
                        style={{ ...btnBase, color: TERM_GREEN_BRIGHT(), borderColor: TERM_GREEN_DIM() }}
                        onClick={handleAddEmployee}
                      >
                        + add
                      </button>
                    </td>
                  </tr>

                  {employees.map((emp, idx) => {
                    const armed = confirmRemoveId === emp.id;
                    return (
                      <tr
                        key={emp.id}
                        style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(var(--accent-rgb),0.025)' }}
                      >
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            type="text"
                            value={emp.name}
                            onChange={(e) => updateEmployee(emp.id, { name: e.target.value })}
                            style={{ ...inputBase, width: '100%', minWidth: 120 }}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <select
                            value={emp.type}
                            onChange={(e) => updateEmployee(emp.id, { type: e.target.value })}
                            style={{ ...inputBase, width: 80 }}
                          >
                            <option value="hourly">hourly</option>
                            <option value="daily">daily</option>
                            <option value="salary">salary</option>
                          </select>
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={emp.rate}
                            onChange={(e) => updateEmployee(emp.id, { rate: e.target.value })}
                            style={{ ...inputBase, width: 80 }}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          {emp.type === 'hourly' ? (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={emp.overtimeRate ?? ''}
                              placeholder={`${(Number(emp.rate) * 1.5).toFixed(2)}`}
                              onChange={(e) => updateEmployee(emp.id, { overtimeRate: e.target.value })}
                              style={{ ...inputBase, width: 90 }}
                            />
                          ) : (
                            <span style={{ color: TERM_GREEN_DIM() }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <button
                            style={{
                              ...btnBase,
                              color: armed ? TERM_DANGER : TERM_GREEN_DIM(),
                              borderColor: armed ? TERM_DANGER : TERM_BORDER_BRIGHT(),
                              padding: '4px 8px',
                            }}
                            onClick={() => handleRemoveClick(emp.id)}
                            title={armed ? 'click again to confirm' : 'remove employee'}
                          >
                            {armed ? '✓?' : '×'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div
              className="p-row"
              style={{
                justifyContent: 'space-between',
                alignItems: 'center',
                borderTop: `1px solid ${TERM_BORDER()}`,
                paddingTop: 6,
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: TERM_GREEN_DIM(),
                  textTransform: 'uppercase',
                  letterSpacing: '0.18em',
                }}
              >
                {employees.length} employee{employees.length === 1 ? '' : 's'} on roster
              </span>
              <div className="p-row" style={{ gap: 6 }}>
                <button
                  style={{
                    ...btnBase,
                    color: confirmDefaults ? TERM_AMBER : TERM_GREEN_DIM(),
                    borderColor: confirmDefaults ? TERM_AMBER : TERM_BORDER_BRIGHT(),
                  }}
                  onClick={handleRestoreDefaults}
                  title="restore Tony's original 15 employees"
                >
                  {confirmDefaults ? '✓? restore' : 'restore defaults'}
                </button>
                {toast && (
                  <span style={{ color: TERM_GREEN_BRIGHT(), fontSize: 10, alignSelf: 'center' }}>
                    » {toast}
                  </span>
                )}
                <span style={{ color: TERM_GREEN(), opacity: cursorOn ? 1 : 0, alignSelf: 'center' }}>▮</span>
              </div>
            </div>
          </>
        )}
      </div>
    );
  },
};
