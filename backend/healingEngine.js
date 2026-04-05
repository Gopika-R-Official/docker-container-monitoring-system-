const axios = require("axios");
const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
console.log("GROQ KEY loaded:", process.env.GROQ_API_KEY ? "YES" : "NO");


const DOCKER_API = "http://localhost:2375";

const healingLog = [];
const lastHealedAt = {};

async function getContainers() {
  const res = await axios.get(`${DOCKER_API}/containers/json?all=true`);
  return res.data;
}

async function getStats(id) {
  try {
    const res = await axios.get(`${DOCKER_API}/containers/${id}/stats?stream=false`);
    const data = res.data;
    const cpuDelta = data.cpu_stats.cpu_usage.total_usage - data.precpu_stats.cpu_usage.total_usage;
    const systemDelta = data.cpu_stats.system_cpu_usage - data.precpu_stats.system_cpu_usage;
    const cpuPercent = systemDelta > 0
      ? ((cpuDelta / systemDelta) * data.cpu_stats.online_cpus * 100).toFixed(2)
      : "0.00";
    const memPercent = ((data.memory_stats.usage / data.memory_stats.limit) * 100).toFixed(2);
    return { cpuPercent, memPercent };
  } catch {
    return null;
  }
}

async function restartContainer(id) {
  await axios.post(`${DOCKER_API}/containers/${id}/restart`);
}

async function startContainer(id) {
  await axios.post(`${DOCKER_API}/containers/${id}/start`);
}

async function getAIExplanation(containerName, issue, action) {
  try {
    
    const chat = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: `You are a Docker infrastructure assistant. A container called "${containerName}" had this issue: "${issue}". The system automatically took this action: "${action}". In 2-3 sentences, explain what happened and why this action helps. Use simple language a junior developer would understand.`
        }
      ],
      model: 'llama-3.3-70b-versatile',
    });
    return chat.choices[0]?.message?.content || "Action taken successfully.";
  } catch {
    return `Auto-action taken: ${action}`;
  }
}

async function buildDependencyOrder(containers) {
  const order = [];
  const networks = {};

  containers.forEach((c) => {
    const nets = Object.keys(c.NetworkSettings?.Networks || {});
    nets.forEach((net) => {
      if (!networks[net]) networks[net] = [];
      networks[net].push(c);
    });
  });

  Object.values(networks).forEach((group) => {
    group.forEach((c) => {
      if (!order.find((o) => o.Id === c.Id)) order.push(c);
    });
  });

  return order;
}

function canHeal(id) {
  const COOLDOWN_MS = 90000; // 90 seconds cooldown between heals
  const last = lastHealedAt[id];
  if (!last) return true;
  return Date.now() - last > COOLDOWN_MS;
}

function markHealed(id) {
  lastHealedAt[id] = Date.now();
}

async function runHealingCycle() {
  try {
    const containers = await getContainers();
    const dependencyOrder = await buildDependencyOrder(containers);

    for (const container of dependencyOrder) {
      const name = container.Names[0].replace("/", "");
      const id = container.Id;

      // AUTO HEAL 1 — crashed container, restart it
      if (container.State === "exited") {
        if (canHeal(id)) {
          markHealed(id);
          const explanation = await getAIExplanation(
            name,
            "container stopped unexpectedly",
            "automatically restarted the container"
          );
          await startContainer(id);
          healingLog.unshift({
            time: new Date().toLocaleTimeString(),
            container: name,
            issue: "Container crashed or stopped",
            action: "Auto-restarted",
            explanation,
            severity: "critical",
          });
          console.log(`[HEALED] ${name} — restarted after crash`);
        }
        continue;
      }

      // AUTO HEAL 2 — high CPU or memory
      if (container.State === "running") {
        const stats = await getStats(id);
        if (!stats) continue;

        const cpu = Number(stats.cpuPercent);
        const mem = Number(stats.memPercent);

        if (cpu > 90 || mem > 90) {
          if (canHeal(id)) {
            markHealed(id);
            const issue = cpu > 90
              ? `CPU usage critically high at ${cpu}%`
              : `Memory usage critically high at ${mem}%`;
            const explanation = await getAIExplanation(
              name,
              issue,
              "restarted the container to clear resource overload"
            );
            await restartContainer(id);
            healingLog.unshift({
              time: new Date().toLocaleTimeString(),
              container: name,
              issue,
              action: "Auto-restarted due to overload",
              explanation,
              severity: "critical",
            });
            console.log(`[HEALED] ${name} — restarted due to overload`);
          }
        } else if (cpu > 75 || mem > 75) {
          // only log warning once every 90 seconds too
          if (canHeal(`warn_${id}`)) {
            markHealed(`warn_${id}`);
            healingLog.unshift({
              time: new Date().toLocaleTimeString(),
              container: name,
              issue: `High resource usage — CPU: ${cpu}%, MEM: ${mem}%`,
              action: "Flagged for monitoring — no restart needed yet",
              explanation: `${name} is under elevated load but not critical yet. Watching closely and will auto-restart if it crosses 90%.`,
              severity: "warning",
            });
          }
        }
      }
    }

    if (healingLog.length > 50) healingLog.splice(50);

  } catch (err) {
    console.error("Healing cycle error:", err.message);
  }
}

function getHealingLog() {
  return healingLog;
}

function startHealingEngine() {
  console.log("AI Healing Engine started...");
   setTimeout(() => {
  runHealingCycle();
  setInterval(runHealingCycle, 15000);
  },5000);
}

module.exports = { startHealingEngine, getHealingLog };