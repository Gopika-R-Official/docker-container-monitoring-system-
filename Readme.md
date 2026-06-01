# 🐳 Docker Container Monitoring System

> **"Portainer monitors. We monitor, reason, learn, predict, heal, and explain."**

A production-grade, AI-powered Docker monitoring platform that goes far beyond raw metrics. Built with a multi-engine architecture combining autonomous self-healing, baseline learning, predictive failure detection, and a natural language command interface — all in a lightweight full-stack web application.

---

## 📸 Architecture Overview

```
┌─────────────────────┐        ┌──────────────────────────────────────────┐        ┌─────────────────────┐
│    DOCKER HOST      │        │           NODE.JS BACKEND :5000          │        │   REACT FRONTEND    │
│                     │        │                                          │        │       :3000         │
│  • nginx container  │──────▶ │  ┌─────────────┐  ┌──────────────────┐  │──────▶ │  • Live Dashboard   │
│  • redis container  │  Unix  │  │   Express   │  │  Agentic Engine  │  │  JSON  │  • Dependency Graph │
│  • any container    │ Socket │  │     API     │  │  Healing Engine  │  │        │  • AI Chat Overlay  │
│                     │        │  │             │  │ Baseline Learner │  │        │  • Healing Log      │
│  docker.sock (TLS)  │        │  │             │  │Predictive Engine │  │        │  • Predictive Alerts│
└─────────────────────┘        │  └─────────────┘  └──────────────────┘  │        └─────────────────────┘
                               │         │                                │
                               │  ┌──────┴───────┐  ┌───────────────┐   │
                               │  │  SQLite DBs  │  │   config.js   │   │
                               │  │ chats.db     │  │  (env-based)  │   │
                               │  │ baseline.db  │  └───────────────┘   │
                               │  └──────────────┘                      │
                               └───────────────────┬──────────────────  ┘
                                                   │ LLM Call
                                                   ▼
                                      ┌─────────────────────┐
                                      │     GROQ AI API     │
                                      │   LLaMA 3.3 70B     │
                                      │  • Healing explain  │
                                      │  • Chat responses   │
                                      │  • NL Docker cmds   │
                                      └─────────────────────┘
```

---

## 🚀 Features

### 📊 Live Metrics Dashboard
Real-time CPU, memory, network RX/TX per container — auto-refreshes every 5 seconds with visual threshold alerts (pulsing red border at >80% usage).

### 🗺️ Interactive Dependency Graph
vis.js network graph showing container topology, network relationships, and live load indicators across your Docker environment.

### ▶️ Container Controls
Start, stop, and restart any container directly from the dashboard — no terminal needed.

### 🤖 Agentic Monitoring Engine (`agenticEngine.js`)
A fully autonomous monitoring agent that continuously observes container behaviour, coordinates between the healing, baseline, and predictive engines, and executes corrective actions — all without human intervention.

### 🧠 Baseline Learner (`baselineLearner.js`)
Learns the normal operating patterns of each container over time. Builds a statistical baseline (CPU, memory, network) so anomaly detection is container-specific, not generic.

### 🔮 Predictive Engine (`predictiveEngine.js`)
Uses historical baseline data to forecast potential container failures before they happen — shifting the system from reactive to proactive monitoring.

### 🛠️ Self-Healing Engine (`healingEngine.js`)
Autonomous agent that detects and remediates container failures every 15 seconds. Every action is logged with an AI-generated explanation so you understand *why* it acted.

### 💬 Natural Language Docker Interface (`nl-docker-routes.js`)
Type plain English commands — "restart the nginx container", "show me what's using the most memory" — and the system interprets and executes them via the LLM layer.

### 💬 AI Chat Interface
ChatGPT-style overlay with persistent SQLite history and live container context. Ask questions about your running infrastructure and get intelligent, context-aware answers.

### 🚨 Visual Alert Engine
Pulsing red card borders, predictive warnings, and a real-time healing log — surfacing the right information at the right time.

---

## 🏗️ Project Structure

```
MINIPROJECT/
├── backend/
│   ├── agenticEngine.js       # Autonomous multi-engine coordinator
│   ├── baselineLearner.js     # Statistical baseline profiling per container
│   ├── predictiveEngine.js    # Failure prediction from baseline trends
│   ├── healingEngine.js       # Autonomous self-healing & remediation
│   ├── nl-docker-routes.js    # Natural language → Docker command routing
│   ├── chatStorage.js         # Persistent SQLite chat history
│   ├── docker.js              # Docker socket client (unix socket, not TCP)
│   ├── config.js              # Environment-based configuration
│   ├── index.js               # Express API entry point
│   ├── Dockerfile             # Multi-stage production build
│   ├── .dockerignore
│   ├── tests/                 # Backend test suite
│   └── package.json
│
├── frontend/
│   ├── src/                   # React application
│   ├── nginx.conf             # Production nginx config
│   ├── Dockerfile             # Multi-stage build (build → nginx serve)
│   ├── .dockerignore
│   └── package.json
│
├── docker-compose.yml         # Full stack orchestration
├── .gitignore
└── README.md
```

---

## ⚙️ Getting Started

### Prerequisites
- Docker Engine 20.10+
- Docker Compose v2+
- A [Groq API key](https://console.groq.com) (free tier available)

### 1. Clone the repository

```bash
git clone https://github.com/Gopika-R-Official/docker-container-monitoring-system-.git
cd docker-container-monitoring-system-
```

### 2. Configure environment variables

Create `backend/.env`:

```env
GROQ_API_KEY=your_groq_api_key_here
DOCKER_SOCKET=/var/run/docker.sock
PORT=5000
FRONTEND_ORIGIN=http://localhost:3000
```

Create `frontend/.env`:

```env
REACT_APP_API_URL=http://localhost:5000
```

### 3. Run with Docker Compose

```bash
docker-compose up --build
```

- Frontend: [http://localhost:3000](http://localhost:3000)
- Backend API: [http://localhost:5000](http://localhost:5000)

### 4. Run locally (development)

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm start
```

---

## 🔒 Security

- **Docker socket** is accessed via Unix socket (`/var/run/docker.sock`), **not** the unauthenticated TCP port 2375
- **CORS** is locked to the configured frontend origin via environment variable
- **API keys** are loaded from `.env` — never hardcoded
- `.env` files are listed in `.gitignore` and never committed

---

## 🧪 Testing

```bash
cd backend
npm test
```

Tests cover the healing engine logic, baseline learner calculations, and API route responses.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, vis.js, CSS |
| Backend | Node.js, Express |
| AI / LLM | Groq API — LLaMA 3.3 70B |
| Storage | SQLite (chat history + baseline data) |
| Containerisation | Docker, Docker Compose, nginx |
| Docker Integration | Unix socket (`docker.sock`) |

---

## 🗺️ Roadmap

- [ ] WebSocket / SSE for true real-time updates (replace 5s polling)
- [ ] GitHub Actions CI/CD pipeline
- [ ] Slack / webhook alerting integration
- [ ] Kubernetes mode toggle
- [ ] Historical metrics charting (time-series view)
- [ ] Role-based access control (RBAC)

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 👩‍💻 Author

**Gopika R**
[GitHub](https://github.com/Gopika-R-Official)
