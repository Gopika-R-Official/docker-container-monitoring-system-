# 🐳 Docker Container Monitoring System
### with AI-Powered Diagnostics, Autonomous Self-Healing & Interactive Dependency Mapping

> **"Portainer monitors. We monitor, reason, heal, and explain."**

A lightweight, web-based Docker monitoring system that goes beyond raw metrics — delivering real-time container health, visual network dependency mapping, an autonomous AI self-healing engine, and a persistent AI chat interface powered by Groq LLaMA 3.3 70B.

---

## 📸 Features at a Glance

| Feature | Description |
|---|---|
| 📊 **Live Metrics Dashboard** | Real-time CPU, memory, network RX/TX per container — auto-refreshes every 5s |
| 🗺 **Interactive Dependency Graph** | vis.js node graph showing container network topology with live load indicators |
| ▶ **Container Controls** | Start, stop, restart any container directly from the dashboard |
| 🚨 **Visual Alert Engine** | Pulsing red card border when CPU or memory exceeds 80% |
| 🤖 **AI Self-Healing Engine** | Autonomous agent that detects and fixes container failures every 15 seconds |
| 💬 **AI Chat Interface** | ChatGPT-style overlay with persistent SQLite history and live container context |

---

## 🏗 System Architecture

```
┌─────────────────────┐        ┌─────────────────────┐        ┌─────────────────────┐
│    DOCKER HOST      │        │  NODE.JS BACKEND    │        │   REACT FRONTEND    │
│                     │        │      :5000          │        │       :3000         │
│  • nginx container  │──────▶ │  • Express API      │──────▶ │  • Live Dashboard   │
│  • redis container  │  REST  │  • Axios HTTP       │  JSON  │  • Dependency Graph │
│  • any container    │  API   │  • Healing Engine   │        │  • AI Chat Overlay  │
│                     │        │  • SQLite Storage   │        │  • Healing Log      │
│  Docker API :2375   │        │                     │        │                     │
└─────────────────────┘        └──────────┬──────────┘        └─────────────────────┘
                                          │
                                          │ LLM Call
                                          ▼
                               ┌─────────────────────┐
                               │     GROQ AI API     │
                               │  LLaMA 3.3 70B      │
                               │  • Healing explain  │
                               │  • Chat responses   │
                               └─────────────────────┘






