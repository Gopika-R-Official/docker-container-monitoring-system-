const express = require("express");
const axios = require("axios");
const { DOCKER_API } = require("./config");

const router = express.Router();

function getContainerName(container) {
  return container.Names?.[0]?.replace(/^\//, "") || container.Id.slice(0, 12);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/\b(container|service|docker|please|the|a|an)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseCommand(command) {
  const text = String(command || "").trim();
  if (!text) {
    return { error: "Please enter a Docker command." };
  }

  if (
    /\b(list|show|display)\b/.test(text.toLowerCase()) &&
    /\b(containers?|services?)\b/.test(text.toLowerCase())
  ) {
    return { action: "list" };
  }

  const actionMatchers = [
    { action: "restart", regex: /\brestart\b/i },
    { action: "stop", regex: /\bstop\b/i },
    { action: "start", regex: /\bstart\b/i },
    { action: "status", regex: /\b(status|state)\b/i },
  ];

  const matched = actionMatchers.find(({ regex }) => regex.test(text));
  if (!matched) {
    return {
      error: "Try a command like 'stop nginx', 'restart redis', 'status of postgres', or 'list containers'.",
    };
  }

  let target = text;

  if (matched.action === "status") {
    target = target
      .replace(/\bwhat(?:'s| is)?\b/gi, " ")
      .replace(/\b(check|show|tell me|give me)\b/gi, " ")
      .replace(/\b(status|state)\b/gi, " ")
      .replace(/\b(of|for)\b/gi, " ")
      .replace(/\b(is it|is)\b/gi, " ")
      .replace(/\b(running|stopped|healthy|up|down)\b/gi, " ");
  } else {
    target = target.replace(new RegExp(`\\b${matched.action}\\b`, "i"), " ");
  }

  target = target
    .replace(/\b(of|for|container|service|docker|please|now)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!target && matched.action !== "list") {
    return { error: `Please tell me which container to ${matched.action}.` };
  }

  return { action: matched.action, target };
}

function scoreContainer(container, target) {
  const name = getContainerName(container);
  const image = String(container.Image || "").split(":")[0];

  const normalizedTarget = normalizeText(target);
  const normalizedName = normalizeText(name);
  const normalizedImage = normalizeText(image);

  if (!normalizedTarget) return 0;
  if (normalizedName === normalizedTarget) return 100;
  if (normalizedImage === normalizedTarget) return 95;
  if (normalizedName.startsWith(normalizedTarget)) return 90;
  if (normalizedImage.startsWith(normalizedTarget)) return 85;
  if (normalizedName.includes(normalizedTarget)) return 80;
  if (normalizedImage.includes(normalizedTarget)) return 70;

  const targetParts = normalizedTarget.split(" ").filter(Boolean);
  if (targetParts.length > 0 && targetParts.every((part) => normalizedName.includes(part))) {
    return 60;
  }

  return 0;
}

function resolveContainer(target, containers) {
  const ranked = containers
    .map((container) => ({ container, score: scoreContainer(container, target) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      error: `I couldn't find a container matching "${target}".`,
    };
  }

  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    const options = ranked.slice(0, 4).map(({ container }) => getContainerName(container));
    return {
      error: `That matches multiple containers: ${options.join(", ")}.`,
    };
  }

  return { container: ranked[0].container };
}

async function listContainers() {
  const response = await axios.get(`${DOCKER_API}/containers/json?all=true`, { timeout: 10000 });
  return response.data;
}

async function executeDockerAction(action, containerId) {
  await axios.post(`${DOCKER_API}/containers/${containerId}/${action}`, null, { timeout: 10000 });
}

router.post("/nl-docker", async (req, res) => {
  const parsed = parseCommand(req.body?.command);
  if (parsed.error) {
    return res.status(400).json({
      success: false,
      executed_action: "none",
      confirm_message: parsed.error,
      error: parsed.error,
    });
  }

  try {
    const containers = await listContainers();

    if (parsed.action === "list") {
      const data = containers.map((container) => ({
        name: getContainerName(container),
        state: container.State,
      }));

      return res.json({
        success: true,
        executed_action: "list",
        confirm_message: `Found ${data.length} container${data.length === 1 ? "" : "s"}.`,
        data,
      });
    }

    const resolved = resolveContainer(parsed.target, containers);
    if (resolved.error) {
      return res.status(404).json({
        success: false,
        executed_action: parsed.action,
        confirm_message: resolved.error,
        error: resolved.error,
      });
    }

    const container = resolved.container;
    const containerName = getContainerName(container);

    if (parsed.action === "status") {
      const confirmMessage = `${containerName} is currently ${container.State}.`;
      return res.json({
        success: true,
        executed_action: "status",
        container: containerName,
        confirm_message: confirmMessage,
        data: [
          {
            name: containerName,
            state: container.State,
          },
        ],
      });
    }

    if (parsed.action === "start" && container.State === "running") {
      return res.json({
        success: true,
        executed_action: "start",
        container: containerName,
        confirm_message: `${containerName} is already running.`,
      });
    }

    if (parsed.action === "stop" && container.State !== "running") {
      return res.json({
        success: true,
        executed_action: "stop",
        container: containerName,
        confirm_message: `${containerName} is already stopped.`,
      });
    }

    await executeDockerAction(parsed.action, container.Id);

    const actionPastTense = {
      start: "started",
      stop: "stopped",
      restart: "restarted",
    }[parsed.action];

    return res.json({
      success: true,
      executed_action: parsed.action,
      container: containerName,
      confirm_message: `${containerName} ${actionPastTense} successfully.`,
    });
  } catch (error) {
    console.error("[NL-DOCKER] Request failed:", error.message);
    return res.status(500).json({
      success: false,
      executed_action: parsed.action || "none",
      confirm_message: "Unable to reach Docker right now.",
      error: "Unable to reach Docker right now. Make sure Docker Desktop is running and port 2375 is available.",
    });
  }
});

module.exports = router;
