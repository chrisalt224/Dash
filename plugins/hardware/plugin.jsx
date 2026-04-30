// Hardware monitor — CPU/RAM/GPU usage from `systeminformation`,
// temps + fan speeds from LibreHardwareMonitor (LHM) if running on :8085.
//
// To get temperatures and fan speeds on Windows:
//   1. Download LibreHardwareMonitor: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
//   2. Run it (admin recommended for full sensor access)
//   3. Options → Remote Web Server → Run (default port 8085)
// Without LHM, you'll see live CPU/RAM/GPU usage but temps/fans will say "n/a".

const POLL_MS = 3000;

const fmtGB = (b) => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
const fmtPct = (n) => `${Math.round(n)}%`;

// Parse "47.4 °C", "1245 RPM", "3.85 GHz" → number
const parseLhmValue = (v) => {
  if (typeof v !== 'string') return null;
  const m = v.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

const Bar = ({ pct, hot }) => (
  <div style={{
    height: 5,
    background: 'rgba(0,0,0,0.5)',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 5,
    border: '1px solid var(--border)',
  }}>
    <div style={{
      width: `${Math.max(0, Math.min(100, pct))}%`,
      height: '100%',
      background: hot ? 'var(--accent-warm)' : 'var(--accent)',
      boxShadow: hot
        ? '0 0 6px var(--accent-warm)'
        : '0 0 6px var(--accent)',
      transition: 'width 0.4s ease',
    }} />
  </div>
);

const Stat = ({ label, detail, pct, suffix }) => (
  <div>
    <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
      <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span className="p-accent" style={{ marginRight: 8, fontWeight: 600 }}>{label}</span>
        <span className="p-dim" style={{ fontSize: 10 }}>{detail || ''}</span>
      </div>
      <div className="p-mono" style={{ flexShrink: 0, marginLeft: 8 }}>
        <span className="p-accent">{fmtPct(pct)}</span>
        {suffix && <span className="p-dim" style={{ marginLeft: 8 }}>{suffix}</span>}
      </div>
    </div>
    <Bar pct={pct} hot={pct > 85} />
  </div>
);

const Section = ({ title, children }) => (
  <div>
    <div className="p-label" style={{ marginBottom: 6, opacity: 0.7 }}>{title}</div>
    <div className="p-col" style={{ gap: 4 }}>{children}</div>
  </div>
);

export default {
  id: 'hardware',
  name: 'Hardware',
  width: 2,
  height: 3,
  component: ({ useState, useEffect }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        try {
          const stats = await window.dashboard.system.stats();
          if (!cancelled) { setData(stats); setError(null); }
        } catch (err) {
          if (!cancelled) setError(err.message || String(err));
        }
      };
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    if (error) return <div style={{ color: 'var(--danger)' }}>{error}</div>;
    if (!data) return <div className="p-dim">▸ probing sensors...</div>;

    // ---- CPU ----
    const cpuPct = data.cpuLoad ? data.cpuLoad.currentLoad : 0;
    const cpuBrand = data.cpu
      ? `${data.cpu.manufacturer || ''} ${data.cpu.brand || ''}`.trim()
      : 'unknown';
    const cpuCores = data.cpu ? `${data.cpu.physicalCores || data.cpu.cores}c/${data.cpu.cores}t` : '';

    // CPU temp: prefer LHM, fall back to systeminformation
    let cpuTempC = null;
    if (data.lhm && data.lhm.temps.length) {
      const cpuTemp = data.lhm.temps.find(t =>
        /CPU/i.test(t.device) && /(Package|Tctl|Tdie|Core \(|^CPU$)/i.test(t.name)
      ) || data.lhm.temps.find(t => /CPU/i.test(t.device));
      if (cpuTemp) cpuTempC = parseLhmValue(cpuTemp.value);
    }
    if (cpuTempC == null && data.siTemp && data.siTemp.main > 0) {
      cpuTempC = data.siTemp.main;
    }

    // ---- RAM ----
    const memTotal = data.mem ? data.mem.total : 0;
    const memUsed = data.mem ? data.mem.active || data.mem.used : 0;
    const memPct = memTotal ? (memUsed / memTotal) * 100 : 0;

    // ---- GPU ----
    const gpus = (data.gpu && data.gpu.controllers) || [];

    const gpuTempFor = (model) => {
      if (!data.lhm) return null;
      // try to match GPU vendor name
      const vendor = (model || '').match(/NVIDIA|GeForce|RTX|GTX|AMD|Radeon|Intel/i);
      if (!vendor) return null;
      const t = data.lhm.temps.find(t =>
        new RegExp(vendor[0], 'i').test(t.device) && /(Core|GPU|Hot Spot)/i.test(t.name)
      );
      return t ? parseLhmValue(t.value) : null;
    };

    // ---- Fans (LHM only) ----
    const fans = data.lhm ? data.lhm.fans : [];

    return (
      <div className="p-col" style={{ gap: 14, fontSize: 12 }}>
        <Section title="◢ CPU">
          <Stat
            label="CPU"
            detail={`${cpuBrand} · ${cpuCores}`}
            pct={cpuPct}
            suffix={cpuTempC != null ? `${Math.round(cpuTempC)}°C` : 'n/a'}
          />
        </Section>

        <Section title="◢ MEMORY">
          <Stat
            label="RAM"
            detail={`${fmtGB(memUsed)} / ${fmtGB(memTotal)}`}
            pct={memPct}
          />
        </Section>

        {gpus.length > 0 && (
          <Section title={gpus.length > 1 ? '◢ GPUs' : '◢ GPU'}>
            {gpus.map((g, i) => {
              const usagePct = g.utilizationGpu || 0;
              const tempC = g.temperatureGpu || gpuTempFor(g.model);
              const vramPct = g.memoryUsed && g.memoryTotal
                ? (g.memoryUsed / g.memoryTotal) * 100
                : null;
              return (
                <div key={i} className="p-col" style={{ gap: 4 }}>
                  <Stat
                    label={gpus.length > 1 ? `GPU${i + 1}` : 'GPU'}
                    detail={g.model || g.vendor || 'unknown'}
                    pct={usagePct}
                    suffix={tempC ? `${Math.round(tempC)}°C` : 'n/a'}
                  />
                  {vramPct != null && (
                    <Stat
                      label="VRAM"
                      detail={`${fmtGB(g.memoryUsed * 1024 * 1024)} / ${fmtGB(g.memoryTotal * 1024 * 1024)}`}
                      pct={vramPct}
                    />
                  )}
                </div>
              );
            })}
          </Section>
        )}

        {fans.length > 0 && (
          <Section title="◢ FANS">
            {fans.map((f, i) => {
              const rpm = parseLhmValue(f.value);
              const maxRpm = parseLhmValue(f.max) || 3000;
              const pct = rpm != null ? Math.min(100, (rpm / maxRpm) * 100) : 0;
              return (
                <Stat
                  key={i}
                  label={f.name}
                  detail={f.device}
                  pct={pct}
                  suffix={rpm != null ? `${Math.round(rpm)} rpm` : '—'}
                />
              );
            })}
          </Section>
        )}

        {!data.lhm && (
          <div className="p-dim" style={{
            fontSize: 10,
            lineHeight: 1.5,
            padding: '8px 10px',
            border: '1px dashed var(--border-bright)',
            borderRadius: 6,
            marginTop: 6,
          }}>
            ※ for full temps & fan speeds on Windows, run{' '}
            <span className="p-accent">LibreHardwareMonitor</span>{' '}
            with <span className="p-mono">Options → Remote Web Server</span> enabled (port 8085).
          </div>
        )}
      </div>
    );
  },
};
