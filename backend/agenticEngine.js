/**
 * agenticEngine.js
 * ─────────────────────────────────────────────────────────────────
 * Observe → Reason → Act → Reflect loop.
 *
 * Observe  — pulls unhandled anomalies from baselineLearner
 * Reason   — sends anomaly + live context to Groq to decide action
 * Act      — executes the chosen Docker action
 * Reflect  — asks Groq to write a plain-language post-mortem and
 *             saves the full episode to agenticLog[]
 * ─────────────────────────────────────────────────────────────────
 */

const axios  = require("axios");
const Groq   = require("groq-sdk");
const { DOCKER_API } = require("./config");
const {
  drainUnhandledAnomalies,
  markAnomalyHandled,
  getBaselines,
} = require("./baselineLearner");

const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const LOOP_INTERVAL_MS = 20_000;   // reason+act every 20 s
const COOLDOWN_MS      = 120_000;  // per-container action cooldown
const LOG_MAX          = 100;

// ── state ─────────────────────────────────────────────────────────
const agenticLog    = [];       // newest first
const lastActedAt   = {};       // containerId → timestamp

// ── Docker action helpers ─────────────────────────────────────────
const ACTIONS = {
  restart: (id) => axios.post(`${DOCKER_API}/containers/${id}/restart`, null, { timeout: 10_000 }),
  stop:    (id) => axios.post(`${DOCKER_API}/containers/${id}/stop`,    null, { timeout: 10_000 }),
  start:   (id) => axios.post(`${DOCKER_API}/containers/${id}/start`,   null, { timeout: 10_000 }),
  none:    ()   => Promise.resolve(),
};

function canAct(containerId) {
  const last = lastActedAt[containerId];
  return !last || Date.now() - last > COOLDOWN_MS;
}

function recordAct(containerId) {
  lastActedAt[containerId] = Date.now();
}

// ── Phase 1 — OBSERVE ─────────────────────────────────────────────
// (handled by baselineLearner; we just call drainUnhandledAnomalies)

// ── Phase 2 — REASON ─────────────────────────────────────────────
/**
 * Ask Groq what action to take for this anomaly.
 * Returns { action: "restart"|"stop"|"start"|"none", rationale: string }
 */
async function reason(anomaly, baselines) {
  const baseline = baselines[anomaly.container_name]?.[anomaly.metric];

  const prompt = `
You are an autonomous Docker operations agent making a real-time decision.

ANOMALY DETECTED:
  Container : ${anomaly.container_name}
  Metric    : ${anomaly.metric.toUpperCase()}
  Value     : ${anomaly.value}%
  Z-score   : ${anomaly.z_score}  (deviation from learned normal)
  Severity  : ${anomaly.severity}

LEARNED BASELINE for this container/metric:
  Mean               : ${baseline?.mean ?? "not yet learned"}%
  Std-dev            : ${baseline?.stddev ?? "N/A"}%
  Warn threshold     : ${baseline?.threshold_warn ?? "N/A"}%
  Critical threshold : ${baseline?.threshold_crit ?? "N/A"}%
  Samples in window  : ${baseline?.samples ?? 0}

AVAILABLE ACTIONS: restart | stop | start | none

Rules:
- Prefer "restart" for high CPU/memory anomalies (z > 3.5).
- Use "none" for borderline warnings (2.5 < z < 3.0) and just log.
- Never stop a container unless it is clearly hung (mem > 98% sustained).
- If unsure, choose "none" and explain why.

Respond with ONLY a valid JSON object — no markdown, no explanation outside JSON:
{
  "action": "<restart|stop|start|none>",
  "rationale": "<one concise sentence>"
}
`.trim();

  try {
    const chat = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 200,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });

    const raw  = chat.choices[0]?.message?.content?.trim() ?? "{}";
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return {
      action:    ACTIONS[json.action] ? json.action : "none",
      rationale: json.rationale ?? "No rationale provided.",
    };
  } catch (err) {
    console.error("[AGENTIC] Reason phase error:", err.message);
    return { action: "none", rationale: "Reasoning failed — defaulting to no action." };
  }
}

// ── Phase 3 — ACT ────────────────────────────────────────────────
async function act(action, containerId) {
  if (action === "none") return { success: true, skipped: true };
  try {
    await ACTIONS[action](containerId);
    recordAct(containerId);
    return { success: true, skipped: false };
  } catch (err) {
    console.error(`[AGENTIC] Act failed (${action} ${containerId}):`, err.message);
    return { success: false, skipped: false, error: err.message };
  }
}

// ── Phase 4 — REFLECT ────────────────────────────────────────────
async function reflect(anomaly, decision, actResult) {
  const prompt = `
You are a senior SRE writing a post-action note for a junior developer.

WHAT HAPPENED:
  Container "${anomaly.container_name}" showed abnormal ${anomaly.metric.toUpperCase()} usage.
  Measured value  : ${anomaly.value}%
  Z-score         : ${anomaly.z_score}  (normal band is ±2.5 standard deviations)
  Learned mean    : ${anomaly.mean}%  ± ${anomaly.stddev}%

DECISION TAKEN: ${decision.action}
RATIONALE     : ${decision.rationale}
ACTION RESULT : ${actResult.skipped ? "No action taken" : actResult.success ? "Succeeded" : `Failed — ${actResult.error}`}

Write 2-3 plain-English sentences: what the anomaly means, why the action was/wasn't taken, and what to watch for next. 
Be friendly and educational.
`.trim();

  try {
    const chat = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    return chat.choices[0]?.message?.content?.trim() ?? "Reflection unavailable.";
  } catch {
    return `Action "${decision.action}" was taken on ${anomaly.container_name}.`;
  }
}

// ── main loop iteration ───────────────────────────────────────────
async function runAgenticCycle() {
  const unhandled = drainUnhandledAnomalies();
  if (unhandled.length === 0) return;

  const baselines = getBaselines();

  for (const anomaly of unhandled) {
    // mark handled immediately so parallel cycles don't double-process
    markAnomalyHandled(anomaly.detected_at);

    // skip if we recently acted on this container
    if (!canAct(anomaly.container_id)) {
      console.log(`[AGENTIC] Cooldown active for ${anomaly.container_name} — skipping`);
      continue;
    }

    console.log(`[AGENTIC] Processing anomaly: ${anomaly.container_name} ${anomaly.metric} z=${anomaly.z_score}`);

    // — Reason —
    const decision  = await reason(anomaly, baselines);

    // — Act —
    const actResult = await act(decision.action, anomaly.container_id);

    // — Reflect —
    const reflection = await reflect(anomaly, decision, actResult);

    // — Log episode —
    const episode = {
      time:           new Date().toLocaleTimeString(),
      timestamp:      Date.now(),
      container:      anomaly.container_name,
      metric:         anomaly.metric,
      value:          anomaly.value,
      z_score:        anomaly.z_score,
      mean:           anomaly.mean,
      stddev:         anomaly.stddev,
      severity:       anomaly.severity,
      // reason
      decided_action: decision.action,
      rationale:      decision.rationale,
      // act
      action_success: actResult.success,
      action_skipped: actResult.skipped,
      action_error:   actResult.error ?? null,
      // reflect
      reflection,
    };

    agenticLog.unshift(episode);
    if (agenticLog.length > LOG_MAX) agenticLog.pop();

    console.log(
      `[AGENTIC] Episode complete — ${anomaly.container_name}` +
      ` | action=${decision.action} | success=${actResult.success}`
    );
  }
}

// ── public API ────────────────────────────────────────────────────
function getAgenticLog() {
  return agenticLog;
}

function startAgenticEngine() {
  console.log(`[AGENTIC] Engine started — loop every ${LOOP_INTERVAL_MS / 1000}s`);
  // first run after 15 s (baseline learner needs to boot first)
  setTimeout(() => {
    runAgenticCycle();
    setInterval(runAgenticCycle, LOOP_INTERVAL_MS);
  }, 15_000);
}

module.exports = { startAgenticEngine, getAgenticLog };
