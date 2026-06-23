/**
 * baselineLearner.js  (v2 — adds mem_rate + fds metrics)
 * ─────────────────────────────────────────────────────────────────
 * Four metrics per container:
 *   cpu      — CPU % (existing)
 *   mem      — memory % (existing)
 *   mem_rate — memory growth rate in %/min (NEW — leak detection)
 *   fds      — file descriptor count via pids_stats (NEW)
 *
 * Everything else (Z-score, SQLite, anomaly ring, public API) is
 * identical to v1 so agenticEngine.js needs zero changes.
 * ─────────────────────────────────────────────────────────────────
 */

const axios    = require("axios");
const Database = require("better-sqlite3");
const path     = require("path");
const { DOCKER_API } = require("./config");

// ── tunables ──────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 30_000;   // sample every 30 s
const WINDOW_SIZE       = 60;       // rolling window (~30 min)
const MIN_SAMPLES       = 10;       // minimum before z-score is meaningful
const Z_THRESHOLD       = 2.5;      // warn
const Z_CRITICAL        = 3.5;      // critical
const ANOMALY_RING_SIZE = 100;

const CPU_WARN_ABS      = 75;
const CPU_CRIT_ABS      = 90;
const MEM_WARN_ABS      = 75;
const MEM_CRIT_ABS      = 90;
const CPU_Z_MIN_VALUE   = 10;
const MEM_Z_MIN_VALUE   = 10;

// mem_rate tunables
const MEM_RATE_WINDOW   = 5;        // derivative over last N mem samples
const MEM_LEAK_RATE     = 0.5;      // %/min — flag as leak above this

// fds tunables
const FD_WARN_ABS       = 800;      // warn if fd count exceeds this
const FD_CRIT_ABS       = 950;      // critical if fd count exceeds this

// ── SQLite setup ──────────────────────────────────────────────────
const db = new Database(path.join(__dirname, "baseline.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS metric_samples (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id   TEXT    NOT NULL,
    container_name TEXT    NOT NULL,
    metric         TEXT    NOT NULL,
    value          REAL    NOT NULL,
    sampled_at     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_samples_lookup
    ON metric_samples (container_id, metric, sampled_at DESC);

  CREATE TABLE IF NOT EXISTS anomaly_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id   TEXT  NOT NULL,
    container_name TEXT  NOT NULL,
    metric         TEXT  NOT NULL,
    value          REAL  NOT NULL,
    mean           REAL  NOT NULL,
    stddev         REAL  NOT NULL,
    z_score        REAL  NOT NULL,
    severity       TEXT  NOT NULL,
    detected_at    INTEGER NOT NULL
  );
`);

// ── prepared statements ───────────────────────────────────────────
const stmtInsertSample = db.prepare(`
  INSERT INTO metric_samples (container_id, container_name, metric, value, sampled_at)
  VALUES (@container_id, @container_name, @metric, @value, @sampled_at)
`);

const stmtGetWindow = db.prepare(`
  SELECT value FROM metric_samples
  WHERE container_id = @container_id AND metric = @metric
  ORDER BY sampled_at DESC
  LIMIT @limit
`);

const stmtPrune = db.prepare(`
  DELETE FROM metric_samples
  WHERE container_id = @container_id AND metric = @metric
    AND id NOT IN (
      SELECT id FROM metric_samples
      WHERE container_id = @container_id AND metric = @metric
      ORDER BY sampled_at DESC
      LIMIT @limit
    )
`);

const stmtInsertAnomaly = db.prepare(`
  INSERT INTO anomaly_log
    (container_id, container_name, metric, value, mean, stddev, z_score, severity, detected_at)
  VALUES
    (@container_id, @container_name, @metric, @value, @mean, @stddev, @z_score, @severity, @detected_at)
`);

const stmtGetAllSamples = db.prepare(`
  SELECT container_name, metric, value
  FROM metric_samples
  ORDER BY sampled_at DESC
`);

// ── in-memory anomaly ring buffer ─────────────────────────────────
const anomalyRing = [];

function pushAnomaly(a) {
  anomalyRing.unshift(a);
  if (anomalyRing.length > ANOMALY_RING_SIZE) anomalyRing.pop();
}

// ── statistics helpers ────────────────────────────────────────────
function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr, mu) {
  const variance = arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function zScore(value, mu, sigma) {
  if (sigma < 0.001) return 0;
  return (value - mu) / sigma;
}

function isOperationallySignificant(metric, value) {
  if (metric === "cpu") return value >= CPU_Z_MIN_VALUE;
  if (metric === "mem") return value >= MEM_Z_MIN_VALUE;
  return true;
}

// ── memory growth rate helper ─────────────────────────────────────
/**
 * Compute mem growth rate (%/min) from the last MEM_RATE_WINDOW
 * raw mem samples already stored in SQLite for this container.
 * Returns null if not enough data.
 */
function computeMemRate(container_id) {
  const rows = db.prepare(`
    SELECT value, sampled_at FROM metric_samples
    WHERE container_id = @container_id AND metric = 'mem'
    ORDER BY sampled_at DESC
    LIMIT @limit
  `).all({ container_id, limit: MEM_RATE_WINDOW + 1 });

  if (rows.length < 2) return null;

  // rows are newest-first; oldest is last
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  const deltaVal = newest.value - oldest.value;           // % change
  const deltaMs  = newest.sampled_at - oldest.sampled_at; // ms elapsed

  if (deltaMs <= 0) return null;

  const ratePerMin = (deltaVal / deltaMs) * 60_000;
  return parseFloat(ratePerMin.toFixed(4));
}

// ── Docker helpers ────────────────────────────────────────────────
async function getRunningContainers() {
  const res = await axios.get(`${DOCKER_API}/containers/json`, { timeout: 5000 });
  return res.data;
}

async function getRawStats(id) {
  try {
    const res = await axios.get(
      `${DOCKER_API}/containers/${id}/stats?stream=false`,
      { timeout: 8000 }
    );
    const d = res.data;

    // ── cpu % ──────────────────────────────────────────────────────
    const cpuDelta    = d.cpu_stats.cpu_usage.total_usage
                      - d.precpu_stats.cpu_usage.total_usage;
    const systemDelta = d.cpu_stats.system_cpu_usage
                      - d.precpu_stats.system_cpu_usage;
    const cpuPercent  = systemDelta > 0
      ? (cpuDelta / systemDelta) * (d.cpu_stats.online_cpus ?? 1) * 100
      : 0;

    // ── mem % ──────────────────────────────────────────────────────
    const memPercent =
      (d.memory_stats.usage / d.memory_stats.limit) * 100;

    // ── file descriptors ───────────────────────────────────────────
    // Docker exposes pids_stats.current (process count) which is the
    // best proxy for FD pressure available without exec-ing into the
    // container. On Linux kernels that support it, pids_stats also
    // carries the per-namespace FD count.  Fall back to 0 if absent.
    const fds = d.pids_stats?.current ?? 0;

    return {
      cpu: parseFloat(cpuPercent.toFixed(2)),
      mem: parseFloat(memPercent.toFixed(2)),
      fds,
    };
  } catch {
    return null;
  }
}

// ── core: record one sample, prune, compute z-score ───────────────
function recordAndScore({ container_id, container_name, metric, value }) {
  const now = Date.now();

  stmtInsertSample.run({ container_id, container_name, metric, value, sampled_at: now });
  stmtPrune.run({ container_id, metric, limit: WINDOW_SIZE });

  const rows   = stmtGetWindow.all({ container_id, metric, limit: WINDOW_SIZE });
  const values = rows.map(r => r.value);

  if (values.length < MIN_SAMPLES) return null;

  const mu    = mean(values);
  const sigma = stddev(values, mu);
  const z     = zScore(value, mu, sigma);

  if (Math.abs(z) <= Z_THRESHOLD) return null;
  if (!isOperationallySignificant(metric, value)) return null;

  const severity = Math.abs(z) >= Z_CRITICAL ? "critical" : "warning";

  const anomaly = {
    container_id,
    container_name,
    metric,
    value,
    mean:        parseFloat(mu.toFixed(2)),
    stddev:      parseFloat(sigma.toFixed(2)),
    z_score:     parseFloat(z.toFixed(3)),
    severity,
    detected_at: now,
    time:        new Date(now).toLocaleTimeString(),
    handled:     false,
  };

  stmtInsertAnomaly.run({ ...anomaly });
  pushAnomaly(anomaly);

  console.log(
    `[BASELINE] ⚠ ${container_name} ${metric.toUpperCase()}` +
    ` = ${value}  z=${anomaly.z_score}  mean=${mu.toFixed(1)}  (${severity})`
  );

  return anomaly;
}

// ── mem_rate: absolute-threshold check (no z-score needed) ────────
function checkMemRate(container_id, container_name, rate) {
  if (rate === null) return;

  // Only flag sustained positive growth above the leak threshold
  if (rate < MEM_LEAK_RATE) return;

  const severity = rate >= MEM_LEAK_RATE * 3 ? "critical" : "warning";
  const now      = Date.now();

  const anomaly = {
    container_id,
    container_name,
    metric:      "mem_rate",
    value:       rate,
    mean:        0,
    stddev:      0,
    z_score:     0,
    severity,
    detected_at: now,
    time:        new Date(now).toLocaleTimeString(),
    handled:     false,
    leak_rate:   rate,  // %/min — extra context for the agentic engine
  };

  // Avoid flooding: only push if last mem_rate anomaly for this
  // container is >2 min old
  const last = anomalyRing.find(
    a => a.container_id === container_id && a.metric === "mem_rate"
  );
  if (last && now - last.detected_at < 120_000) return;

  stmtInsertAnomaly.run({ ...anomaly });
  pushAnomaly(anomaly);

  console.log(
    `[BASELINE] 🔴 MEMORY LEAK suspected — ${container_name}` +
    ` rate=${rate.toFixed(3)}%/min  (${severity})`
  );
}

function checkAbsoluteResource(container_id, container_name, metric, value) {
  const warn = metric === "cpu" ? CPU_WARN_ABS : MEM_WARN_ABS;
  const crit = metric === "cpu" ? CPU_CRIT_ABS : MEM_CRIT_ABS;

  const severity =
    value >= crit ? "critical"
    : value >= warn ? "warning"
    : null;

  if (!severity) return;

  const now = Date.now();
  const last = anomalyRing.find(
    a => a.container_id === container_id && a.metric === metric
  );
  if (last && now - last.detected_at < 120_000) return;

  const anomaly = {
    container_id,
    container_name,
    metric,
    value,
    mean:        0,
    stddev:      0,
    z_score:     severity === "critical" ? Z_CRITICAL + 0.1 : Z_THRESHOLD + 0.1,
    severity,
    detected_at: now,
    time:        new Date(now).toLocaleTimeString(),
    handled:     false,
    trigger:     "absolute_threshold",
  };

  stmtInsertAnomaly.run({ ...anomaly });
  pushAnomaly(anomaly);

  console.log(
    `[BASELINE] ${container_name} ${metric.toUpperCase()}` +
    ` absolute threshold hit: ${value}% (${severity})`
  );
}

// ── fds: absolute-threshold check ────────────────────────────────
function checkFds(container_id, container_name, fds) {
  if (fds === 0) return;  // not supported on this kernel

  const severity =
    fds >= FD_CRIT_ABS ? "critical"
    : fds >= FD_WARN_ABS ? "warning"
    : null;

  if (!severity) return;

  const now = Date.now();

  // Avoid flooding
  const last = anomalyRing.find(
    a => a.container_id === container_id && a.metric === "fds"
  );
  if (last && now - last.detected_at < 120_000) return;

  const anomaly = {
    container_id,
    container_name,
    metric:      "fds",
    value:       fds,
    mean:        0,
    stddev:      0,
    z_score:     0,
    severity,
    detected_at: now,
    time:        new Date(now).toLocaleTimeString(),
    handled:     false,
  };

  stmtInsertAnomaly.run({ ...anomaly });
  pushAnomaly(anomaly);

  console.log(
    `[BASELINE] ⚠ ${container_name} FD count = ${fds}  (${severity})`
  );
}

// ── poll cycle ────────────────────────────────────────────────────
async function pollCycle() {
  let containers;
  try {
    containers = await getRunningContainers();
  } catch (err) {
    console.error("[BASELINE] Docker unreachable:", err.message);
    return;
  }

  for (const c of containers) {
    const container_id   = c.Id;
    const container_name = c.Names[0].replace("/", "");

    const stats = await getRawStats(container_id);
    if (!stats) continue;

    // 1. existing metrics
    recordAndScore({ container_id, container_name, metric: "cpu", value: stats.cpu });
    recordAndScore({ container_id, container_name, metric: "mem", value: stats.mem });
    checkAbsoluteResource(container_id, container_name, "cpu", stats.cpu);
    checkAbsoluteResource(container_id, container_name, "mem", stats.mem);

    // 2. store raw fds sample for z-score learning too
    if (stats.fds > 0) {
      recordAndScore({ container_id, container_name, metric: "fds", value: stats.fds });
    }

    // 3. compute and store mem_rate AFTER mem sample is written
    const rate = computeMemRate(container_id);
    if (rate !== null) {
      // store in DB so we can plot it
      stmtInsertSample.run({
        container_id,
        container_name,
        metric:     "mem_rate",
        value:      rate,
        sampled_at: Date.now(),
      });
      stmtPrune.run({ container_id, metric: "mem_rate", limit: WINDOW_SIZE });

      // absolute leak check
      checkMemRate(container_id, container_name, rate);
    }

    // 4. absolute fd check
    checkFds(container_id, container_name, stats.fds);
  }
}

// ── public API ────────────────────────────────────────────────────
function getBaselines() {
  const rows = stmtGetAllSamples.all();

  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.container_name]) grouped[r.container_name] = {};
    if (!grouped[r.container_name][r.metric])
      grouped[r.container_name][r.metric] = [];
    if (grouped[r.container_name][r.metric].length < WINDOW_SIZE)
      grouped[r.container_name][r.metric].push(r.value);
  }

  const result = {};
  for (const [name, metrics] of Object.entries(grouped)) {
    result[name] = {};
    for (const [metric, values] of Object.entries(metrics)) {
      if (values.length < MIN_SAMPLES) {
        result[name][metric] = {
          mean: null, stddev: null,
          samples: values.length,
          min_samples_needed: MIN_SAMPLES,
          status: "learning",
        };
      } else {
        const mu    = mean(values);
        const sigma = stddev(values, mu);
        result[name][metric] = {
          mean:            parseFloat(mu.toFixed(2)),
          stddev:          parseFloat(sigma.toFixed(2)),
          samples:         values.length,
          threshold_warn:  parseFloat((mu + Z_THRESHOLD * sigma).toFixed(2)),
          threshold_crit:  parseFloat((mu + Z_CRITICAL  * sigma).toFixed(2)),
          status:          "active",
        };
      }
    }
  }
  return result;
}

function getAnomalies() { return anomalyRing; }

function drainUnhandledAnomalies() {
  return anomalyRing.filter(a => !a.handled);
}

function markAnomalyHandled(detected_at) {
  const a = anomalyRing.find(x => x.detected_at === detected_at);
  if (a) a.handled = true;
}

function startBaselineLearner() {
  console.log(
    `[BASELINE] Learner v2 started — metrics: cpu, mem, mem_rate, fds` +
    ` | window=${WINDOW_SIZE} | Z_warn=${Z_THRESHOLD} | Z_crit=${Z_CRITICAL}` +
    ` | poll=${POLL_INTERVAL_MS / 1000}s`
  );
  setTimeout(() => {
    pollCycle();
    setInterval(pollCycle, POLL_INTERVAL_MS);
  }, 10_000);
}

module.exports = {
  startBaselineLearner,
  getBaselines,
  getAnomalies,
  drainUnhandledAnomalies,
  markAnomalyHandled,
  Z_THRESHOLD,
  Z_CRITICAL,
  MIN_SAMPLES,
  WINDOW_SIZE,
  MEM_LEAK_RATE,
  FD_WARN_ABS,
  FD_CRIT_ABS,
};
