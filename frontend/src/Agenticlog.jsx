/**
 * AgenticLog.jsx
 * ─────────────────────────────────────────────────────────────────
 * Dashboard panel: Visualises the observe→reason→act→reflect loop.
 *
 * Fetches /agentic-log and /anomalies every 10 s.
 * Shows:
 *   • Summary chips (episodes, actions taken, anomalies)
 *   • Episode cards with all four phases rendered inline
 *   • Anomaly ring buffer table
 * ─────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState, useCallback } from "react";

const API = "http://localhost:5000";

const SEV_META = {
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.12)", icon: "🔴" },
  warning:  { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", icon: "🟡" },
};

const ACTION_META = {
  restart:  { color: "#6366f1", icon: "🔄" },
  stop:     { color: "#ef4444", icon: "⏹" },
  start:    { color: "#22c55e", icon: "▶️" },
  none:     { color: "#475569", icon: "💤" },
};

// ── phase pill ────────────────────────────────────────────────────
function Phase({ label, color, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
        color, textTransform: "uppercase", marginBottom: 3,
      }}>
        ◆ {label}
      </div>
      <div style={{
        fontSize: 11, color: "#cbd5e1", lineHeight: 1.6,
        paddingLeft: 10, borderLeft: `2px solid ${color}`,
      }}>
        {children}
      </div>
    </div>
  );
}

// ── episode card ──────────────────────────────────────────────────
function EpisodeCard({ ep }) {
  const [open, setOpen] = useState(false);
  const sev    = SEV_META[ep.severity]  ?? SEV_META.warning;
  const actMeta = ACTION_META[ep.decided_action] ?? ACTION_META.none;

  return (
    <div style={styles.episodeCard}>
      {/* summary row */}
      <button style={styles.epHeader} onClick={() => setOpen(o => !o)}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 14 }}>{sev.icon}</span>
          <span style={styles.epContainer}>{ep.container}</span>
          <span style={{ ...styles.chip, color: sev.color, background: sev.bg }}>
            {ep.metric.toUpperCase()} {ep.value}% · z={ep.z_score}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ ...styles.chip, color: actMeta.color, background: "rgba(255,255,255,0.06)" }}>
            {actMeta.icon} {ep.decided_action}
          </span>
          <span style={{ color: "#334155", fontSize: 11 }}>{ep.time}</span>
          <span style={{ color: "#475569" }}>{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* expanded phases */}
      {open && (
        <div style={styles.epBody}>
          <Phase label="Observe" color="#6366f1">
            Container <strong>{ep.container}</strong> reported{" "}
            <strong style={{ color: sev.color }}>{ep.metric.toUpperCase()} = {ep.value}%</strong>{" "}
            (z-score <strong>{ep.z_score}</strong> · learned mean {ep.mean}% ± {ep.stddev}%).
            Severity: <strong style={{ color: sev.color }}>{ep.severity}</strong>.
          </Phase>

          <Phase label="Reason" color="#8b5cf6">
            <em>Decision:</em> <strong style={{ color: actMeta.color }}>{ep.decided_action}</strong>
            <br />{ep.rationale}
          </Phase>

          <Phase label="Act" color={actMeta.color}>
            {ep.action_skipped
              ? "No action taken (none selected or cooldown active)."
              : ep.action_success
              ? `✓ ${ep.decided_action.toUpperCase()} executed successfully on ${ep.container}.`
              : `✗ Action failed: ${ep.action_error ?? "unknown error"}`}
          </Phase>

          <Phase label="Reflect" color="#0ea5e9">
            {ep.reflection}
          </Phase>
        </div>
      )}
    </div>
  );
}

// ── anomaly table ─────────────────────────────────────────────────
function AnomalyTable({ anomalies }) {
  if (!anomalies.length) {
    return <div style={styles.empty}>No anomalies detected yet.</div>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={styles.table}>
        <thead>
          <tr>
            {["Time", "Container", "Metric", "Value", "Z-score", "Mean ± σ", "Severity", "Handled"].map(h => (
              <th key={h} style={styles.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {anomalies.slice(0, 30).map((a, i) => {
            const sev = SEV_META[a.severity] ?? SEV_META.warning;
            return (
              <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                <td style={styles.td}>{a.time}</td>
                <td style={{ ...styles.td, fontWeight: 600 }}>{a.container_name}</td>
                <td style={styles.td}>{a.metric.toUpperCase()}</td>
                <td style={{ ...styles.td, color: sev.color }}>{a.value}%</td>
                <td style={{ ...styles.td, color: sev.color, fontWeight: 700 }}>{a.z_score}</td>
                <td style={styles.td}>{a.mean}% ± {a.stddev}%</td>
                <td style={styles.td}>
                  <span style={{ ...styles.chip, color: sev.color, background: sev.bg }}>
                    {sev.icon} {a.severity}
                  </span>
                </td>
                <td style={styles.td}>
                  {a.handled
                    ? <span style={{ color: "#22c55e" }}>✓</span>
                    : <span style={{ color: "#475569" }}>–</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── main panel ────────────────────────────────────────────────────
export default function AgenticLog() {
  const [episodes,  setEpisodes]  = useState([]);
  const [anomalies, setAnomalies] = useState([]);
  const [tab, setTab]             = useState("episodes"); // "episodes" | "anomalies"
  const [loading, setLoading]     = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [epRes, anRes] = await Promise.all([
        fetch(`${API}/agentic-log`),
        fetch(`${API}/anomalies`),
      ]);
      setEpisodes(await epRes.json());
      setAnomalies(await anRes.json());
      setLastFetch(new Date().toLocaleTimeString());
    } catch {
      // silently retain stale data
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // summary stats
  const actioned  = episodes.filter(e => !e.action_skipped && e.action_success).length;
  const critical  = anomalies.filter(a => a.severity === "critical").length;
  const warnings  = anomalies.filter(a => a.severity === "warning").length;

  return (
    <div style={styles.panel}>
      {/* header */}
      <div style={styles.panelHeader}>
        <div>
          <h2 style={styles.title}>
            <span>🤖</span> Agentic Loop
          </h2>
          <p style={styles.subtitle}>
            The single brain of your system · Observe → Reason → Act → Reflect
            {lastFetch && ` · ${lastFetch}`}
          </p>
        </div>

        {/* summary chips */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip label={`${episodes.length} episodes`}  color="#6366f1" />
          <Chip label={`${actioned} actions taken`}    color="#22c55e" />
          <Chip label={`${critical} critical`}         color="#ef4444" />
          <Chip label={`${warnings} warnings`}         color="#f59e0b" />
        </div>
      </div>

      {/* tabs */}
      <div style={styles.tabBar}>
        {[
          { key: "episodes",  label: `Episodes (${episodes.length})`  },
          { key: "anomalies", label: `Anomalies (${anomalies.length})` },
        ].map(t => (
          <button
            key={t.key}
            style={{ ...styles.tabBtn, ...(tab === t.key ? styles.tabActive : {}) }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* body */}
      {loading ? (
        <div style={styles.loading}>Loading agentic data…</div>
      ) : tab === "episodes" ? (
        episodes.length === 0
          ? <div style={styles.empty}>No episodes yet. Waiting for anomalies from the baseline learner…</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {episodes.map((ep, i) => <EpisodeCard key={i} ep={ep} />)}
            </div>
      ) : (
        <AnomalyTable anomalies={anomalies} />
      )}
    </div>
  );
}

// ── tiny chip ─────────────────────────────────────────────────────
function Chip({ label, color }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: "3px 10px",
      borderRadius: 12, color,
      background: color + "22",
    }}>
      {label}
    </span>
  );
}

// ── styles ────────────────────────────────────────────────────────
const styles = {
  panel: {
    background:   "#0d1117",
    border:       "1px solid #1e293b",
    borderRadius: 14,
    padding:      20,
    fontFamily:   "'JetBrains Mono', 'Fira Code', monospace",
    color:        "#e2e8f0",
  },
  panelHeader: {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "flex-start",
    marginBottom:   14,
    flexWrap:       "wrap",
    gap:            10,
  },
  title:    { margin: 0, fontSize: 18, fontWeight: 700, color: "#f1f5f9" },
  subtitle: { margin: "4px 0 0", fontSize: 11, color: "#475569" },
  tabBar: {
    display:      "flex",
    gap:          4,
    marginBottom: 14,
    borderBottom: "1px solid #1e293b",
    paddingBottom: 8,
  },
  tabBtn: {
    background:   "none",
    border:       "1px solid #1e293b",
    borderRadius: 6,
    color:        "#64748b",
    fontSize:     12,
    padding:      "4px 14px",
    cursor:       "pointer",
  },
  tabActive: {
    background:  "rgba(99,102,241,0.15)",
    color:       "#a5b4fc",
    borderColor: "#6366f1",
  },
  episodeCard: {
    background:   "#111827",
    border:       "1px solid #1e293b",
    borderRadius: 10,
    overflow:     "hidden",
  },
  epHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    width:          "100%",
    background:     "none",
    border:         "none",
    cursor:         "pointer",
    padding:        "10px 14px",
    color:          "#e2e8f0",
    gap:            8,
  },
  epContainer: { fontSize: 13, fontWeight: 700, color: "#f1f5f9" },
  epBody: {
    padding:    "12px 16px",
    borderTop:  "1px solid #1e293b",
    background: "rgba(0,0,0,0.2)",
  },
  chip: {
    fontSize: 10, fontWeight: 700, padding: "2px 8px",
    borderRadius: 10, whiteSpace: "nowrap",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11 },
  th: {
    textAlign: "left", padding: "6px 10px", color: "#475569",
    fontWeight: 600, borderBottom: "1px solid #1e293b",
    whiteSpace: "nowrap",
  },
  td: { padding: "6px 10px", color: "#94a3b8", verticalAlign: "middle" },
  loading: { color: "#475569", textAlign: "center", padding: 40 },
  empty:   { color: "#475569", textAlign: "center", padding: 30, lineHeight: 1.6 },
};
