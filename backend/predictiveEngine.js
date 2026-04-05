/**
 * predictiveEngine.js
 * ─────────────────────────────────────────────────────────────────
 * Linear-regression–based predictive scaling for Docker containers.
 *
 * Reads historical metric_samples from the baselineLearner SQLite DB,
 * fits a least-squares regression line over the most-recent N samples,
 * and extrapolates to HORIZON_MINUTES in the future.
 *
 * Exposed via GET /predictions (mounted in index.js).
 * ─────────────────────────────────────────────────────────────────
 */

const Database = require("better-sqlite3");
const path     = require("path");

// ── tunables ──────────────────────────────────────────────────────
const REGRESSION_WINDOW   = 30;   // use last 30 samples for the fit
const HORIZON_MINUTES     = 15;   // predict this many minutes ahead
const POLL_INTERVAL_S     = 30;   // must match baselineLearner
const SCALE_UP_THRESHOLD  = 80;   // % — warn if prediction exceeds this
const SCALE_DOWN_THRESHOLD = 20;  // % — suggest scale-down below this

// ── reuse the same DB file as the baseline learner ────────────────
const db = new Database(path.join(__dirname, "baseline.db"), { readonly: true });

const stmtGetRecent = db.prepare(`
  SELECT value, sampled_at
  FROM   metric_samples
  WHERE  container_name = @name AND metric = @metric
  ORDER  BY sampled_at DESC
  LIMIT  @limit
`);

// ── math helpers ─────────────────────────────────────────────────

/**
 * Ordinary Least Squares on (x[], y[]) — returns { slope, intercept, r2 }
 */
function linearRegression(x, y) {
  const n  = x.length;
  if (n < 2) return { slope: 0, intercept: y[0] ?? 0, r2: 0 };

  const mx = x.reduce((a, v) => a + v, 0) / n;
  const my = y.reduce((a, v) => a + v, 0) / n;

  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }

  const slope     = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2        = syy === 0 ? 1 : (sxy ** 2) / (sxx * syy);

  return {
    slope:     parseFloat(slope.toFixed(6)),
    intercept: parseFloat(intercept.toFixed(4)),
    r2:        parseFloat(r2.toFixed(4)),
  };
}

/**
 * Clamp a percent value to [0, 100].
 */
function clampPct(v) {
  return Math.min(100, Math.max(0, parseFloat(v.toFixed(2))));
}

// ── core prediction for one container + metric ────────────────────

function predictOne(containerName, metric) {
  // fetch newest-first; reverse to get chronological order
  const rows = stmtGetRecent
    .all({ name: containerName, metric, limit: REGRESSION_WINDOW })
    .reverse();

  if (rows.length < 3) {
    return {
      status:  "insufficient_data",
      samples: rows.length,
      message: `Need at least 3 samples (have ${rows.length})`,
    };
  }

  // convert absolute timestamps → relative seconds from first sample
  const t0   = rows[0].sampled_at;
  const xRaw = rows.map(r => (r.sampled_at - t0) / 1000);   // seconds
  const y    = rows.map(r => r.value);

  const { slope, intercept, r2 } = linearRegression(xRaw, y);

  // project HORIZON_MINUTES into the future
  const horizonSeconds    = HORIZON_MINUTES * 60;
  const lastX             = xRaw[xRaw.length - 1];
  const predictedX        = lastX + horizonSeconds;
  const rawPrediction     = slope * predictedX + intercept;
  const predictedValue    = clampPct(rawPrediction);
  const currentValue      = clampPct(y[y.length - 1]);

  // build a mini sparkline (8 evenly-spaced regression points for the UI)
  const sparklinePoints = Array.from({ length: 8 }, (_, i) => {
    const sx = (i / 7) * predictedX;
    return clampPct(slope * sx + intercept);
  });

  // recommendation
  let recommendation = "stable";
  let recommendationDetail = "No scaling action needed.";

  if (predictedValue >= SCALE_UP_THRESHOLD) {
    recommendation       = "scale_up";
    recommendationDetail =
      `${metric.toUpperCase()} is projected to hit ${predictedValue}% ` +
      `in ~${HORIZON_MINUTES} min. Consider scaling up or restarting.`;
  } else if (predictedValue <= SCALE_DOWN_THRESHOLD && currentValue <= SCALE_DOWN_THRESHOLD) {
    recommendation       = "scale_down";
    recommendationDetail =
      `${metric.toUpperCase()} is predicted to stay below ${predictedValue}% — ` +
      `container may be over-provisioned.`;
  }

  // trend direction
  const trendPctPerMin = slope * 60;  // % per minute
  const trend =
    Math.abs(trendPctPerMin) < 0.05 ? "flat"
    : trendPctPerMin >  0           ? "rising"
    :                                 "falling";

  return {
    status:          "ok",
    samples:         rows.length,
    currentValue,
    predictedValue,
    horizonMinutes:  HORIZON_MINUTES,
    trendPctPerMin:  parseFloat(trendPctPerMin.toFixed(3)),
    trend,
    slope,
    intercept,
    r2,
    recommendation,
    recommendationDetail,
    sparklinePoints,
  };
}

// ── public API ────────────────────────────────────────────────────

/**
 * Returns predictions for every container × metric that has data.
 *
 * Shape:
 * {
 *   "my-app": {
 *     cpu: { status, currentValue, predictedValue, trend, recommendation, sparklinePoints, … },
 *     mem: { … }
 *   }
 * }
 */
function getPredictions() {
  // discover distinct container_name / metric pairs from the DB
  const pairs = db.prepare(`
    SELECT DISTINCT container_name, metric
    FROM   metric_samples
    ORDER  BY container_name, metric
  `).all();

  const result = {};
  for (const { container_name, metric } of pairs) {
    if (!result[container_name]) result[container_name] = {};
    result[container_name][metric] = predictOne(container_name, metric);
  }
  return result;
}

module.exports = { getPredictions };