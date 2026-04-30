// plugins/invoice/plugin.jsx
//
// Receipt -> Invoice. Adapted from the standalone Electron-app spec
// in "Invoice Plugin/" to the single-file dashboard plugin contract:
//   - no imports, hooks come via props, localStorage for state
//   - SQLite -> localStorage  (customers, invoices, line_items, receipts, settings)
//   - Handlebars -> JS template literal (renderInvoiceHTML)
//   - Puppeteer/printToPDF -> fs.write(html) + shell.open in default browser
//                              (user hits Ctrl+P -> Save as PDF)
//   - Tesseract.js -> window.Tesseract (the host already loads it for invoice-ocr)
//   - Nodemailer -> mailto: link via shell.openExternal
//
// One widget, five tabs: dashboard / customers / invoices / receipts / settings.

const ID = 'invoice';
const KEY = `plugin:${ID}`;
const KEYS = {
  customers: `${KEY}:customers:v1`,
  invoices:  `${KEY}:invoices:v1`,
  receipts:  `${KEY}:receipts:v1`,
  settings:  `${KEY}:settings:v1`,
  view:      `${KEY}:view:v1`,
};

const DEFAULT_SETTINGS = {
  business_name: '',
  business_email: '',
  business_phone: '',
  business_address: '',
  business_logo_path: '',
  business_tax_id: '',
  invoice_save_folder: '',
  invoice_number_prefix: 'INV-',
  invoice_number_padding: 4,
  default_tax_rate: 0,
  default_gratuity_rate: 0,
  default_payment_terms: 'Net 30',
  default_notes: 'Thank you for your business.',
};

// ── persistence helpers ────────────────────────────────────────────────
const loadJSON = (k, fb) => {
  try { const raw = localStorage.getItem(k); return raw == null ? fb : JSON.parse(raw); }
  catch { return fb; }
};
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ── formatting ─────────────────────────────────────────────────────────
const fmtMoney = (v) => {
  const n = Number(v);
  if (!isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtPct = (rate) => {
  const n = Number(rate);
  if (!isFinite(n)) return '0%';
  return `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const addDays = (iso, days) => {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const safeFileName = (s) => (s || 'untitled').replace(/[^a-zA-Z0-9_\-.]/g, '_');
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── invoice math + numbering ───────────────────────────────────────────
const recalcTotals = (line_items, tax_rate, gratuity_rate) => {
  const sub = (line_items || []).reduce((s, it) => s + (Number(it.line_total) || 0), 0);
  const subtotal = +sub.toFixed(2);
  const tax_amount = +(subtotal * (Number(tax_rate) || 0)).toFixed(2);
  const gratuity_amount = +(subtotal * (Number(gratuity_rate) || 0)).toFixed(2);
  const total = +(subtotal + tax_amount + gratuity_amount).toFixed(2);
  return { subtotal, tax_amount, gratuity_amount, total };
};

const nextInvoiceNumber = (invoices, settings) => {
  const year = new Date().getFullYear();
  const padding = Math.max(1, parseInt(settings.invoice_number_padding) || 4);
  const prefix = `${settings.invoice_number_prefix || 'INV-'}${year}-`;
  const matching = invoices
    .map(i => i.invoice_number)
    .filter(n => n && n.startsWith(prefix))
    .map(n => parseInt(n.slice(prefix.length), 10) || 0);
  const next = (matching.length ? Math.max(...matching) : 0) + 1;
  return `${prefix}${String(next).padStart(padding, '0')}`;
};

// ── lite receipt parser (port of parser.ts) ────────────────────────────
const MONEY_RE_G = /(?:[$€£¥]\s*)?(\d{1,3}(?:[,\s]\d{3})*[.,]\d{2})/g;
const TOTAL_KW = [/grand\s*total/i, /amount\s*due/i, /balance\s*due/i, /total\s*due/i, /^total$/i, /\btotal\b/i];
const SUB_KW   = [/sub[\s-]?total/i];
const TAX_KW   = [/\btax\b/i, /\bvat\b/i, /\bgst\b/i, /\bhst\b/i];

const parseMoney = (s) => {
  const n = s.includes(',') && s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
  return parseFloat(n);
};
const isoDate = (y, m, d) => {
  const yr = parseInt(y, 10), mo = parseInt(m, 10), da = parseInt(d, 10);
  if (yr < 1990 || yr > 2100 || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${String(yr).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(da).padStart(2,'0')}`;
};
const monthNum = (name) => {
  const ms = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const i = ms.indexOf(name.slice(0, 3).toLowerCase());
  return i >= 0 ? String(i + 1) : '0';
};

const parseReceiptText = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let vendor = null;
  for (const l of lines.slice(0, 5)) {
    if (l.length < 3) continue;
    if (/^\d/.test(l)) continue;
    if (/^[\d\s\-:/.]+$/.test(l)) continue;
    vendor = l.replace(/\s{2,}/g, ' ');
    break;
  }

  let date = null;
  const datePats = [
    [/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/, (m) => isoDate(m[1], m[2], m[3])],
    [/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/, (m) => {
      const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
      return isoDate(yr, m[1], m[2]);
    }],
    [/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{2,4})\b/i, (m) => {
      const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
      return isoDate(yr, monthNum(m[2]), m[1]);
    }],
  ];
  for (const [re, fmt] of datePats) {
    const m = text.match(re);
    if (m) { const out = fmt(m); if (out) { date = out; break; } }
  }

  const findAmt = (kws) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!kws.some((re) => re.test(line))) continue;
      const re = new RegExp(MONEY_RE_G.source, 'g');
      const amts = [...line.matchAll(re)].map(m => parseMoney(m[1]));
      if (amts.length) return Math.max(...amts);
      if (i + 1 < lines.length) {
        const re2 = new RegExp(MONEY_RE_G.source, 'g');
        const next = [...lines[i + 1].matchAll(re2)].map(m => parseMoney(m[1]));
        if (next.length) return Math.max(...next);
      }
    }
    return null;
  };
  const total = findAmt(TOTAL_KW);
  const subtotal = findAmt(SUB_KW);
  const tax = findAmt(TAX_KW);

  const skip = [...TOTAL_KW, ...SUB_KW, ...TAX_KW,
    /change/i, /cash/i, /credit/i, /debit/i, /visa/i, /mastercard/i,
    /thank/i, /receipt/i, /invoice/i];
  const items = [];
  for (const line of lines) {
    if (skip.some(re => re.test(line))) continue;
    const re = new RegExp(MONEY_RE_G.source, 'g');
    const ms = [...line.matchAll(re)];
    if (!ms.length) continue;
    const last = ms[ms.length - 1];
    const price = parseMoney(last[1]);
    if (!isFinite(price) || price <= 0) continue;
    const idx = line.lastIndexOf(last[0]);
    let desc = line.slice(0, idx).trim().replace(/[\s.\-_]+$/, '').trim();
    if (desc.length < 2) continue;
    let qty = 1;
    const qm = desc.match(/^(\d+(?:\.\d+)?)\s*(?:x|@)?\s+(.+)$/i);
    if (qm) {
      const q = parseFloat(qm[1]);
      if (q > 0 && q < 1000) { qty = q; desc = qm[2].trim(); }
    }
    items.push({
      description: desc,
      quantity: qty,
      unit_price: +(price / qty).toFixed(2),
      line_total: +price.toFixed(2),
    });
  }

  return { vendor, date, total, subtotal, tax, line_items: items };
};

// ── HTML invoice template (port of invoice.html) ───────────────────────
const renderInvoiceHTML = ({ invoice, customer, business, line_items }) => {
  const e = escapeHtml;
  const itemsHTML = (line_items || []).map(it => `
        <tr>
          <td class="description">${e(it.description)}</td>
          <td class="num">${e(it.quantity)}</td>
          <td class="num">${e(fmtMoney(it.unit_price))}</td>
          <td class="num">${e(fmtMoney(it.line_total))}</td>
        </tr>`).join('');

  const logoTag = business.logo_path
    ? `<img class="logo" src="file:///${e(String(business.logo_path).replace(/\\/g,'/'))}" alt="${e(business.name)}">`
    : '';
  const taxRow = (invoice.tax_amount || 0) > 0
    ? `<div class="totals-row"><span>Tax (${e(fmtPct(invoice.tax_rate))})</span><span class="value">${e(fmtMoney(invoice.tax_amount))}</span></div>`
    : '';
  const gratRow = (invoice.gratuity_amount || 0) > 0
    ? `<div class="totals-row"><span>Gratuity (${e(fmtPct(invoice.gratuity_rate))})</span><span class="value">${e(fmtMoney(invoice.gratuity_amount))}</span></div>`
    : '';
  const dueRow = invoice.due_date
    ? `<div><span class="label">Due</span>${e(invoice.due_date)}</div>` : '';
  const billCompany = customer.company ? ` — ${e(customer.company)}` : '';
  const addr2  = customer.address_line2 ? `\n${e(customer.address_line2)}` : '';
  const stBit  = customer.state ? `, ${e(customer.state)}` : '';
  const eml    = customer.email ? `\n${e(customer.email)}` : '';
  const phone  = business.phone ? ` · ${e(business.phone)}` : '';
  const taxId  = business.tax_id ? `\nTax ID: ${e(business.tax_id)}` : '';
  const notes  = invoice.notes
    ? `<div class="notes"><div class="label">Notes</div>${e(invoice.notes)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Invoice ${e(invoice.invoice_number)}</title>
<style>
@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 11pt; color: #1a1a1a; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: 0.5in; }
.header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 24px; border-bottom: 2px solid #1a1a1a; margin-bottom: 32px; }
.header-left { flex: 1; } .header-right { text-align: right; }
.logo { max-height: 64px; max-width: 220px; margin-bottom: 12px; }
.business-name { font-size: 16pt; font-weight: 700; margin-bottom: 4px; }
.business-meta { font-size: 9.5pt; color: #555; white-space: pre-line; }
h1.invoice-title { font-size: 28pt; font-weight: 300; letter-spacing: 0.04em; color: #1a1a1a; margin-bottom: 8px; }
.invoice-meta { font-size: 10pt; color: #555; }
.invoice-meta .label { display: inline-block; width: 90px; color: #888; }
.bill-to { margin-bottom: 36px; }
.bill-to .label { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.1em; color: #888; margin-bottom: 6px; }
.bill-to .name { font-weight: 600; font-size: 12pt; margin-bottom: 2px; }
.bill-to .address { white-space: pre-line; color: #555; font-size: 10pt; }
table.items { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
table.items thead th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.08em; color: #888; padding: 10px 8px; border-bottom: 1px solid #1a1a1a; }
table.items thead th.num { text-align: right; }
table.items tbody td { padding: 12px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
table.items tbody td.num { text-align: right; font-variant-numeric: tabular-nums; }
table.items td.description { width: 50%; }
.totals { width: 280px; margin-left: auto; margin-bottom: 32px; }
.totals-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 10.5pt; color: #555; }
.totals-row .value { font-variant-numeric: tabular-nums; }
.totals-row.grand { border-top: 2px solid #1a1a1a; padding-top: 12px; margin-top: 8px; font-size: 14pt; font-weight: 700; color: #1a1a1a; }
.notes { margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee; font-size: 9.5pt; color: #555; white-space: pre-line; }
.notes .label { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.1em; color: #888; margin-bottom: 6px; }
.footer { margin-top: 24px; text-align: center; font-size: 9pt; color: #aaa; }
.status-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 8.5pt; letter-spacing: 0.06em; text-transform: uppercase; margin-left: 10px; vertical-align: middle; }
.status-paid    { background: #d1fae5; color: #065f46; }
.status-draft   { background: #f3f4f6; color: #555; }
.status-sent    { background: #dbeafe; color: #1e40af; }
.status-overdue { background: #fee2e2; color: #991b1b; }
.status-void    { background: #f3f4f6; color: #888; text-decoration: line-through; }
@media print { .status-badge { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${logoTag}
      <div class="business-name">${e(business.name || 'Your Business')}</div>
      <div class="business-meta">${e(business.address || '')}
${e(business.email || '')}${phone}${taxId}</div>
    </div>
    <div class="header-right">
      <h1 class="invoice-title">INVOICE<span class="status-badge status-${e(invoice.status)}">${e(invoice.status)}</span></h1>
      <div class="invoice-meta">
        <div><span class="label">Number</span>${e(invoice.invoice_number)}</div>
        <div><span class="label">Issued</span>${e(invoice.issue_date)}</div>
        ${dueRow}
      </div>
    </div>
  </div>
  <div class="bill-to">
    <div class="label">Bill to</div>
    <div class="name">${e(customer.name || '')}${billCompany}</div>
    <div class="address">${e(customer.address_line1 || '')}${addr2}
${e(customer.city || '')}${stBit} ${e(customer.postal_code || '')}${eml}</div>
  </div>
  <table class="items">
    <thead>
      <tr>
        <th class="description">Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit price</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>${itemsHTML}
    </tbody>
  </table>
  <div class="totals">
    <div class="totals-row"><span>Subtotal</span><span class="value">${e(fmtMoney(invoice.subtotal))}</span></div>
    ${taxRow}
    ${gratRow}
    <div class="totals-row grand"><span>Total</span><span class="value">${e(fmtMoney(invoice.total))}</span></div>
  </div>
  ${notes}
  <div class="footer">Thank you for your business.</div>
</body>
</html>`;
};

// ── tiny style helpers ─────────────────────────────────────────────────
const tabBtn = (active) => ({
  background: active ? 'var(--bg-elev)' : 'transparent',
  color: active ? 'var(--accent)' : 'var(--fg-dim)',
  border: '1px solid', borderColor: active ? 'var(--accent)' : 'var(--border)',
  padding: '4px 10px', fontSize: 10, letterSpacing: '0.12em',
  textTransform: 'uppercase', cursor: 'pointer',
  fontFamily: 'var(--mono)', borderRadius: 3,
  textShadow: active ? 'var(--glow)' : 'none',
});
const card = { border: '1px solid var(--border-bright)', background: 'var(--bg-elev)', borderRadius: 4, padding: 10 };
const lbl  = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'var(--fg-dim)' };
const rowBetween = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 };

const STATUS_COLORS = {
  draft:   'var(--fg-dim)',
  sent:    '#7ab8ff',
  paid:    'var(--accent)',
  overdue: 'var(--danger)',
  void:    'var(--fg-dim)',
};

// ──────────────────────────────────────────────────────────────────────
//                              MAIN COMPONENT
// ──────────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Invoice',
  width: 4,
  height: 6,
  component: ({ React, useState, useEffect, useMemo, useRef, useCallback }) => {
    // ── state ──
    const [view, setView] = useState(() => loadJSON(KEYS.view, 'dashboard'));
    const [customers, setCustomers] = useState(() => loadJSON(KEYS.customers, []));
    const [invoices,  setInvoices]  = useState(() => loadJSON(KEYS.invoices,  []));
    const [receipts,  setReceipts]  = useState(() => loadJSON(KEYS.receipts,  []));
    const [settings,  setSettings]  = useState(() => ({ ...DEFAULT_SETTINGS, ...loadJSON(KEYS.settings, {}) }));

    const [error, setError] = useState(null);
    const [info, setInfo]   = useState(null);
    const errT = useRef(null);
    const infT = useRef(null);

    const [editingCustomer, setEditingCustomer] = useState(null); // null | partial
    const [editingInvoice,  setEditingInvoice]  = useState(null);
    const [editingReceipt,  setEditingReceipt]  = useState(null);
    const [confirmDel, setConfirmDel] = useState(null);

    const [ocrBusy, setOcrBusy] = useState(false);
    const [ocrProg, setOcrProg] = useState(0);
    const [ocrStatus, setOcrStatus] = useState('');

    // persist
    useEffect(() => { saveJSON(KEYS.customers, customers); }, [customers]);
    useEffect(() => { saveJSON(KEYS.invoices,  invoices);  }, [invoices]);
    useEffect(() => { saveJSON(KEYS.receipts,  receipts);  }, [receipts]);
    useEffect(() => { saveJSON(KEYS.settings,  settings);  }, [settings]);
    useEffect(() => { saveJSON(KEYS.view,      view);      }, [view]);

    const flash = useCallback((msg, kind) => {
      if (kind === 'error') {
        setError(msg); setInfo(null);
        if (errT.current) clearTimeout(errT.current);
        errT.current = setTimeout(() => setError(null), 5000);
      } else {
        setInfo(msg); setError(null);
        if (infT.current) clearTimeout(infT.current);
        infT.current = setTimeout(() => setInfo(null), 3500);
      }
    }, []);

    const armDelete = (id, fn) => {
      if (confirmDel === id) {
        setConfirmDel(null);
        fn();
      } else {
        setConfirmDel(id);
        setTimeout(() => setConfirmDel((x) => (x === id ? null : x)), 3000);
      }
    };

    // ── stats ──
    const stats = useMemo(() => {
      const counts = { draft: 0, sent: 0, paid: 0, overdue: 0, void: 0 };
      let revenue = 0, outstanding = 0;
      const today = todayISO();
      let overdueCount = 0;
      for (const inv of invoices) {
        counts[inv.status] = (counts[inv.status] || 0) + 1;
        if (inv.status === 'paid') revenue += Number(inv.total) || 0;
        else if (inv.status === 'sent' || inv.status === 'overdue') outstanding += Number(inv.total) || 0;
        if ((inv.status === 'sent' || inv.status === 'overdue') && inv.due_date && inv.due_date < today) overdueCount++;
      }
      return { counts, revenue, outstanding, overdueCount };
    }, [invoices]);

    // ── customer ops ──
    const saveCustomer = (data) => {
      if (!data.name || !data.name.trim()) return flash('Customer name required', 'error');
      const now = new Date().toISOString();
      if (data.id) {
        setCustomers(cs => cs.map(c => c.id === data.id ? { ...c, ...data, updated_at: now } : c));
      } else {
        setCustomers(cs => [...cs, { ...data, id: makeId(), created_at: now, updated_at: now }]);
      }
      setEditingCustomer(null);
      flash('Customer saved');
    };
    const deleteCustomer = (id) => {
      if (invoices.some(i => i.customer_id === id)) return flash('Cannot delete — customer has invoices', 'error');
      setCustomers(cs => cs.filter(c => c.id !== id));
      flash('Customer deleted');
    };

    // ── invoice ops ──
    const blankInvoice = (customer_id) => {
      const customer = customers.find(c => c.id === customer_id) || customers[0];
      const tax_rate = customer
        ? Number(customer.default_tax_rate ?? settings.default_tax_rate)
        : Number(settings.default_tax_rate);
      const issue_date = todayISO();
      const dueByTerms = {
        'Net 15': addDays(issue_date, 15),
        'Net 30': addDays(issue_date, 30),
        'Net 60': addDays(issue_date, 60),
        'Due on receipt': issue_date,
      }[settings.default_payment_terms] || null;
      const gratuity_rate = Number(settings.default_gratuity_rate) || 0;
      return {
        id: null,
        invoice_number: nextInvoiceNumber(invoices, settings),
        customer_id: customer ? customer.id : '',
        issue_date,
        due_date: dueByTerms,
        status: 'draft',
        line_items: [{ id: makeId(), description: '', quantity: 1, unit_price: 0, line_total: 0 }],
        subtotal: 0,
        tax_rate: Number.isFinite(tax_rate) ? tax_rate : 0, tax_amount: 0,
        gratuity_rate, gratuity_amount: 0,
        total: 0,
        notes: settings.default_notes || '',
        pdf_path: null, sent_at: null, paid_at: null,
      };
    };

    const saveInvoice = (data) => {
      if (!data.customer_id) return flash('Pick a customer', 'error');
      const totals = recalcTotals(data.line_items, data.tax_rate, data.gratuity_rate);
      const now = new Date().toISOString();
      const merged = { ...data, ...totals, updated_at: now };
      if (merged.id) {
        setInvoices(is => is.map(i => i.id === merged.id ? merged : i));
      } else {
        merged.id = makeId();
        merged.created_at = now;
        setInvoices(is => [...is, merged]);
      }
      // link any receipt that spawned this invoice
      if (data._fromReceiptId) {
        setReceipts(rs => rs.map(r => r.id === data._fromReceiptId ? { ...r, linked_invoice_id: merged.id } : r));
      }
      setEditingInvoice(null);
      flash('Invoice saved');
    };

    const deleteInvoice = (id) => {
      setInvoices(is => is.filter(i => i.id !== id));
      setReceipts(rs => rs.map(r => r.linked_invoice_id === id ? { ...r, linked_invoice_id: null } : r));
      flash('Invoice deleted');
    };

    const setInvoiceStatus = (id, status) => {
      const now = new Date().toISOString();
      setInvoices(is => is.map(i => {
        if (i.id !== id) return i;
        const patch = { status };
        if (status === 'sent' && !i.sent_at) patch.sent_at = now;
        if (status === 'paid' && !i.paid_at) patch.paid_at = now;
        return { ...i, ...patch, updated_at: now };
      }));
    };

    // ── export HTML / "PDF" ──
    const exportInvoice = async (inv) => {
      const customer = customers.find(c => c.id === inv.customer_id);
      if (!customer) return flash('Customer missing', 'error');
      const business = {
        name: settings.business_name, email: settings.business_email,
        phone: settings.business_phone, address: settings.business_address,
        logo_path: settings.business_logo_path, tax_id: settings.business_tax_id,
      };
      const html = renderInvoiceHTML({ invoice: inv, customer, business, line_items: inv.line_items });
      try {
        let folder = (settings.invoice_save_folder || '').trim();
        if (!folder) {
          const home = await window.dashboard.fs.home();
          folder = `${home}/Invoices`.replace(/\\/g, '/');
        }
        const year = (inv.issue_date || todayISO()).slice(0, 4);
        const target = `${folder.replace(/\\/g,'/')}/${year}/${safeFileName(inv.invoice_number)}.html`;
        await window.dashboard.fs.write(target, html);
        setInvoices(is => is.map(i => i.id === inv.id ? { ...i, pdf_path: target } : i));
        await window.dashboard.shell.open(target);
        flash(`Saved → ${target}  (Ctrl+P → Save as PDF)`);
      } catch (e) {
        flash('Export failed: ' + (e && e.message || e), 'error');
      }
    };

    const emailInvoice = async (inv) => {
      const customer = customers.find(c => c.id === inv.customer_id);
      if (!customer) return flash('Customer missing', 'error');
      if (!customer.email) return flash('No email on file for customer', 'error');
      const subj = `Invoice ${inv.invoice_number}`;
      const lines = [
        `Hi ${customer.name},`, '',
        `Please find invoice ${inv.invoice_number} for $${fmtMoney(inv.total)}${inv.due_date ? ', due ' + inv.due_date : ''}.`,
        inv.pdf_path ? `Attached: ${inv.pdf_path}` : '',
        '', settings.default_notes || 'Thank you for your business.',
        '', `— ${settings.business_name || 'Your Business'}`,
      ].filter(Boolean).join('\n');
      const url = `mailto:${encodeURIComponent(customer.email)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(lines)}`;
      try {
        await window.dashboard.shell.openExternal(url);
        if (inv.status === 'draft') setInvoiceStatus(inv.id, 'sent');
        flash('Email opened in default mail client');
      } catch (e) {
        flash('Mail client failed: ' + (e && e.message || e), 'error');
      }
    };

    // ── receipts ──
    const addReceipt = async () => {
      try {
        const path = await window.dashboard.dialog.openFile({
          title: 'Choose receipt image',
          filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','webp','bmp','gif'] }],
        });
        if (!path) return;
        const r = {
          id: makeId(),
          image_path: path,
          ocr_raw_text: '',
          vendor: null, receipt_date: null, receipt_total: null,
          subtotal: null, tax: null,
          line_items: [],
          linked_invoice_id: null,
          created_at: new Date().toISOString(),
        };
        setReceipts(rs => [r, ...rs]);
        setEditingReceipt(r);
        setView('receipts');
      } catch (e) {
        flash('Could not load image: ' + (e && e.message || e), 'error');
      }
    };

    const updateReceipt = (id, patch) => {
      setReceipts(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
      setEditingReceipt(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
    };

    const deleteReceipt = (id) => {
      setReceipts(rs => rs.filter(r => r.id !== id));
      setEditingReceipt(prev => prev && prev.id === id ? null : prev);
      flash('Receipt deleted');
    };

    const convertReceiptToInvoice = (r) => {
      if (!customers.length) {
        flash('Add a customer first', 'error');
        setView('customers');
        return;
      }
      const base = blankInvoice(customers[0].id);
      const items = (r.line_items && r.line_items.length)
        ? r.line_items.map(it => ({ id: makeId(), ...it }))
        : (r.receipt_total
            ? [{ id: makeId(), description: r.vendor || 'Receipt charge', quantity: 1, unit_price: r.receipt_total, line_total: r.receipt_total }]
            : [{ id: makeId(), description: '', quantity: 1, unit_price: 0, line_total: 0 }]);
      const draft = {
        ...base,
        line_items: items,
        notes: [`From receipt: ${r.vendor || 'Unknown vendor'}${r.receipt_date ? ' (' + r.receipt_date + ')' : ''}`, settings.default_notes].filter(Boolean).join('\n\n'),
        _fromReceiptId: r.id,
      };
      const totals = recalcTotals(items, draft.tax_rate, draft.gratuity_rate);
      setEditingInvoice({ ...draft, ...totals });
      setView('invoices');
    };

    const runOCR = async (receipt) => {
      if (ocrBusy) return;
      if (!window.Tesseract) {
        flash('Tesseract.js not available — paste the OCR text manually below', 'error');
        return;
      }
      setOcrBusy(true); setOcrProg(0); setOcrStatus('Loading OCR engine...');
      try {
        const base64 = await window.dashboard.fs.read(receipt.image_path, 'base64');
        const dataUrl = `data:image/*;base64,${base64}`;
        const baseUrl = new URL('../node_modules/', window.location.href).href;
        const result = await window.Tesseract.recognize(dataUrl, 'eng', {
          workerPath: baseUrl + 'tesseract.js/dist/worker.min.js',
          corePath:   baseUrl + 'tesseract.js-core',
          workerBlobURL: false,
          langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast_int',
          logger: (m) => {
            if (m.status === 'recognizing text') {
              setOcrProg(Math.round((m.progress || 0) * 100));
              setOcrStatus(`recognizing… ${Math.round((m.progress||0)*100)}%`);
            } else if (m.status) setOcrStatus(m.status);
          },
        });
        const text = (result.data.text || '').trim();
        const parsed = parseReceiptText(text);
        updateReceipt(receipt.id, {
          ocr_raw_text: text,
          vendor: parsed.vendor,
          receipt_date: parsed.date,
          receipt_total: parsed.total,
          subtotal: parsed.subtotal,
          tax: parsed.tax,
          line_items: parsed.line_items,
        });
        flash(`OCR done — ${(result.data.confidence || 0).toFixed(0)}% confidence`);
      } catch (e) {
        flash('OCR failed: ' + (e && e.message || e), 'error');
      } finally {
        setOcrBusy(false); setOcrStatus('');
      }
    };

    // ── live totals for the invoice editor ──
    const onLineItemChange = (i, patch) => {
      setEditingInvoice(inv => {
        if (!inv) return inv;
        const items = inv.line_items.map((it, idx) => {
          if (idx !== i) return it;
          const merged = { ...it, ...patch };
          merged.line_total = +(Number(merged.quantity || 0) * Number(merged.unit_price || 0)).toFixed(2);
          return merged;
        });
        const totals = recalcTotals(items, inv.tax_rate, inv.gratuity_rate);
        return { ...inv, line_items: items, ...totals };
      });
    };
    const addLineItem = () => setEditingInvoice(inv => {
      const items = [...inv.line_items, { id: makeId(), description: '', quantity: 1, unit_price: 0, line_total: 0 }];
      const totals = recalcTotals(items, inv.tax_rate, inv.gratuity_rate);
      return { ...inv, line_items: items, ...totals };
    });
    const removeLineItem = (i) => setEditingInvoice(inv => {
      const items = inv.line_items.filter((_, idx) => idx !== i);
      const safeItems = items.length ? items : [{ id: makeId(), description: '', quantity: 1, unit_price: 0, line_total: 0 }];
      const totals = recalcTotals(safeItems, inv.tax_rate, inv.gratuity_rate);
      return { ...inv, line_items: safeItems, ...totals };
    });
    const setEditTaxRate = (rate) => setEditingInvoice(inv => {
      const r = Number(rate);
      const totals = recalcTotals(inv.line_items, isFinite(r) ? r : 0, inv.gratuity_rate);
      return { ...inv, tax_rate: isFinite(r) ? r : 0, ...totals };
    });
    const setEditGratuityRate = (rate) => setEditingInvoice(inv => {
      const r = Number(rate);
      const totals = recalcTotals(inv.line_items, inv.tax_rate, isFinite(r) ? r : 0);
      return { ...inv, gratuity_rate: isFinite(r) ? r : 0, ...totals };
    });

    // ── helpers used by sub-renders ──
    const customerById = (id) => customers.find(c => c.id === id);

    // ── tabs ──
    const tabs = [
      ['dashboard', 'home'],
      ['customers', 'customers'],
      ['invoices',  'invoices'],
      ['receipts',  'receipts'],
      ['settings',  'settings'],
    ];

    const switchView = (v) => {
      setView(v);
      setEditingCustomer(null);
      setEditingInvoice(null);
      setEditingReceipt(null);
      setConfirmDel(null);
    };

    // ─────────────────── RENDER ───────────────────
    return (
      <div className="p-col p-mono" style={{ height: '100%', gap: 6, fontSize: 12, minHeight: 0 }}>

        {/* nav */}
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <div className="p-row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {tabs.map(([k, label]) => (
              <button key={k} style={tabBtn(view === k)} onClick={() => switchView(k)}>{label}</button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
            {invoices.length} inv · {customers.length} cust · {receipts.length} rcpt
          </div>
        </div>

        {/* messages */}
        {error && (
          <div style={{ padding: '4px 10px', color: 'var(--danger)', border: '1px dashed var(--danger)', borderRadius: 4, fontSize: 11 }}>! {error}</div>
        )}
        {info && (
          <div style={{ padding: '4px 10px', color: 'var(--accent)', border: '1px dashed var(--accent)', borderRadius: 4, fontSize: 11 }}>✓ {info}</div>
        )}

        {/* body */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>

          {/* ── DASHBOARD ── */}
          {view === 'dashboard' && (
            <div className="p-col" style={{ gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
                <Stat label="revenue (paid)" value={`$${fmtMoney(stats.revenue)}`} />
                <Stat label="outstanding"    value={`$${fmtMoney(stats.outstanding)}`} accent="warm" />
                <Stat label="overdue"        value={stats.overdueCount} accent={stats.overdueCount ? 'danger' : null} />
                <Stat label="customers"      value={customers.length} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                {['draft','sent','paid','overdue','void'].map(k => (
                  <div key={k} style={{ ...card, padding: 6, textAlign: 'center' }}>
                    <div style={{ ...lbl, fontSize: 9 }}>{k}</div>
                    <div style={{ fontSize: 16, color: STATUS_COLORS[k], fontFamily: 'var(--mono)' }}>{stats.counts[k] || 0}</div>
                  </div>
                ))}
              </div>

              <div style={card}>
                <div style={{ ...lbl, marginBottom: 6 }}>recent invoices</div>
                {invoices.length === 0
                  ? <div style={{ color: 'var(--fg-dim)', fontSize: 11 }}>none yet — create one in <span style={{ color: 'var(--accent)' }}>invoices</span></div>
                  : invoices.slice().sort((a,b) => (b.updated_at||'').localeCompare(a.updated_at||'')).slice(0, 6).map(inv => {
                      const c = customerById(inv.customer_id);
                      return (
                        <div key={inv.id} style={{ ...rowBetween, padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
                          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => { setEditingInvoice(inv); setView('invoices'); }}>{inv.invoice_number}</span>
                          <span style={{ color: 'var(--fg-dim)', flex: 1, marginLeft: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c ? (c.company || c.name) : '—'}
                          </span>
                          <span style={{ color: STATUS_COLORS[inv.status], textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.12em' }}>{inv.status}</span>
                          <span style={{ width: 80, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${fmtMoney(inv.total)}</span>
                        </div>
                      );
                    })
                }
              </div>

              <div className="p-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="p-btn" onClick={() => { setEditingInvoice(blankInvoice()); setView('invoices'); }}>+ new invoice</button>
                <button className="p-btn" onClick={() => { setEditingCustomer({}); setView('customers'); }}>+ new customer</button>
                <button className="p-btn" onClick={addReceipt}>+ scan receipt</button>
              </div>
            </div>
          )}

          {/* ── CUSTOMERS ── */}
          {view === 'customers' && !editingCustomer && (
            <div className="p-col" style={{ gap: 8 }}>
              <div className="p-row" style={{ justifyContent: 'flex-end' }}>
                <button className="p-btn" onClick={() => setEditingCustomer({ default_tax_rate: settings.default_tax_rate })}>+ new customer</button>
              </div>
              {customers.length === 0
                ? <div style={{ color: 'var(--fg-dim)', fontSize: 11 }}>no customers yet</div>
                : (
                  <div style={card}>
                    {customers.map(c => (
                      <div key={c.id} style={{ ...rowBetween, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: 'var(--fg-bright)' }}>{c.name}{c.company ? ` · ${c.company}` : ''}</div>
                          <div style={{ color: 'var(--fg-dim)', fontSize: 10 }}>{c.email || '—'}{c.phone ? ` · ${c.phone}` : ''}</div>
                        </div>
                        <div className="p-row" style={{ gap: 4 }}>
                          <button className="p-btn" onClick={() => setEditingCustomer(c)}>edit</button>
                          <button className="p-btn"
                            style={{ color: confirmDel === c.id ? 'var(--danger)' : 'var(--fg-dim)', borderColor: confirmDel === c.id ? 'var(--danger)' : 'var(--border)' }}
                            onClick={() => armDelete(c.id, () => deleteCustomer(c.id))}
                          >{confirmDel === c.id ? '✓?' : '×'}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              }
            </div>
          )}

          {view === 'customers' && editingCustomer && (
            <CustomerForm
              React={React} useState={useState}
              initial={editingCustomer}
              onSave={saveCustomer}
              onCancel={() => setEditingCustomer(null)}
            />
          )}

          {/* ── INVOICES ── */}
          {view === 'invoices' && !editingInvoice && (
            <div className="p-col" style={{ gap: 8 }}>
              <div className="p-row" style={{ justifyContent: 'flex-end' }}>
                <button className="p-btn"
                  onClick={() => {
                    if (!customers.length) { flash('Add a customer first', 'error'); setView('customers'); return; }
                    setEditingInvoice(blankInvoice());
                  }}
                >+ new invoice</button>
              </div>

              {invoices.length === 0
                ? <div style={{ color: 'var(--fg-dim)', fontSize: 11 }}>no invoices yet</div>
                : (
                  <div style={card}>
                    {invoices.slice().sort((a,b) => (b.issue_date||'').localeCompare(a.issue_date||'')).map(inv => {
                      const c = customerById(inv.customer_id);
                      return (
                        <div key={inv.id} style={{ ...rowBetween, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 11, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 160 }}>
                            <div>
                              <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEditingInvoice(inv)}>{inv.invoice_number}</span>
                              <span style={{ color: 'var(--fg-dim)', marginLeft: 8 }}>{inv.issue_date}</span>
                              {inv.due_date && inv.due_date < todayISO() && inv.status !== 'paid' && inv.status !== 'void' && (
                                <span style={{ color: 'var(--danger)', marginLeft: 8, fontSize: 9 }}>OVERDUE</span>
                              )}
                            </div>
                            <div style={{ color: 'var(--fg-dim)', fontSize: 10 }}>{c ? (c.company || c.name) : '—'}</div>
                          </div>
                          <select
                            className="p-input" style={{ fontSize: 10, padding: '2px 4px', color: STATUS_COLORS[inv.status] }}
                            value={inv.status} onChange={(e) => setInvoiceStatus(inv.id, e.target.value)}
                          >
                            {['draft','sent','paid','overdue','void'].map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <span style={{ width: 80, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${fmtMoney(inv.total)}</span>
                          <div className="p-row" style={{ gap: 4 }}>
                            <button className="p-btn" title="export & open in browser" onClick={() => exportInvoice(inv)}>pdf</button>
                            <button className="p-btn" title="email"   onClick={() => emailInvoice(inv)}>@</button>
                            <button className="p-btn"
                              style={{ color: confirmDel === inv.id ? 'var(--danger)' : 'var(--fg-dim)', borderColor: confirmDel === inv.id ? 'var(--danger)' : 'var(--border)' }}
                              onClick={() => armDelete(inv.id, () => deleteInvoice(inv.id))}
                            >{confirmDel === inv.id ? '✓?' : '×'}</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              }
            </div>
          )}

          {view === 'invoices' && editingInvoice && (
            <div className="p-col" style={{ gap: 8 }}>
              <div className="p-row" style={{ justifyContent: 'space-between' }}>
                <div style={{ ...lbl }}>invoice {editingInvoice.invoice_number}</div>
                <div className="p-row" style={{ gap: 4 }}>
                  <button className="p-btn" onClick={() => setEditingInvoice(null)}>cancel</button>
                  <button className="p-btn" onClick={() => saveInvoice(editingInvoice)} style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>save</button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
                <Field label="invoice #">
                  <input className="p-input" value={editingInvoice.invoice_number}
                    onChange={(e) => setEditingInvoice(inv => ({ ...inv, invoice_number: e.target.value }))} />
                </Field>
                <Field label="customer">
                  <select className="p-input" value={editingInvoice.customer_id}
                    onChange={(e) => setEditingInvoice(inv => ({ ...inv, customer_id: e.target.value }))}>
                    <option value="">— pick —</option>
                    {customers.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>)}
                  </select>
                </Field>
                <Field label="status">
                  <select className="p-input" value={editingInvoice.status}
                    onChange={(e) => setEditingInvoice(inv => ({ ...inv, status: e.target.value }))}>
                    {['draft','sent','paid','overdue','void'].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="issue date">
                  <input className="p-input" type="date" value={editingInvoice.issue_date}
                    onChange={(e) => setEditingInvoice(inv => ({ ...inv, issue_date: e.target.value }))} />
                </Field>
                <Field label="due date">
                  <input className="p-input" type="date" value={editingInvoice.due_date || ''}
                    onChange={(e) => setEditingInvoice(inv => ({ ...inv, due_date: e.target.value || null }))} />
                </Field>
                <Field label={`tax rate (${fmtPct(editingInvoice.tax_rate)})`}>
                  <input className="p-input" type="number" step="0.001" min="0" max="1"
                    value={editingInvoice.tax_rate}
                    onChange={(e) => setEditTaxRate(e.target.value)} />
                </Field>
                <Field label={`gratuity (${fmtPct(editingInvoice.gratuity_rate || 0)})`}>
                  <div className="p-row" style={{ gap: 4 }}>
                    <input className="p-input" type="number" step="0.001" min="0" max="1" style={{ flex: 1, minWidth: 0 }}
                      value={editingInvoice.gratuity_rate || 0}
                      onChange={(e) => setEditGratuityRate(e.target.value)} />
                    {[0.15, 0.18, 0.20, 0.25].map(r => (
                      <button key={r} className="p-btn"
                        onClick={() => setEditGratuityRate(r)}
                        style={{ padding: '0 4px', fontSize: 10,
                          color: Math.abs((editingInvoice.gratuity_rate || 0) - r) < 0.0005 ? 'var(--accent)' : 'var(--fg-dim)',
                          borderColor: Math.abs((editingInvoice.gratuity_rate || 0) - r) < 0.0005 ? 'var(--accent)' : 'var(--border)' }}>
                        {Math.round(r * 100)}%
                      </button>
                    ))}
                    <button className="p-btn" onClick={() => setEditGratuityRate(0)} title="clear" style={{ padding: '0 4px', fontSize: 10 }}>×</button>
                  </div>
                </Field>
              </div>

              <div style={card}>
                <div style={{ ...rowBetween, marginBottom: 6 }}>
                  <div style={lbl}>line items</div>
                  <button className="p-btn" onClick={addLineItem}>+ add line</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 80px 80px 24px', gap: 4, fontSize: 10, color: 'var(--fg-dim)', marginBottom: 4 }}>
                  <span>description</span><span style={{ textAlign: 'right' }}>qty</span><span style={{ textAlign: 'right' }}>unit</span><span style={{ textAlign: 'right' }}>total</span><span></span>
                </div>
                {editingInvoice.line_items.map((it, i) => (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 80px 80px 24px', gap: 4, marginBottom: 3 }}>
                    <input className="p-input" value={it.description}
                      onChange={(e) => onLineItemChange(i, { description: e.target.value })} />
                    <input className="p-input" type="number" step="0.01" min="0" value={it.quantity} style={{ textAlign: 'right' }}
                      onChange={(e) => onLineItemChange(i, { quantity: parseFloat(e.target.value) || 0 })} />
                    <input className="p-input" type="number" step="0.01" min="0" value={it.unit_price} style={{ textAlign: 'right' }}
                      onChange={(e) => onLineItemChange(i, { unit_price: parseFloat(e.target.value) || 0 })} />
                    <input className="p-input" readOnly value={fmtMoney(it.line_total)} style={{ textAlign: 'right', color: 'var(--fg-dim)' }} />
                    <button className="p-btn" onClick={() => removeLineItem(i)} style={{ padding: '0 4px' }}>×</button>
                  </div>
                ))}

                <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, fontSize: 11 }}>
                  <div style={{ textAlign: 'right', color: 'var(--fg-dim)' }}>subtotal</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${fmtMoney(editingInvoice.subtotal)}</div>
                  <div style={{ textAlign: 'right', color: 'var(--fg-dim)' }}>tax ({fmtPct(editingInvoice.tax_rate)})</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${fmtMoney(editingInvoice.tax_amount)}</div>
                  {(editingInvoice.gratuity_rate || 0) > 0 && (<>
                    <div style={{ textAlign: 'right', color: 'var(--fg-dim)' }}>gratuity ({fmtPct(editingInvoice.gratuity_rate)})</div>
                    <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${fmtMoney(editingInvoice.gratuity_amount || 0)}</div>
                  </>)}
                  <div style={{ textAlign: 'right', color: 'var(--accent)', textShadow: 'var(--glow)' }}>TOTAL</div>
                  <div style={{ textAlign: 'right', color: 'var(--accent)', textShadow: 'var(--glow)', fontVariantNumeric: 'tabular-nums', fontSize: 14 }}>${fmtMoney(editingInvoice.total)}</div>
                </div>
              </div>

              <Field label="notes">
                <textarea className="p-input" rows={3} value={editingInvoice.notes || ''}
                  onChange={(e) => setEditingInvoice(inv => ({ ...inv, notes: e.target.value }))} />
              </Field>

              {editingInvoice.id && (
                <div className="p-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button className="p-btn" onClick={() => exportInvoice(editingInvoice)}>save html → open in browser → print pdf</button>
                  <button className="p-btn" onClick={() => emailInvoice(editingInvoice)}>email</button>
                </div>
              )}
            </div>
          )}

          {/* ── RECEIPTS ── */}
          {view === 'receipts' && !editingReceipt && (
            <div className="p-col" style={{ gap: 8 }}>
              <div className="p-row" style={{ justifyContent: 'flex-end' }}>
                <button className="p-btn" onClick={addReceipt}>+ upload receipt photo</button>
              </div>
              {receipts.length === 0
                ? <div style={{ color: 'var(--fg-dim)', fontSize: 11 }}>no receipts uploaded</div>
                : (
                  <div style={card}>
                    {receipts.map(r => (
                      <div key={r.id} style={{ ...rowBetween, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEditingReceipt(r)}>
                            {r.vendor || (r.image_path ? r.image_path.split(/[\\/]/).pop() : 'untitled')}
                          </div>
                          <div style={{ color: 'var(--fg-dim)', fontSize: 10 }}>
                            {r.receipt_date || '—'} · ${r.receipt_total != null ? fmtMoney(r.receipt_total) : '—'}
                            {r.linked_invoice_id ? ' · linked' : ''}
                          </div>
                        </div>
                        <button className="p-btn" onClick={() => convertReceiptToInvoice(r)} disabled={!!r.linked_invoice_id}>→ invoice</button>
                        <button className="p-btn"
                          style={{ color: confirmDel === r.id ? 'var(--danger)' : 'var(--fg-dim)', borderColor: confirmDel === r.id ? 'var(--danger)' : 'var(--border)' }}
                          onClick={() => armDelete(r.id, () => deleteReceipt(r.id))}
                        >{confirmDel === r.id ? '✓?' : '×'}</button>
                      </div>
                    ))}
                  </div>
                )
              }
            </div>
          )}

          {view === 'receipts' && editingReceipt && (
            <ReceiptEditor
              React={React} useState={useState} useEffect={useEffect}
              receipt={editingReceipt}
              onUpdate={updateReceipt}
              onClose={() => setEditingReceipt(null)}
              onConvert={() => convertReceiptToInvoice(editingReceipt)}
              onOCR={() => runOCR(editingReceipt)}
              ocrBusy={ocrBusy} ocrProg={ocrProg} ocrStatus={ocrStatus}
            />
          )}

          {/* ── SETTINGS ── */}
          {view === 'settings' && (
            <div className="p-col" style={{ gap: 8 }}>
              <Section title="business">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6 }}>
                  <Field label="business name">
                    <input className="p-input" value={settings.business_name}
                      onChange={(e) => setSettings(s => ({ ...s, business_name: e.target.value }))} />
                  </Field>
                  <Field label="email">
                    <input className="p-input" value={settings.business_email}
                      onChange={(e) => setSettings(s => ({ ...s, business_email: e.target.value }))} />
                  </Field>
                  <Field label="phone">
                    <input className="p-input" value={settings.business_phone}
                      onChange={(e) => setSettings(s => ({ ...s, business_phone: e.target.value }))} />
                  </Field>
                  <Field label="tax id">
                    <input className="p-input" value={settings.business_tax_id}
                      onChange={(e) => setSettings(s => ({ ...s, business_tax_id: e.target.value }))} />
                  </Field>
                </div>
                <Field label="address (multiline)">
                  <textarea className="p-input" rows={3} value={settings.business_address}
                    onChange={(e) => setSettings(s => ({ ...s, business_address: e.target.value }))} />
                </Field>
                <Field label="logo (file path — optional)">
                  <div className="p-row" style={{ gap: 4 }}>
                    <input className="p-input" style={{ flex: 1 }} value={settings.business_logo_path}
                      onChange={(e) => setSettings(s => ({ ...s, business_logo_path: e.target.value }))} />
                    <button className="p-btn" onClick={async () => {
                      try {
                        const p = await window.dashboard.dialog.openFile({
                          title: 'Pick logo',
                          filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','svg'] }],
                        });
                        if (p) setSettings(s => ({ ...s, business_logo_path: p }));
                      } catch (e) { flash('Picker failed: ' + e.message, 'error'); }
                    }}>browse</button>
                  </div>
                </Field>
              </Section>

              <Section title="invoice numbering & defaults">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
                  <Field label="prefix">
                    <input className="p-input" value={settings.invoice_number_prefix}
                      onChange={(e) => setSettings(s => ({ ...s, invoice_number_prefix: e.target.value }))} />
                  </Field>
                  <Field label="number padding">
                    <input className="p-input" type="number" min="1" max="8" value={settings.invoice_number_padding}
                      onChange={(e) => setSettings(s => ({ ...s, invoice_number_padding: parseInt(e.target.value) || 4 }))} />
                  </Field>
                  <Field label="default tax rate (e.g. 0.08)">
                    <input className="p-input" type="number" step="0.001" min="0" max="1" value={settings.default_tax_rate}
                      onChange={(e) => setSettings(s => ({ ...s, default_tax_rate: parseFloat(e.target.value) || 0 }))} />
                  </Field>
                  <Field label="default gratuity (e.g. 0.18)">
                    <input className="p-input" type="number" step="0.001" min="0" max="1" value={settings.default_gratuity_rate}
                      onChange={(e) => setSettings(s => ({ ...s, default_gratuity_rate: parseFloat(e.target.value) || 0 }))} />
                  </Field>
                  <Field label="payment terms">
                    <select className="p-input" value={settings.default_payment_terms}
                      onChange={(e) => setSettings(s => ({ ...s, default_payment_terms: e.target.value }))}>
                      {['Due on receipt','Net 15','Net 30','Net 60'].map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label={`next invoice number → ${nextInvoiceNumber(invoices, settings)}`}>{null}</Field>
                <Field label="default invoice notes">
                  <textarea className="p-input" rows={2} value={settings.default_notes}
                    onChange={(e) => setSettings(s => ({ ...s, default_notes: e.target.value }))} />
                </Field>
              </Section>

              <Section title="storage">
                <Field label="invoice save folder (blank ⇒ ~/Invoices)">
                  <div className="p-row" style={{ gap: 4 }}>
                    <input className="p-input" style={{ flex: 1 }} value={settings.invoice_save_folder}
                      onChange={(e) => setSettings(s => ({ ...s, invoice_save_folder: e.target.value }))} />
                    <button className="p-btn" onClick={async () => {
                      try {
                        if (window.dashboard.dialog.openDirectory) {
                          const p = await window.dashboard.dialog.openDirectory({ defaultPath: settings.invoice_save_folder || undefined });
                          if (p) setSettings(s => ({ ...s, invoice_save_folder: p }));
                        } else {
                          flash('Folder picker not available — type the path manually', 'error');
                        }
                      } catch (e) { flash('Picker failed: ' + e.message, 'error'); }
                    }}>browse</button>
                    <button className="p-btn" onClick={async () => {
                      const p = (settings.invoice_save_folder || '').trim();
                      if (!p) return flash('No folder set', 'error');
                      try { await window.dashboard.shell.open(p); }
                      catch (e) { flash('Open failed: ' + e.message, 'error'); }
                    }}>open</button>
                  </div>
                </Field>
              </Section>

              <Section title="data">
                <div className="p-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button className="p-btn" onClick={() => {
                    const blob = JSON.stringify({ customers, invoices, receipts, settings }, null, 2);
                    navigator.clipboard.writeText(blob).then(() => flash('Backup JSON copied to clipboard'));
                  }}>copy backup json</button>
                  <button className="p-btn"
                    style={{ color: confirmDel === '__wipe' ? 'var(--danger)' : 'var(--fg-dim)', borderColor: confirmDel === '__wipe' ? 'var(--danger)' : 'var(--border)' }}
                    onClick={() => armDelete('__wipe', () => {
                      setCustomers([]); setInvoices([]); setReceipts([]);
                      flash('All data cleared (settings kept)');
                    })}
                  >{confirmDel === '__wipe' ? 'really wipe?' : 'wipe customers/invoices/receipts'}</button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 4 }}>
                  data lives in localStorage under <span className="p-mono">plugin:invoice:*</span>
                </div>
              </Section>
            </div>
          )}

        </div>

        {/* footer */}
        <div className="p-row" style={{ justifyContent: 'space-between', fontSize: 10, color: 'var(--fg-dim)' }}>
          <span>receipt → invoice {window.Tesseract ? '· ocr ready' : '· ocr offline'}</span>
          <span>v0.1</span>
        </div>
      </div>
    );
  },
};

// ──────────────────────────────────────────────────────────────────────
//                          SUB-COMPONENTS
//   (defined as plain function components; receive React + hooks via
//    props so they can use useState/useEffect themselves)
// ──────────────────────────────────────────────────────────────────────

function Stat({ label, value, accent }) {
  const color = accent === 'warm' ? 'var(--accent-warm)'
              : accent === 'danger' ? 'var(--danger)'
              : 'var(--accent)';
  return (
    <div style={card}>
      <div style={lbl}>{label}</div>
      <div style={{ fontSize: 22, color, fontFamily: 'var(--mono)', textShadow: accent ? 'none' : 'var(--glow)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="p-col" style={{ gap: 2, fontSize: 11 }}>
      <span style={lbl}>{label}</span>
      {children}
    </label>
  );
}

function Section({ title, children }) {
  return (
    <div style={card}>
      <div style={{ ...lbl, marginBottom: 6 }}>{title}</div>
      <div className="p-col" style={{ gap: 6 }}>{children}</div>
    </div>
  );
}

function CustomerForm({ React, useState, initial, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    id: initial.id || null,
    name: initial.name || '',
    company: initial.company || '',
    email: initial.email || '',
    phone: initial.phone || '',
    address_line1: initial.address_line1 || '',
    address_line2: initial.address_line2 || '',
    city: initial.city || '',
    state: initial.state || '',
    postal_code: initial.postal_code || '',
    country: initial.country || '',
    default_tax_rate: initial.default_tax_rate ?? 0,
    notes: initial.notes || '',
  }));
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="p-col" style={{ gap: 8 }}>
      <div className="p-row" style={{ justifyContent: 'space-between' }}>
        <div style={lbl}>{form.id ? 'edit customer' : 'new customer'}</div>
        <div className="p-row" style={{ gap: 4 }}>
          <button className="p-btn" onClick={onCancel}>cancel</button>
          <button className="p-btn" onClick={() => onSave(form)} style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>save</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
        <Field label="name *"><input className="p-input" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
        <Field label="company"><input className="p-input" value={form.company} onChange={(e) => set('company', e.target.value)} /></Field>
        <Field label="email"><input className="p-input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="phone"><input className="p-input" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="address line 1"><input className="p-input" value={form.address_line1} onChange={(e) => set('address_line1', e.target.value)} /></Field>
        <Field label="address line 2"><input className="p-input" value={form.address_line2} onChange={(e) => set('address_line2', e.target.value)} /></Field>
        <Field label="city"><input className="p-input" value={form.city} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label="state"><input className="p-input" value={form.state} onChange={(e) => set('state', e.target.value)} /></Field>
        <Field label="postal code"><input className="p-input" value={form.postal_code} onChange={(e) => set('postal_code', e.target.value)} /></Field>
        <Field label="country"><input className="p-input" value={form.country} onChange={(e) => set('country', e.target.value)} /></Field>
        <Field label="default tax rate (e.g. 0.08)">
          <input className="p-input" type="number" step="0.001" min="0" max="1" value={form.default_tax_rate}
            onChange={(e) => set('default_tax_rate', parseFloat(e.target.value) || 0)} />
        </Field>
      </div>
      <Field label="notes">
        <textarea className="p-input" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </div>
  );
}

function ReceiptEditor({ React, useState, useEffect, receipt, onUpdate, onClose, onConvert, onOCR, ocrBusy, ocrProg, ocrStatus }) {
  const [imgUrl, setImgUrl] = useState(null);
  const [imgErr, setImgErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!receipt.image_path) return;
      try {
        const b64 = await window.dashboard.fs.read(receipt.image_path, 'base64');
        if (!cancelled) setImgUrl(`data:image/*;base64,${b64}`);
      } catch (e) {
        if (!cancelled) setImgErr(e && e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [receipt.image_path]);

  const setField = (k, v) => onUpdate(receipt.id, { [k]: v });

  return (
    <div className="p-col" style={{ gap: 8 }}>
      <div className="p-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div style={lbl}>receipt · {receipt.image_path ? receipt.image_path.split(/[\\/]/).pop() : 'unknown'}</div>
        <div className="p-row" style={{ gap: 4 }}>
          <button className="p-btn" onClick={onClose}>back</button>
          <button className="p-btn" onClick={onOCR} disabled={ocrBusy} style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>
            {ocrBusy ? `ocr ${ocrProg}%` : 'run ocr'}
          </button>
          <button className="p-btn" onClick={onConvert} disabled={!!receipt.linked_invoice_id}>→ invoice</button>
        </div>
      </div>

      {ocrBusy && (
        <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
          {ocrStatus} · <span style={{ color: 'var(--accent)' }}>{ocrProg}%</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
        <div style={{ ...card, padding: 4, minHeight: 120 }}>
          {imgErr && <div style={{ color: 'var(--danger)', fontSize: 10, padding: 8 }}>could not load image: {imgErr}</div>}
          {imgUrl && <img src={imgUrl} alt="receipt" style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 2 }} />}
          {!imgUrl && !imgErr && <div style={{ padding: 8, fontSize: 10, color: 'var(--fg-dim)' }}>loading…</div>}
        </div>

        <div className="p-col" style={{ gap: 6 }}>
          <Field label="vendor">
            <input className="p-input" value={receipt.vendor || ''} onChange={(e) => setField('vendor', e.target.value)} />
          </Field>
          <Field label="receipt date">
            <input className="p-input" type="date" value={receipt.receipt_date || ''} onChange={(e) => setField('receipt_date', e.target.value || null)} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            <Field label="subtotal">
              <input className="p-input" type="number" step="0.01" value={receipt.subtotal ?? ''} onChange={(e) => setField('subtotal', e.target.value === '' ? null : parseFloat(e.target.value))} />
            </Field>
            <Field label="tax">
              <input className="p-input" type="number" step="0.01" value={receipt.tax ?? ''} onChange={(e) => setField('tax', e.target.value === '' ? null : parseFloat(e.target.value))} />
            </Field>
            <Field label="total">
              <input className="p-input" type="number" step="0.01" value={receipt.receipt_total ?? ''} onChange={(e) => setField('receipt_total', e.target.value === '' ? null : parseFloat(e.target.value))} />
            </Field>
          </div>

          <Field label={`line items (${(receipt.line_items || []).length})`}>
            <div style={{ ...card, padding: 4, maxHeight: 140, overflowY: 'auto' }}>
              {(receipt.line_items || []).length === 0
                ? <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>no line items extracted</div>
                : (receipt.line_items || []).map((it, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 40px 60px 24px', gap: 4, marginBottom: 2, fontSize: 11 }}>
                    <input className="p-input" value={it.description} onChange={(e) => {
                      const items = receipt.line_items.slice();
                      items[i] = { ...items[i], description: e.target.value };
                      setField('line_items', items);
                    }} />
                    <input className="p-input" type="number" step="0.01" value={it.quantity} style={{ textAlign: 'right' }} onChange={(e) => {
                      const items = receipt.line_items.slice();
                      const q = parseFloat(e.target.value) || 0;
                      items[i] = { ...items[i], quantity: q, line_total: +(q * (items[i].unit_price || 0)).toFixed(2) };
                      setField('line_items', items);
                    }} />
                    <input className="p-input" type="number" step="0.01" value={it.line_total} style={{ textAlign: 'right' }} onChange={(e) => {
                      const items = receipt.line_items.slice();
                      const t = parseFloat(e.target.value) || 0;
                      items[i] = { ...items[i], line_total: t, unit_price: items[i].quantity ? +(t / items[i].quantity).toFixed(2) : t };
                      setField('line_items', items);
                    }} />
                    <button className="p-btn" style={{ padding: '0 4px' }} onClick={() => {
                      const items = receipt.line_items.filter((_, idx) => idx !== i);
                      setField('line_items', items);
                    }}>×</button>
                  </div>
                ))
              }
              <button className="p-btn" style={{ marginTop: 4 }} onClick={() => {
                const items = [...(receipt.line_items || []), { description: '', quantity: 1, unit_price: 0, line_total: 0 }];
                setField('line_items', items);
              }}>+ add</button>
            </div>
          </Field>
        </div>
      </div>

      <Field label="raw ocr text (paste here if ocr is offline)">
        <textarea className="p-input" rows={6} value={receipt.ocr_raw_text || ''} onChange={(e) => setField('ocr_raw_text', e.target.value)} />
      </Field>
      <div className="p-row" style={{ gap: 4 }}>
        <button className="p-btn" onClick={() => {
          const text = receipt.ocr_raw_text || '';
          if (!text.trim()) return;
          const parsed = parseReceiptText(text);
          onUpdate(receipt.id, {
            vendor: parsed.vendor ?? receipt.vendor,
            receipt_date: parsed.date ?? receipt.receipt_date,
            receipt_total: parsed.total ?? receipt.receipt_total,
            subtotal: parsed.subtotal ?? receipt.subtotal,
            tax: parsed.tax ?? receipt.tax,
            line_items: parsed.line_items.length ? parsed.line_items : receipt.line_items,
          });
        }}>re-parse text</button>
      </div>
    </div>
  );
}
