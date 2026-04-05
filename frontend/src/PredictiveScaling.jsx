/**
 * PredictiveScaling.jsx  (v2 — adds mem_rate leak detection + FD monitoring)
 * Polls Docker stats directly every 5 s. No /predictions endpoint needed.
 */

import React, { useEffect, useState, useCallback, useRef } from "react";
import axios from "axios";

const API         = "http://localhost:5000";
const HORIZON_MIN = 15;
const POLL_MS     = 5_000;
const STEPS_AHEAD = Math.round((HORIZON_MIN * 60) / (POLL_MS / 1000)); // 180

// thresholds (mirror baselineLearner constants)
const MEM_LEAK_RATE  = 0.5;   // %/min — flag as leak
const FD_WARN        = 800;
const FD_CRIT        = 950;

// ── OLS regression ────────────────────────────────────────────────
function olsPredict(values) {
  const n = values.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = values.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (values[i] - my);
    sxx += (i - mx) ** 2;
    syy += (values[i] - my) ** 2;
  }
  const slope     = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2        = syy === 0 ? 1 : Math.min(1, Math.max(0, (sxy ** 2) / (sxx * syy)));
  const rawPred   = slope * (n - 1 + STEPS_AHEAD) + intercept;
  const predicted = parseFloat(Math.min(100, Math.max(0, rawPred)).toFixed(2));
  const current   = parseFloat(values[n - 1].toFixed(2));

  const sparklinePoints = Array.from({ length: 8 }, (_, i) => {
    const x = (i / 7) * (n - 1 + STEPS_AHEAD);
    return parseFloat(Math.min(100, Math.max(0, slope * x + intercept)).toFixed(2));
  });

  const trendPctPerMin = parseFloat((slope * (60_000 / POLL_MS)).toFixed(3));
  const trend =
    Math.abs(trendPctPerMin) < 0.05 ? "flat"
    : trendPctPerMin > 0            ? "rising"
    :                                 "falling";

  let recommendation       = "stable";
  let recommendationDetail = "No scaling action needed.";
  if (predicted >= 80) {
    recommendation       = "scale_up";
    recommendationDetail = `Projected to hit ${predicted}% in ~${HORIZON_MIN} min. Consider scaling up or restarting.`;
  } else if (predicted <= 20 && current <= 25) {
    recommendation       = "scale_down";
    recommendationDetail = `Predicted to stay below ${predicted}% — container may be over-provisioned.`;
  }

  return {
    status: "ok", samples: n, currentValue: current,
    predictedValue: predicted, horizonMinutes: HORIZON_MIN,
    trendPctPerMin, trend, r2: parseFloat(r2.toFixed(4)),
    recommendation, recommendationDetail, sparklinePoints,
  };
}

// ── memory growth rate (derivative over last N samples) ───────────
function computeMemRate(memHistory) {
  const N = 5;
  if (memHistory.length < N + 1) return null;
  const slice    = memHistory.slice(-(N + 1));
  const oldest   = slice[0];
  const newest   = slice[slice.length - 1];
  const deltaPct = newest - oldest;
  const deltaMins = (N * POLL_MS) / 60_000;
  return parseFloat((deltaPct / deltaMins).toFixed(4)); // %/min
}

// ── colour helpers ────────────────────────────────────────────────
const REC_META = {
  scale_up:   { label: "Scale Up",   color: "#ef4444", bg: "rgba(239,68,68,0.12)"  },
  scale_down: { label: "Scale Down", color: "#3b82f6", bg: "rgba(59,130,246,0.12)" },
  stable:     { label: "Stable",     color: "#22c55e", bg: "rgba(34,197,94,0.12)"  },
};
const TREND_ICON  = { rising: "↑", falling: "↓", flat: "→" };
const TREND_COLOR = { rising: "#ef4444", falling: "#3b82f6", flat: "#94a3b8" };

function pctColor(v) {
  if (v >= 80) return "#ef4444";
  if (v >= 60) return "#f59e0b";
  return "#22c55e";
}

function fdColor(v) {
  if (v >= FD_CRIT) return "#ef4444";
  if (v >= FD_WARN) return "#f59e0b";
  return "#22c55e";
}

// ── Sparkline ─────────────────────────────────────────────────────
function Sparkline({ points, width = 120, height = 36, predicted }) {
  if (!points?.length) return null;
  const min = Math.min(...points, 0), max = Math.max(...points, 1);
  const rng = max - min || 1;
  const toX = (i) => (i / (points.length - 1)) * width;
  const toY = (v)  => height - ((v - min) / rng) * height;
  const d   = points.map((v, i) =>
    `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`).join(" ");
  const area = d + ` L ${toX(points.length-1).toFixed(1)} ${height} L ${toX(0).toFixed(1)} ${height} Z`;
  const predX = toX(points.length - 1);
  const predY = toY(Math.min(100, Math.max(0, predicted)));
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={`sg-${width}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#6366f1" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg-${width})`} />
      <path d={d} fill="none" stroke="#6366f1" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={predX} cy={predY} r="4"
        fill={pctColor(predicted)} stroke="#0f172a" strokeWidth="1.5" />
    </svg>
  );
}

// ── GaugeArc ──────────────────────────────────────────────────────
function GaugeArc({ value, size = 52, color }) {
  const r      = size / 2 - 5;
  const circ   = Math.PI * r;
  const filled = (Math.min(100, Math.max(0, value)) / 100) * circ;
  const c      = color ?? pctColor(value);
  return (
    <svg width={size} height={size / 2 + 8} viewBox={`0 0 ${size} ${size / 2 + 8}`}>
      <path d={`M 5 ${size/2+2} A ${r} ${r} 0 0 1 ${size-5} ${size/2+2}`}
        fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" strokeLinecap="round" />
      <path d={`M 5 ${size/2+2} A ${r} ${r} 0 0 1 ${size-5} ${size/2+2}`}
        fill="none" stroke={c} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${filled} ${circ}`}
        style={{ transition: "stroke-dasharray 0.6s ease" }} />
      <text x={size/2} y={size/2+3} textAnchor="middle"
        fontSize="11" fontWeight="700" fill={c}>{value}%</text>
    </svg>
  );
}

// ── NEW: Memory Leak Banner ───────────────────────────────────────
function LeakBanner({ rate }) {
  if (rate === null || rate < MEM_LEAK_RATE) return null;
  const isCrit = rate >= MEM_LEAK_RATE * 3;
  return (
    <div style={{
      marginTop: 10,
      padding: "8px 12px",
      borderRadius: 8,
      borderLeft: `3px solid ${isCrit ? "#ef4444" : "#f59e0b"}`,
      background: isCrit ? "rgba(239,68,68,0.1)" : "rgba(245,158,11,0.1)",
      fontSize: 11,
      lineHeight: 1.6,
      color: isCrit ? "#fca5a5" : "#fcd34d",
    }}>
      {isCrit ? "🔴" : "🟡"} <strong>Memory leak suspected</strong> — growing at{" "}
      <strong>{rate.toFixed(3)}%/min</strong>.
      {isCrit
        ? " Container will exhaust memory soon. Restart recommended."
        : " Monitor closely. If rate persists, consider restarting."}
    </div>
  );
}

// ── NEW: FD Monitor Card ──────────────────────────────────────────
function FdCard({ fdHistory }) {
  if (!fdHistory || fdHistory.length === 0) return null;

  const current = fdHistory[fdHistory.length - 1];
  const pred    = olsPredict(fdHistory);
  const color   = fdColor(current);

  // mini bar (relative to FD_CRIT)
  const barPct  = Math.min(100, (current / FD_CRIT) * 100);

  return (
    <div style={{ ...styles.metricCard, gridColumn: "1 / -1" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={styles.metricLabel}>FILE DESCRIPTORS</span>
        <span style={{ ...styles.badge, color, background: color + "22" }}>
          {current >= FD_CRIT ? "Critical" : current >= FD_WARN ? "Warning" : "Normal"}
        </span>
      </div>

      {/* bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 6px" }}>
        <div style={{
          flex: 1, height: 8, background: "#0f172a",
          borderRadius: 999, overflow: "hidden",
        }}>
          <div style={{
            width: `${barPct}%`, height: "100%",
            background: color, borderRadius: 999,
            transition: "width 0.5s ease",
          }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color, minWidth: 40, textAlign: "right" }}>
          {current}
        </span>
      </div>

      <div style={{ display: "flex", gap: 16, fontSize: 10, color: "#475569" }}>
        <span>Warn at {FD_WARN}</span>
        <span>Critical at {FD_CRIT}</span>
        {pred && (
          <span style={{ marginLeft: "auto" }}>
            Projected in {HORIZON_MIN}min:{" "}
            <strong style={{ color: fdColor(pred.predictedValue * (FD_CRIT / 100)) }}>
              {Math.round(pred.predictedValue * (FD_CRIT / 100))}
            </strong>
          </span>
        )}
        <span style={{ marginLeft: pred ? 0 : "auto" }}>{fdHistory.length} samples</span>
      </div>

      {current >= FD_WARN && (
        <div style={{
          marginTop: 8, padding: "6px 10px", borderRadius: 6,
          borderLeft: `3px solid ${color}`,
          background: color + "18",
          fontSize: 11, color: current >= FD_CRIT ? "#fca5a5" : "#fcd34d",
          lineHeight: 1.5,
        }}>
          {current >= FD_CRIT
            ? "🔴 File descriptor count critical. Risk of EMFILE / connection refusal."
            : "🟡 File descriptor count elevated. Monitor for FD leaks."}
        </div>
      )}
    </div>
  );
}

// ── NEW: Mem Rate Card ────────────────────────────────────────────
function MemRateCard({ rateHistory, currentRate }) {
  if (currentRate === null) return null;

  const isLeak = currentRate >= MEM_LEAK_RATE;
  const isCrit = currentRate >= MEM_LEAK_RATE * 3;
  const color  = isCrit ? "#ef4444" : isLeak ? "#f59e0b" : "#22c55e";

  // estimated time to 100% at current rate (from current mem %)
  // We just display the rate cleanly
  return (
    <div style={styles.metricCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={styles.metricLabel}>MEM GROWTH RATE</span>
        <span style={{ ...styles.badge, color, background: color + "22" }}>
          {isCrit ? "Leak Critical" : isLeak ? "Leak Suspected" : "Normal"}
        </span>
      </div>

      <div style={{ margin: "12px 0 6px", display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "monospace" }}>
          {currentRate >= 0 ? "+" : ""}{currentRate.toFixed(3)}
        </span>
        <span style={{ fontSize: 12, color: "#64748b" }}>%/min</span>
      </div>

      {/* mini rate sparkline */}
      {rateHistory.length >= 3 && (
        <Sparkline
          points={rateHistory.slice(-20).map(v => Math.abs(v))}
          predicted={Math.abs(currentRate)}
          width={120}
          height={32}
        />
      )}

      <div style={{ fontSize: 10, color: "#475569", marginTop: 6 }}>
        {isLeak
          ? `At this rate, memory grows ~${(currentRate * 60).toFixed(1)}% per hour`
          : "Memory usage is stable"}
      </div>
    </div>
  );
}

// ── MetricCard (cpu / mem — unchanged from v1) ────────────────────
function MetricCard({ metric, data }) {
  if (!data || data.status !== "ok") {
    return (
      <div style={styles.metricCard}>
        <div style={styles.metricLabel}>{metric.toUpperCase()}</div>
        <div style={{ color: "#64748b", fontSize: 11, marginTop: 4 }}>
          {data?.message ?? `Collecting… (${data?.samples ?? 0}/3 samples)`}
        </div>
      </div>
    );
  }
  const rec        = REC_META[data.recommendation] ?? REC_META.stable;
  const trendColor = TREND_COLOR[data.trend] ?? "#94a3b8";
  return (
    <div style={styles.metricCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={styles.metricLabel}>{metric.toUpperCase()}</span>
        <span style={{ ...styles.badge, color: rec.color, background: rec.bg }}>{rec.label}</span>
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", margin: "8px 0" }}>
        <div style={{ textAlign: "center" }}>
          <GaugeArc value={data.currentValue} />
          <div style={styles.gaugeLabel}>Now</div>
        </div>
        <div style={{ color: "#475569", fontSize: 18, alignSelf: "center", paddingBottom: 14 }}>→</div>
        <div style={{ textAlign: "center" }}>
          <GaugeArc value={data.predictedValue} size={60} />
          <div style={styles.gaugeLabel}>in {data.horizonMinutes} min</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 20, color: trendColor, fontWeight: 700 }}>
            {TREND_ICON[data.trend]}
          </div>
          <div style={{ fontSize: 10, color: "#64748b" }}>
            {data.trendPctPerMin > 0 ? "+" : ""}{data.trendPctPerMin}%/min
          </div>
        </div>
      </div>
      <Sparkline points={data.sparklinePoints} predicted={data.predictedValue} />
      {data.recommendation !== "stable" && (
        <div style={{ ...styles.recDetail, color: rec.color, borderColor: rec.color }}>
          {data.recommendationDetail}
        </div>
      )}
      <div style={styles.r2Row}>
        <span style={{ color: "#475569" }}>R²</span>
        <span style={{ color: data.r2 > 0.7 ? "#22c55e" : "#f59e0b" }}>
          {(data.r2 * 100).toFixed(1)}%
        </span>
        <span style={{ color: "#334155" }}>confidence · {data.samples} samples</span>
      </div>
    </div>
  );
}

// ── ContainerRow ──────────────────────────────────────────────────
function ContainerRow({ name, cpuHistory, memHistory, fdHistory, rateHistory }) {
  const [open, setOpen] = useState(false);

  const cpuPred  = olsPredict(cpuHistory);
  const memPred  = olsPredict(memHistory);
  const memRate  = computeMemRate(memHistory);
  const curFd    = fdHistory.length ? fdHistory[fdHistory.length - 1] : 0;

  // overall risk score — highest of all signals
  const isLeaking   = memRate !== null && memRate >= MEM_LEAK_RATE;
  const fdAlert     = curFd >= FD_WARN;
  const cpuHigh     = cpuPred?.recommendation === "scale_up";
  const memHigh     = memPred?.recommendation === "scale_up";

  const riskLevel =
    (memRate !== null && memRate >= MEM_LEAK_RATE * 3) || curFd >= FD_CRIT ? "critical"
    : isLeaking || fdAlert || cpuHigh || memHigh                            ? "warning"
    :                                                                         "safe";

  const riskColor = riskLevel === "critical" ? "#ef4444"
                  : riskLevel === "warning"  ? "#f59e0b"
                  :                            "#22c55e";

  // summary badges for collapsed row
  const badges = [];
  if (cpuHigh)   badges.push({ txt: "CPU↑",   color: "#ef4444" });
  if (memHigh)   badges.push({ txt: "MEM↑",   color: "#ef4444" });
  if (isLeaking) badges.push({ txt: "LEAK",   color: "#f59e0b" });
  if (fdAlert)   badges.push({ txt: `FD:${curFd}`, color: fdColor(curFd) });

  // build metric objects for MetricCard
  const cpuData = cpuPred ?? { status: "insufficient_data", samples: cpuHistory.length,
    message: `Collecting… (${cpuHistory.length}/3)` };
  const memData = memPred ?? { status: "insufficient_data", samples: memHistory.length,
    message: `Collecting… (${memHistory.length}/3)` };

  return (
    <div style={{
      ...styles.containerRow,
      borderColor: riskLevel === "critical" ? "rgba(239,68,68,0.5)"
                 : riskLevel === "warning"  ? "rgba(245,158,11,0.4)"
                 : "#1e293b",
    }}>
      <button style={styles.rowHeader} onClick={() => setOpen(o => !o)}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: riskColor,
            flexShrink: 0,
            animation: riskLevel === "critical" ? "pulse-dot 2s ease-in-out infinite" : "none",
          }} />
          <span style={styles.containerName}>{name}</span>
          {badges.map(b => (
            <span key={b.txt} style={{ ...styles.badge, color: b.color, background: b.color + "22" }}>
              {b.txt}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {cpuPred && (
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              CPU → <strong style={{ color: pctColor(cpuPred.predictedValue) }}>
                {cpuPred.predictedValue}%
              </strong>
            </span>
          )}
          {memPred && (
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              MEM → <strong style={{ color: pctColor(memPred.predictedValue) }}>
                {memPred.predictedValue}%
              </strong>
            </span>
          )}
          <span style={{ color: "#475569", fontSize: 13 }}>{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <div style={{ padding: "0 12px 14px" }}>
          {/* risk summary bar */}
          {riskLevel !== "safe" && (
            <div style={{
              margin: "8px 0 12px",
              padding: "8px 14px",
              borderRadius: 8,
              background: riskLevel === "critical" ? "rgba(239,68,68,0.1)" : "rgba(245,158,11,0.08)",
              borderLeft: `3px solid ${riskColor}`,
              fontSize: 12,
              color: riskLevel === "critical" ? "#fca5a5" : "#fcd34d",
              display: "flex", gap: 12, flexWrap: "wrap",
            }}>
              <strong>
                {riskLevel === "critical" ? "🔴 High failure risk" : "🟡 Elevated risk"}
              </strong>
              {isLeaking  && <span>Memory leaking at {memRate?.toFixed(3)}%/min</span>}
              {fdAlert    && <span>FD count {curFd} / {FD_CRIT}</span>}
              {cpuHigh    && <span>CPU trending high</span>}
              {memHigh    && <span>Memory trending high</span>}
            </div>
          )}

          {/* metric cards grid */}
          <div style={styles.metricsGrid}>
            <MetricCard metric="cpu" data={cpuData} />
            <MetricCard metric="mem" data={memData} />
            <MemRateCard rateHistory={rateHistory} currentRate={memRate} />
            <FdCard fdHistory={fdHistory} />
          </div>

          {/* leak banner under mem card */}
          <LeakBanner rate={memRate} />
        </div>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────
export default function PredictiveScaling() {
  const historyRef = useRef({});
  // { name: { cpu: [], mem: [], fds: [], mem_rate: [] } }

  const [snap,       setSnap]       = useState({});
  const [loading,    setLoading]    = useState(true);
  const [lastFetch,  setLastFetch]  = useState(null);
  const [error,      setError]      = useState(null);

  const tick = useCallback(async () => {
    try {
      const { data: containers } = await axios.get(`${API}/containers`);

      await Promise.all(
        containers
          .filter(c => c.State === "running")
          .map(async (c) => {
            try {
              const { data } = await axios.get(`${API}/containers/${c.Id}/stats`);

              const cpuDelta = data.cpu_stats.cpu_usage.total_usage
                             - data.precpu_stats.cpu_usage.total_usage;
              const sysDelta = data.cpu_stats.system_cpu_usage
                             - data.precpu_stats.system_cpu_usage;
              const cpu = parseFloat(
                sysDelta > 0
                  ? ((cpuDelta / sysDelta) * data.cpu_stats.online_cpus * 100).toFixed(2)
                  : "0"
              );
              const mem = parseFloat(
                ((data.memory_stats.usage / data.memory_stats.limit) * 100).toFixed(2)
              );
              // file descriptors via pids_stats
              const fds = data.pids_stats?.current ?? 0;

              const name = c.Names[0].replace("/", "");
              if (!historyRef.current[name])
                historyRef.current[name] = { cpu: [], mem: [], fds: [], mem_rate: [] };

              const h = historyRef.current[name];
              h.cpu.push(cpu); if (h.cpu.length > 60) h.cpu.shift();
              h.mem.push(mem); if (h.mem.length > 60) h.mem.shift();
              if (fds > 0) {
                h.fds.push(fds); if (h.fds.length > 60) h.fds.shift();
              }

              // compute mem_rate client-side too
              const rate = computeMemRate(h.mem);
              if (rate !== null) {
                h.mem_rate.push(rate);
                if (h.mem_rate.length > 60) h.mem_rate.shift();
              }
            } catch { /* container gone */ }
          })
      );

      setSnap({ ...historyRef.current });
      setLastFetch(new Date().toLocaleTimeString());
      setError(null);
    } catch {
      setError("Cannot reach backend. Is Docker running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [tick]);

  const entries = Object.entries(snap);

  // summary counts
  const alertCount = entries.filter(([, h]) => {
    const rate = computeMemRate(h.mem);
    const fd   = h.fds.length ? h.fds[h.fds.length - 1] : 0;
    const cpu  = olsPredict(h.cpu);
    const mem  = olsPredict(h.mem);
    return (rate !== null && rate >= MEM_LEAK_RATE)
      || fd >= FD_WARN
      || cpu?.recommendation === "scale_up"
      || mem?.recommendation === "scale_up";
  }).length;

  const leakCount = entries.filter(([, h]) => {
    const rate = computeMemRate(h.mem);
    return rate !== null && rate >= MEM_LEAK_RATE;
  }).length;

  return (
    <div style={styles.panel}>
      {/* header */}
      <div style={styles.panelHeader}>
        <div>
          <h2 style={styles.title}>
            <span style={styles.titleIcon}>📈</span> Forecasting
          </h2>
          <p style={styles.subtitle}>
            OLS regression · leak detection · FD monitoring · {HORIZON_MIN}-min horizon
            {lastFetch && ` · ${lastFetch}`}
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {leakCount > 0 && (
            <div style={{ ...styles.summaryPill, background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
              💧 {leakCount} leak{leakCount > 1 ? "s" : ""} detected
            </div>
          )}
          {alertCount > 0 && (
            <div style={{ ...styles.summaryPill, background: "rgba(239,68,68,0.15)", color: "#ef4444" }}>
              ⚠ {alertCount} alert{alertCount > 1 ? "s" : ""}
            </div>
          )}
          {alertCount === 0 && leakCount === 0 && !loading && entries.length > 0 && (
            <div style={{ ...styles.summaryPill, background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>
              ✓ All containers stable
            </div>
          )}
        </div>
      </div>

      {/* body */}
      {loading ? (
        <div style={styles.loading}>Sampling containers…</div>
      ) : error ? (
        <div style={styles.error}>{error}</div>
      ) : entries.length === 0 ? (
        <div style={styles.empty}>No running containers detected.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {entries.map(([name, h]) => (
            <ContainerRow
              key={name}
              name={name}
              cpuHistory={h.cpu}
              memHistory={h.mem}
              fdHistory={h.fds}
              rateHistory={h.mem_rate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── styles (same tokens as App.css) ──────────────────────────────
const styles = {
  panel: {
    background: "#0d1117", border: "1px solid #1e293b",
    borderRadius: 14, padding: 20,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace", color: "#e2e8f0",
  },
  panelHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    marginBottom: 18, flexWrap: "wrap", gap: 10,
  },
  title: { margin: 0, fontSize: 18, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" },
  titleIcon: { marginRight: 6 },
  subtitle: { margin: "4px 0 0", fontSize: 11, color: "#475569" },
  summaryPill: { padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600 },
  containerRow: {
    background: "#111827", borderRadius: 10,
    border: "1px solid #1e293b", overflow: "hidden",
    transition: "border-color 0.2s",
  },
  rowHeader: {
    width: "100%", display: "flex", justifyContent: "space-between",
    alignItems: "center", padding: "12px 16px",
    background: "none", border: "none", cursor: "pointer", color: "#e2e8f0",
    flexWrap: "wrap", gap: 8,
  },
  containerName: { fontSize: 14, fontWeight: 600 },
  metricsGrid: {
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 10, marginTop: 4,
  },
  metricCard: {
    background: "#0d1117", borderRadius: 8, border: "1px solid #1e293b", padding: 12,
  },
  metricLabel: { fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.08em" },
  badge: { fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, letterSpacing: "0.04em" },
  gaugeLabel: { fontSize: 9, color: "#475569", marginTop: 2 },
  recDetail: {
    fontSize: 10, marginTop: 8, padding: "5px 8px", borderRadius: 6,
    borderLeft: "3px solid", background: "rgba(255,255,255,0.04)", lineHeight: 1.5,
  },
  r2Row: { display: "flex", gap: 6, fontSize: 10, marginTop: 8, color: "#64748b" },
  loading: { color: "#475569", textAlign: "center", padding: 40 },
  error:   { color: "#ef4444", textAlign: "center", padding: 20, fontFamily: "monospace" },
  empty:   { color: "#475569", textAlign: "center", padding: 30, lineHeight: 1.6 },
};