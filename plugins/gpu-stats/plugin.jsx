// GPU Stats — Detail panel: usage %, temperature, VRAM, clocks, sparklines.
//
// • Reads window.dashboard.system.stats() every 1.5s. Prefers
//   LibreHardwareMonitor (lhm) data when available (more reliable across
//   vendors); falls back to si.graphics() controller fields (NVIDIA reports
//   cleanly, AMD/Intel often partial).
// • If multiple GPUs, tabs let you switch.
// • Two sparklines: GPU load (green) and temperature (amber).
// • Bars for VRAM use and core/mem clocks (vs reported max if available).

const POLL_MS = 3000;
const SAMPLE_COUNT = 80;

const fmtBytes = (b) => {
  if (!Number.isFinite(b) || b <= 0) return '—';
  if (b < 1024) return b.toFixed(0) + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(0) + ' MB';
  return (b / 1024 ** 3).toFixed(1) + ' GB';
};

// VRAM via si is sometimes reported in MiB
const vramMB = (v) => {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
};

const tempColor = (t) => {
  if (t == null) return 'var(--fg-dim)';
  if (t >= 85) return 'var(--danger)';
  if (t >= 70) return 'var(--accent-warm)';
  return 'var(--accent)';
};

const loadColor = (p) => {
  if (p == null) return 'var(--fg-dim)';
  if (p >= 90) return 'var(--accent)';
  if (p >= 50) return 'var(--accent-warm)';
  return 'var(--fg-dim)';
};

// Match LHM device entries by model substring — LHM identifies cards by their
// trade name (e.g. "NVIDIA GeForce RTX 3080"); si.graphics returns `model`
// like "NVIDIA GeForce RTX 3080". Match case-insensitive on the longest
// shared word.
const matchLhmEntries = (lhm, controllerName) => {
  if (!lhm || !controllerName) return { temps: [], loads: [], clocks: [] };
  const cn = controllerName.toLowerCase();
  const matches = (e) => e.device && cn.includes(e.device.toLowerCase().split(' ').pop().toLowerCase());
  return {
    temps: (lhm.temps || []).filter(matches),
    loads: (lhm.loads || []).filter(matches),
    clocks: (lhm.clocks || []).filter(matches),
  };
};

const findLhmGPULoad = (entries) => {
  // Find "GPU Core" load
  return entries.loads.find((e) => /core|3d|gpu/i.test(e.name)) || entries.loads[0];
};
const findLhmGPUTemp = (entries) => {
  return entries.temps.find((e) => /core|gpu/i.test(e.name)) || entries.temps[0];
};
const findLhmCoreClock = (entries) => entries.clocks.find((e) => /core/i.test(e.name)) || entries.clocks[0];
const findLhmMemClock = (entries) => entries.clocks.find((e) => /memory|vram/i.test(e.name));

// Synthesize a unified per-GPU snapshot from whatever data we have
const gpuSnapshot = (controller, lhm) => {
  if (!controller) return null;
  const lhmEnts = matchLhmEntries(lhm, controller.model || controller.name || '');
  const lhmLoad = findLhmGPULoad(lhmEnts);
  const lhmTemp = findLhmGPUTemp(lhmEnts);
  const lhmCore = findLhmCoreClock(lhmEnts);
  const lhmMem = findLhmMemClock(lhmEnts);
  const valFromLhm = (e) => e && Number.isFinite(parseFloat(e.value)) ? parseFloat(e.value) : null;

  return {
    name: controller.model || controller.name || '?',
    vendor: controller.vendor || '',
    bus: controller.bus || '',
    load: valFromLhm(lhmLoad) ?? (controller.utilizationGpu != null ? controller.utilizationGpu : null),
    temp: valFromLhm(lhmTemp) ?? (controller.temperatureGpu != null ? controller.temperatureGpu : null),
    vramTotal: vramMB(controller.memoryTotal != null ? controller.memoryTotal : controller.vram),
    vramUsed: vramMB(controller.memoryUsed),
    vramFree: vramMB(controller.memoryFree),
    coreClock: valFromLhm(lhmCore) ?? controller.clockCore ?? null,
    memClock: valFromLhm(lhmMem) ?? controller.clockMemory ?? null,
    powerDraw: controller.powerDraw != null ? controller.powerDraw : null,
    fanSpeed: valFromLhm(lhm && (lhm.fans || []).find((f) => /gpu/i.test(f.device || ''))),
  };
};

export default {
  id: 'gpu-stats',
  name: 'GPU',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useMemo }) => {
    const [stats, setStats] = useState(null);
    const [error, setError] = useState(null);
    const [tabIdx, setTabIdx] = useState(0);
    const [samples, setSamples] = useState([]); // per current GPU

    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        try {
          const api = window.dashboard && window.dashboard.system;
          if (!api || !api.stats) {
            if (!cancelled) setError('host has no stats API');
            return;
          }
          const s = await api.stats();
          if (cancelled) return;
          setError(null);
          setStats(s);
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      };
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    const controllers = (stats && stats.gpu && stats.gpu.controllers) || [];
    const lhm = stats && stats.lhm;

    // Filter out blatantly fake/no-data controllers (Microsoft Basic Display Driver, etc.)
    const realControllers = useMemo(() => {
      return controllers.filter((c) => {
        const name = (c.model || c.name || '').toLowerCase();
        return !/basic display|microsoft basic|virtual/i.test(name);
      });
    }, [controllers]);

    const cur = realControllers[Math.min(tabIdx, realControllers.length - 1)];
    const snap = useMemo(() => gpuSnapshot(cur, lhm), [cur, lhm]);

    // Append sample on each fresh stats fetch (only when load is reported)
    useEffect(() => {
      if (!snap || snap.load == null) return;
      setSamples((prev) => {
        const next = [...prev, { t: Date.now(), load: snap.load, temp: snap.temp ?? 0 }];
        if (next.length > SAMPLE_COUNT) next.splice(0, next.length - SAMPLE_COUNT);
        return next;
      });
    }, [stats, tabIdx]);

    // Reset samples when GPU changed
    useEffect(() => { setSamples([]); }, [tabIdx]);

    const VB_W = 100, VB_H = 24;
    const paths = useMemo(() => {
      if (samples.length < 2) return null;
      const n = samples.length;
      const stepX = VB_W / (SAMPLE_COUNT - 1);
      const offsetX = VB_W - (n - 1) * stepX;
      const peakTemp = Math.max(60, ...samples.map((s) => s.temp));
      const buildPath = (key, max) => {
        let d = '';
        for (let i = 0; i < n; i++) {
          const x = offsetX + i * stepX;
          const y = VB_H - (samples[i][key] / max) * VB_H;
          d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
        }
        return d;
      };
      const buildArea = (key, max) => {
        return buildPath(key, max) + 'L' + (offsetX + (n - 1) * stepX) + ',' + VB_H + ' L' + offsetX + ',' + VB_H + ' Z';
      };
      return {
        loadLine: buildPath('load', 100),
        loadArea: buildArea('load', 100),
        tempLine: buildPath('temp', peakTemp),
        peakTemp,
      };
    }, [samples]);

    if (!stats && !error) {
      return <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>loading…</div>;
    }
    if (realControllers.length === 0) {
      return (
        <div className="p-col" style={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <div style={{ fontSize: 24, color: 'var(--fg-dim)' }}>▣</div>
          <div className="p-dim" style={{ fontSize: 11, textAlign: 'center', padding: '0 12px' }}>
            no GPU detected
          </div>
        </div>
      );
    }

    const vramPct = (snap && snap.vramTotal && snap.vramUsed)
      ? (snap.vramUsed / snap.vramTotal) * 100
      : null;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {error && (
          <div style={{
            padding: '3px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Multi-GPU tabs */}
        {realControllers.length > 1 && (
          <div style={{
            display: 'flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 4,
            overflow: 'hidden',
          }}>
            {realControllers.map((c, i) => {
              const active = tabIdx === i;
              const label = (c.model || 'GPU ' + (i + 1)).split(/\s+/).slice(-2).join(' ');
              return (
                <button
                  key={i}
                  onClick={() => setTabIdx(i)}
                  style={{
                    flex: 1,
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '3px 6px',
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    letterSpacing: '0.06em',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >{label}</button>
              );
            })}
          </div>
        )}

        {/* Big stats: load + temp */}
        <div className="p-row" style={{ alignItems: 'flex-start', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <div className="p-label" style={{ fontSize: 9 }}>load</div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 600,
              color: loadColor(snap && snap.load),
              textShadow: snap && snap.load > 5 ? '0 0 6px ' + loadColor(snap.load) : 'none',
              lineHeight: 1,
            }}>
              {snap && snap.load != null ? snap.load.toFixed(0) : '—'}
              <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 1 }}>%</span>
            </div>
          </div>
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div className="p-label" style={{ fontSize: 9 }}>temp</div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 600,
              color: tempColor(snap && snap.temp),
              textShadow: snap && snap.temp != null ? '0 0 6px ' + tempColor(snap.temp) : 'none',
              lineHeight: 1,
            }}>
              {snap && snap.temp != null ? snap.temp.toFixed(0) : '—'}
              <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 1 }}>°C</span>
            </div>
          </div>
        </div>

        {/* Sparklines */}
        <div style={{
          height: 28,
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid var(--border)',
          borderRadius: 2,
          overflow: 'hidden',
        }}>
          {paths ? (
            <svg viewBox={'0 0 ' + VB_W + ' ' + VB_H} preserveAspectRatio="none"
              style={{ width: '100%', height: '100%', display: 'block' }}>
              <path d={paths.loadArea} fill="var(--accent)" fillOpacity={0.18} />
              <path d={paths.loadLine} fill="none" stroke="var(--accent)" strokeWidth="0.6" />
              <path d={paths.tempLine} fill="none" stroke="var(--accent-warm)" strokeWidth="0.6" />
            </svg>
          ) : (
            <div className="p-dim" style={{
              padding: '8px 0', textAlign: 'center', fontSize: 9,
            }}>warming up…</div>
          )}
        </div>

        {/* VRAM bar */}
        {snap && snap.vramTotal && snap.vramTotal > 0 && (
          <div>
            <div className="p-row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="p-label" style={{ fontSize: 9 }}>vram</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg)' }}>
                {snap.vramUsed != null ? snap.vramUsed.toFixed(0) + ' / ' : ''}
                {snap.vramTotal.toFixed(0)} MB
                {vramPct != null && <span className="p-dim" style={{ marginLeft: 4 }}>({vramPct.toFixed(0)}%)</span>}
              </span>
            </div>
            <div style={{
              height: 4, background: 'rgba(0,0,0,0.4)',
              borderRadius: 1, overflow: 'hidden',
              border: '1px solid var(--border)',
            }}>
              <div style={{
                width: Math.max(0, Math.min(100, vramPct || 0)) + '%',
                height: '100%',
                background: 'var(--accent)',
                boxShadow: '0 0 4px var(--accent)',
                transition: 'width 0.4s ease',
              }} />
            </div>
          </div>
        )}

        {/* Clocks + power footer */}
        <div className="p-dim" style={{
          fontSize: 9, fontFamily: 'var(--mono)',
          display: 'flex', flexWrap: 'wrap', gap: 8,
          borderTop: '1px solid var(--border-bright)',
          paddingTop: 4,
        }}>
          {snap && snap.coreClock != null && <span>core {Math.round(snap.coreClock)}MHz</span>}
          {snap && snap.memClock != null && <span>mem {Math.round(snap.memClock)}MHz</span>}
          {snap && snap.powerDraw != null && <span>{snap.powerDraw.toFixed(0)}W</span>}
          <span style={{ flex: 1, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {snap && snap.name}
          </span>
        </div>
      </div>
    );
  },
};
