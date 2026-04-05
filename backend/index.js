require("dotenv").config();

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const Groq    = require("groq-sdk");

const {
  createConversation,
  getConversations,
  getMessages,
  addMessage,
  updateConversationTitle,
  deleteConversation,
} = require("./chatStorage");
const nlDockerRoutes = require("./nl-docker-routes");

const { startHealingEngine, getHealingLog } = require("./healingEngine");
const { getPredictions } = require("./predictiveEngine");
// ── NEW: baseline learner + agentic engine ────────────────────────
const {
  startBaselineLearner,
  getBaselines,
  getAnomalies,
} = require("./baselineLearner");

const { startAgenticEngine, getAgenticLog } = require("./agenticEngine");
// ─────────────────────────────────────────────────────────────────

const app        = express();
const DOCKER_API = "http://localhost:2375";

app.use(cors());
app.use(express.json());
app.use(nlDockerRoutes);

// ── existing container routes ─────────────────────────────────────

app.get("/containers", async (req, res) => {
  try {
    const response = await axios.get(`${DOCKER_API}/containers/json?all=true`);
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Failed to fetch containers" });
  }
});

app.get("/containers/:id/stats", async (req, res) => {
  try {
    const response = await axios.get(
      `${DOCKER_API}/containers/${req.params.id}/stats?stream=false`
    );
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.post("/containers/:id/start", async (req, res) => {
  try {
    await axios.post(`${DOCKER_API}/containers/${req.params.id}/start`);
    res.json({ message: "Container started" });
  } catch {
    res.status(500).json({ error: "Failed to start container" });
  }
});

app.post("/containers/:id/stop", async (req, res) => {
  try {
    await axios.post(`${DOCKER_API}/containers/${req.params.id}/stop`);
    res.json({ message: "Container stopped" });
  } catch {
    res.status(500).json({ error: "Failed to stop container" });
  }
});

app.post("/containers/:id/restart", async (req, res) => {
  try {
    await axios.post(`${DOCKER_API}/containers/${req.params.id}/restart`);
    res.json({ message: "Container restarted" });
  } catch {
    res.status(500).json({ error: "Failed to restart container" });
  }
});

// ── existing healing log ──────────────────────────────────────────

app.get("/healing-log", (req, res) => {
  res.json(getHealingLog());
});

// ── NEW: baseline learner routes ──────────────────────────────────

/**
 * GET /baselines
 * Returns learned mean/stddev/thresholds for every container+metric.
 * Used by the dashboard to show adaptive thresholds.
 *
 * Example response:
 * {
 *   "my-app": {
 *     "cpu": { mean: 12.4, stddev: 3.1, threshold_warn: 20.15, threshold_crit: 23.25, samples: 45, status: "active" },
 *     "mem": { mean: 34.2, stddev: 5.0, threshold_warn: 46.7,  threshold_crit: 51.7,  samples: 45, status: "active" }
 *   },
 *   "redis": { "cpu": { status: "learning", samples: 4, min_samples_needed: 10 }, ... }
 * }
 */
app.get("/baselines", (req, res) => {
  res.json(getBaselines());
});

/**
 * GET /anomalies
 * Returns the anomaly ring buffer (newest first, max 100).
 * Each entry: { container_name, metric, value, mean, stddev, z_score,
 *               severity, detected_at, time, handled }
 */
app.get("/anomalies", (req, res) => {
  res.json(getAnomalies());
});

// ── NEW: agentic engine routes ────────────────────────────────────

/**
 * GET /agentic-log
 * Returns the full observe→reason→act→reflect episode log.
 * Each entry: { time, container, metric, value, z_score, mean, stddev,
 *               severity, decided_action, rationale,
 *               action_success, action_skipped, reflection }
 */
app.get("/agentic-log", (req, res) => {
  res.json(getAgenticLog());
});

// ── existing AI chat routes ───────────────────────────────────────

app.post("/ai-chat", async (req, res) => {
  try {
    const { question } = req.body;
    const groqClient   = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const containersRes = await axios.get(`${DOCKER_API}/containers/json?all=true`);
    const containers    = containersRes.data;

    const statsPromises = containers
      .filter(c => c.State === "running")
      .map(async (c) => {
        try {
          const s        = await axios.get(`${DOCKER_API}/containers/${c.Id}/stats?stream=false`);
          const d        = s.data;
          const cpuDelta = d.cpu_stats.cpu_usage.total_usage - d.precpu_stats.cpu_usage.total_usage;
          const sysDelta = d.cpu_stats.system_cpu_usage - d.precpu_stats.system_cpu_usage;
          const cpu      = sysDelta > 0
            ? ((cpuDelta / sysDelta) * d.cpu_stats.online_cpus * 100).toFixed(2)
            : "0.00";
          const mem      = ((d.memory_stats.usage / d.memory_stats.limit) * 100).toFixed(2);
          const memMB    = (d.memory_stats.usage / 1024 / 1024).toFixed(2);
          return { name: c.Names[0].replace("/", ""), cpu, mem, memMB };
        } catch { return null; }
      });

    const statsResults = (await Promise.all(statsPromises)).filter(Boolean);
    const healingLog   = getHealingLog();

    const context = `
You are an intelligent Docker infrastructure assistant. You have access to live data.

LIVE CONTAINER DATA:
${containers.map(c => `- ${c.Names[0].replace("/", "")}: state=${c.State}, image=${c.Image}`).join("\n")}

LIVE METRICS:
${statsResults.map(s => `- ${s.name}: CPU=${s.cpu}%, Memory=${s.mem}% (${s.memMB}MB)`).join("\n")}

RECENT HEALING ACTIONS (last 5):
${healingLog.slice(0, 5).map(l => `- [${l.time}] ${l.container}: ${l.issue} → ${l.action}`).join("\n") || "None"}

Answer the user's question using this live data. Be concise, helpful, and specific.
    `.trim();

    const chat = await groqClient.chat.completions.create({
      messages: [
        { role: "system", content: context },
        { role: "user",   content: question },
      ],
      model: "llama-3.3-70b-versatile",
    });

    res.json({ answer: chat.choices[0]?.message?.content || "No response." });
  } catch (err) {
    console.error("AI chat error:", err.message);
    res.status(500).json({ answer: "AI is unavailable right now." });
  }
});

// ── conversation routes ───────────────────────────────────────────

app.get("/conversations", (req, res) => {
  res.json(getConversations());
});

app.post("/conversations", (req, res) => {
  const convo = createConversation(req.body.title || "New Chat");
  res.json(convo);
});

app.get("/conversations/:id/messages", (req, res) => {
  res.json(getMessages(req.params.id));
});

app.delete("/conversations/:id", (req, res) => {
  deleteConversation(req.params.id);
  res.json({ success: true });
});

app.post("/conversations/:id/message", async (req, res) => {
  try {
    const { question }     = req.body;
    const conversationId   = req.params.id;
    const groqClient       = new Groq({ apiKey: process.env.GROQ_API_KEY });

    addMessage(conversationId, "user", question);

    const msgs = getMessages(conversationId);
    if (msgs.length === 1) {
      const shortTitle = question.length > 40
        ? question.slice(0, 40) + "..."
        : question;
      updateConversationTitle(conversationId, shortTitle);
    }

    const containersRes = await axios.get(`${DOCKER_API}/containers/json?all=true`);
    const containers    = containersRes.data;

    const statsPromises = containers
      .filter(c => c.State === "running")
      .map(async (c) => {
        try {
          const s        = await axios.get(`${DOCKER_API}/containers/${c.Id}/stats?stream=false`);
          const d        = s.data;
          const cpuDelta = d.cpu_stats.cpu_usage.total_usage - d.precpu_stats.cpu_usage.total_usage;
          const sysDelta = d.cpu_stats.system_cpu_usage - d.precpu_stats.system_cpu_usage;
          const cpu      = sysDelta > 0
            ? ((cpuDelta / sysDelta) * d.cpu_stats.online_cpus * 100).toFixed(2)
            : "0.00";
          const mem      = ((d.memory_stats.usage / d.memory_stats.limit) * 100).toFixed(2);
          const memMB    = (d.memory_stats.usage / 1024 / 1024).toFixed(2);
          return { name: c.Names[0].replace("/", ""), cpu, mem, memMB };
        } catch { return null; }
      });

    const statsResults = (await Promise.all(statsPromises)).filter(Boolean);
    const healingLog   = getHealingLog();

    const systemContext = `You are an intelligent Docker infrastructure assistant.

LIVE CONTAINERS:
${containers.map(c => `- ${c.Names[0].replace("/", "")}: state=${c.State}, image=${c.Image}`).join("\n")}

LIVE METRICS:
${statsResults.map(s => `- ${s.name}: CPU=${s.cpu}%, Memory=${s.mem}% (${s.memMB}MB)`).join("\n")}

RECENT HEALING ACTIONS:
${healingLog.slice(0, 5).map(l => `- [${l.time}] ${l.container}: ${l.issue} → ${l.action}`).join("\n") || "None"}

Be concise, specific, and helpful.`;

    const history = msgs.slice(-10).map(m => ({
      role:    m.role === "ai" ? "assistant" : "user",
      content: m.content,
    }));

    const chat = await groqClient.chat.completions.create({
      messages: [{ role: "system", content: systemContext }, ...history],
      model:    "llama-3.3-70b-versatile",
    });

    const answer = chat.choices[0]?.message?.content || "No response.";
    addMessage(conversationId, "ai", answer);

    res.json({ answer });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ answer: "AI is unavailable right now." });
  }
});

// ── boot ──────────────────────────────────────────────────────────
app.listen(5000, () => {
  console.log("Backend running on http://localhost:5000");
});
startHealingEngine();       // existing rule-based engine (kept intact)
startBaselineLearner();     // NEW: Z-score statistical learner
startAgenticEngine();       // NEW: observe→reason→act→reflect loop
