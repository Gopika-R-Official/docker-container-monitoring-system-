# Docker Container Monitoring System

> An intelligent, self-healing Docker infrastructure monitor powered by a statistical anomaly detection engine, an autonomous agentic reasoning loop, and a persistent AI chat interface — built with React, Node.js, and Groq LLaMA 3.3 70B.

[![Tests](https://img.shields.io/badge/tests-10%20passing-brightgreen)](#testing)
[![Node](https://img.shields.io/badge/node-v20-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)

---

## What this is

Most Docker monitoring tools show you raw numbers — CPU at 94%, memory at 2.3GB — but offer no explanation of what those numbers mean, no visual picture of how your containers are connected, and no automated response when something breaks.

This system does all three. It watches your containers, learns what normal looks like for each one, detects real anomalies using statistical deviation (Z-score), reasons about the best fix using an LLM, acts autonomously, then reflects on whether the action worked. A live AI chat interface lets you query your infrastructure in plain English at any time.

---

## Features

### Live Dashboard
- Real-time CPU, memory, and network RX/TX per container — auto-refreshes every 5 seconds
- Color-coded health bars — green below 50%, amber at 50–80%, red above 80%
- Pulsing alert border activates when any metric crosses critical threshold
- One-click start, stop, and restart controls per container

### Interactive Dependency Graph
- vis.js node graph rendering container network topology live
- Node size scales with resource load — overloaded containers appear larger
- Color reflects health: green, amber, red, grey for stopped
- Click any node to inspect IP address, gateway, MAC address, and live metrics

### Statistical Baseline Learner
- Collects metrics every 30 seconds and builds a per-container normal profile
- Tracks CPU, memory, memory rate, and file descriptors
- Uses Z-score deviation to flag what is genuinely anomalous for that specific container
- Distinguishes between a container that normally runs hot versus one that unexpectedly spikes

### Autonomous Agentic Engine (Observe → Reason → Act → Reflect)
- Replaces simple threshold rules with LLM-powered reasoning
- Observes anomalies from the baseline learner
- Reasons about root cause and appropriate action using live context
- Acts via Docker API — restarts, flags, or escalates based on severity
- Reflects on whether the action improved the situation and logs the outcome
- 90-second cooldown prevents restart cascades

### Predictive Scaling
- Linear regression on historical metric data to forecast when a container will hit critical threshold
- Displays time-to-failure estimates on the dashboard before users experience degradation

### Persistent AI Chat Interface
- Full ChatGPT-style overlay accessible from the main dashboard
- Every query answered with live container metrics, dependency data, and healing history as context
- Conversation history stored in SQLite — survives page refresh and server restarts
- Multi-turn context — references earlier messages in the same session
- Natural language container control — type commands, system executes them

---

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐        ┌─────────────────────┐
│    DOCKER HOST      │        │    NODE.JS BACKEND :5000  │        │   REACT FRONTEND    │
│                     │        │                          │        │       :3000         │
│  Any containers     │──────▶ │  Express REST API        │──────▶ │  Live Dashboard     │
│                     │  REST  │  Baseline Learner        │  JSON  │  Dependency Graph   │
│  Docker API :2375   │        │  Agentic Engine          │        │  AI Chat Overlay    │
│                     │        │  Predictive Engine       │        │  Healing Log        │
│                     │        │  SQLite Chat Storage     │        │  Agentic Log        │
└─────────────────────┘        └────────────┬─────────────┘        └─────────────────────┘
                                            │
                                            │ LLM inference
                                            ▼
                               ┌────────────────────────┐
                               │      GROQ AI API       │
                               │   LLaMA 3.3 70B        │
                               │  Reasoning · Chat      │
                               └────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 18, Axios, vis-network | Dashboard UI and dependency graph |
| Backend | Node.js, Express | REST API server |
| AI Inference | Groq API — LLaMA 3.3 70B | Agentic reasoning and chat responses |
| Anomaly Detection | Z-score statistical analysis | Per-container baseline deviation |
| Prediction | Linear regression | Time-to-failure forecasting |
| Database | SQLite via better-sqlite3 | Persistent chat history |
| Containerisation | Docker, Docker Compose | One-command deployment |
| Testing | Jest, Supertest | Unit and integration tests |

---

## Getting Started

### Prerequisites

- [Node.js v20+](https://nodejs.org/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Groq API Key](https://console.groq.com/) — free tier works fine

### Option A — Docker Compose (recommended)

```bash
git clone https://github.com/Gopika-R-Official/docker-container-monitoring-system-.git
cd docker-container-monitoring-system-

# Create your environment file
echo "GROQ_API_KEY=your_key_here" > backend/.env

# Start everything
docker-compose up --build
```

Dashboard opens at `http://localhost:3000`

### Option B — Local development

```bash
# Backend
cd backend
cp .env.example .env
# Edit .env and add your GROQ_API_KEY
npm install
node index.js

# Frontend (new terminal)
cd frontend
npm install
npm start
```

Enable Docker Engine API in Docker Desktop:
Settings → General → ✅ Expose daemon on `tcp://localhost:2375` without TLS

---

## Environment Variables

Create `backend/.env` using `backend/.env.example` as reference:

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ Yes | — | Groq API key for LLM inference |
| `DOCKER_API_URL` | No | `http://localhost:2375` | Docker Engine API endpoint |
| `PORT` | No | `5000` | Backend server port |
| `NODE_ENV` | No | `development` | Environment mode |
| `FRONTEND_URL` | No | `http://localhost:3000` | Allowed CORS origin |

---

## Testing

```bash
cd backend
npm test
```

```
PASS  tests/api.test.js
  Container API
    ✓ GET /containers returns container list
    ✓ GET /containers returns 500 when Docker is unreachable
    ✓ POST /containers/:id/start returns success message
    ✓ POST /containers/:id/stop returns success message
    ✓ POST /containers/:id/restart returns success message
    ✓ GET /healing-log returns array
    ✓ GET /baselines returns object
    ✓ GET /anomalies returns array
    ✓ GET /conversations returns array
    ✓ POST /conversations creates a new conversation

Tests: 10 passed, 10 total
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/containers` | List all containers with status |
| GET | `/containers/:id/stats` | Live CPU, memory, network stats |
| POST | `/containers/:id/start` | Start a container |
| POST | `/containers/:id/stop` | Stop a container |
| POST | `/containers/:id/restart` | Restart a container |
| GET | `/healing-log` | Rule-based healing action history |
| GET | `/baselines` | Learned statistical baselines per container |
| GET | `/anomalies` | Detected anomaly ring buffer |
| GET | `/agentic-log` | Full agentic observe→reason→act→reflect log |
| GET | `/conversations` | List all chat conversations |
| POST | `/conversations` | Create a new conversation |
| GET | `/conversations/:id/messages` | Get messages in a conversation |
| POST | `/conversations/:id/message` | Send a message and get AI response |
| DELETE | `/conversations/:id` | Delete a conversation |

---

## How the Agentic Loop Works

This is the core intelligence of the system and what makes it different from every other free monitoring tool.

```
Every 20 seconds:

1. OBSERVE   — Baseline learner flags a Z-score anomaly for a container
2. REASON    — LLM receives: container name, metric, Z-score, mean, stddev,
                             dependency graph, last 5 actions, severity
               LLM returns: decided_action + rationale
3. ACT       — Backend executes the action via Docker API
4. REFLECT   — 30 seconds later, re-checks the metric
               Did it improve? Logs outcome as success or escalation needed
```

Unlike simple threshold rules (`if CPU > 90% → restart`), the agentic loop understands context. A container that normally runs at 80% CPU is not anomalous at 85%. A container that normally runs at 5% CPU is critically anomalous at 40%. The Z-score baseline makes that distinction automatically.

---

## Project Structure

```
docker-container-monitoring-system/
├── backend/
│   ├── index.js              # Express server and all API routes
│   ├── config.js             # Environment validation and configuration
│   ├── healingEngine.js      # Rule-based self-healing agent
│   ├── baselineLearner.js    # Z-score statistical baseline engine
│   ├── agenticEngine.js      # Observe→Reason→Act→Reflect agentic loop
│   ├── predictiveEngine.js   # Linear regression forecasting
│   ├── chatStorage.js        # SQLite conversation management
│   ├── nl-docker-routes.js   # Natural language container control
│   ├── docker.js             # Docker connection module
│   ├── tests/
│   │   └── api.test.js       # Jest unit and integration tests
│   ├── .env.example          # Environment variable reference
│   ├── Dockerfile            # Backend container definition
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── App.js            # Main dashboard component
│   │   ├── App.css           # Dark theme stylesheet
│   │   ├── DependencyGraph.js # vis.js network graph
│   │   ├── HealingLog.js     # Self-healing log panel
│   │   ├── ChatOverlay.js    # AI chat interface
│   │   └── AgenticLog.js     # Agentic engine log panel
│   ├── Dockerfile            # Multi-stage production build
│   ├── nginx.conf            # Nginx config for React SPA
│   └── package.json
│
├── docker-compose.yml        # One-command deployment
└── README.md
```

---

## SDG Alignment

This project aligns with **UN SDG 9 — Industry, Innovation and Infrastructure**:

- Reduces downtime through autonomous infrastructure healing
- Makes DevOps accessible to developers without prior ops experience
- Optimises compute resource usage through intelligent monitoring
- Fully open-source and free — accessible to students and small teams globally

---

## Roadmap

- [x] Live metrics dashboard with color-coded alerts
- [x] Interactive container dependency graph
- [x] Rule-based self-healing engine
- [x] Statistical baseline learner (Z-score)
- [x] Agentic observe→reason→act→reflect loop
- [x] Predictive failure forecasting
- [x] Persistent AI chat with live container context
- [x] Natural language container control
- [x] Docker Compose deployment
- [x] Unit and integration tests
- [ ] WebSocket real-time push instead of polling
- [ ] Prometheus + Grafana integration
- [ ] Email and webhook alerts
- [ ] Multi-host Docker monitoring
- [ ] Role-based access control

---


## License

MIT — free to use, modify, and distribute.

---

<p align="center">
  Built with React · Node.js · Docker · Groq LLaMA 3.3 70B · vis.js · SQLite · Jest
</p>