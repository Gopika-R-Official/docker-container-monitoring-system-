import { useCallback, useEffect, useState } from "react";
import api from './api';
import "./App.css";
import DependencyGraph from "./DependencyGraph";
import PredictiveScaling from "./PredictiveScaling";
import AgenticLog from "./Agenticlog";
import NLDockerChat from "./NLDockerChat";

function App() {
  const [containers, setContainers] = useState([]);
  const [stats, setStats] = useState({});
  const [chatOpen, setChatOpen] = useState(false);
  const [predictOpen, setPredictOpen] = useState(false);

  const fetchStats = useCallback(async (id) => {
    try {
      const res = await api.get(`/containers/${id}/stats`);
      const data = res.data;

      const cpuDelta =
        data.cpu_stats.cpu_usage.total_usage - data.precpu_stats.cpu_usage.total_usage;
      const systemDelta =
        data.cpu_stats.system_cpu_usage - data.precpu_stats.system_cpu_usage;
      const cpuPercent =
        systemDelta > 0
          ? ((cpuDelta / systemDelta) * data.cpu_stats.online_cpus * 100).toFixed(2)
          : "0.00";

      const memUsage = (data.memory_stats.usage / 1024 / 1024).toFixed(2);
      const memLimit = (data.memory_stats.limit / 1024 / 1024).toFixed(2);
      const memPercent = ((data.memory_stats.usage / data.memory_stats.limit) * 100).toFixed(2);

      const networks = data.networks || {};
      let rxBytes = 0;
      let txBytes = 0;

      Object.values(networks).forEach((net) => {
        rxBytes += net.rx_bytes || 0;
        txBytes += net.tx_bytes || 0;
      });

      const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);

      setStats((prev) => ({
        ...prev,
        [id]: {
          cpuPercent,
          memUsage,
          memLimit,
          memPercent,
          rxMB: toMB(rxBytes),
          txMB: toMB(txBytes),
        },
      }));
    } catch (err) {
      console.error("Failed to fetch stats for", id, err);
    }
  }, []);

  const fetchContainers = useCallback(async () => {
    try {
      const res = await api.get("/containers");
      setContainers(res.data);

      res.data.forEach((container) => {
        if (container.State === "running") {
          fetchStats(container.Id);
        }
      });
    } catch (err) {
      console.error("Failed to fetch containers", err);
    }
  }, [fetchStats]);

  const controlContainer = useCallback(
    async (id, action) => {
      try {
        await api.post(`/containers/${id}/${action}`);
        setTimeout(() => {
          fetchContainers();
        }, 1000);
      } catch (err) {
        console.error(`Failed to ${action} container`, err);
      }
    },
    [fetchContainers]
  );

  useEffect(() => {
    fetchContainers();
    const interval = setInterval(fetchContainers, 5000);
    return () => clearInterval(interval);
  }, [fetchContainers]);

  const getStatusClass = (state) => {
    if (state === "running") return "status status-running";
    if (state === "exited") return "status status-stopped";
    return "status status-warning";
  };

  const getBarColorClass = (percent) => {
    const value = Number(percent);
    if (value > 80) return "meter-fill meter-fill-danger";
    if (value > 50) return "meter-fill meter-fill-warning";
    return "meter-fill meter-fill-safe";
  };

  const runningCount = containers.filter((container) => container.State === "running").length;


  return (
    <>
      <main className="dashboard">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Container Health</p>
            <h1>Docker Monitor</h1>
           
          </div>

          <div className="hero-stats">
            <article className="hero-stat-card">
              <span className="hero-stat-label">Total Containers</span>
              <strong>{containers.length}</strong>
            </article>
            <article className="hero-stat-card">
              <span className="hero-stat-label">Running Now</span>
              <strong>{runningCount}</strong>
            </article>
          </div>

          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <button className="open-chat-btn" onClick={() => setChatOpen(true)}>
              Open Chat
            </button>
            <button className="open-predict-btn" onClick={() => setPredictOpen(true)}>
              Forecasting
            </button>
          </div>
        </section>

     

        {containers.length === 0 ? (
          <section className="empty-state">
            <h2>No containers found</h2>
            <p>Start Docker or create a container to see live metrics here.</p>
          </section>
        ) : (
          <section className="card-grid">
            {containers.map((container) => {
              const stat = stats[container.Id];
              const containerName = container.Names[0].replace("/", "");

              return (
                <article
                  key={container.Id}
                  className={`container-card ${
                    stat && (Number(stat.cpuPercent) > 80 || Number(stat.memPercent) > 80)
                      ? "container-card-alert"
                      : ""
                  }`}
                >
                  <div className="card-top">
                    <div>
                      <h2>{containerName}</h2>
                      <p className="image-name">{container.Image}</p>
                    </div>
                    <span className={getStatusClass(container.State)}>{container.State}</span>
                  </div>

                  <div className="card-meta">
                    <div>
                      <span className="meta-label">Container ID</span>
                      <span className="meta-value">{container.Id.slice(0, 12)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Status</span>
                      <span className="meta-value">{container.Status}</span>
                    </div>
                  </div>

                  <div className="control-buttons">
                    {container.State === "running" && (
                      <button
                        className="btn btn-stop"
                        onClick={() => controlContainer(container.Id, "stop")}
                      >
                        Stop
                      </button>
                    )}
                    {container.State === "exited" && (
                      <button
                        className="btn btn-start"
                        onClick={() => controlContainer(container.Id, "start")}
                      >
                        Start
                      </button>
                    )}
                    <button
                      className="btn btn-restart"
                      onClick={() => controlContainer(container.Id, "restart")}
                    >
                      Restart
                    </button>
                  </div>

                  {stat ? (
                    <div className="metrics">
                      <div className="metric-block">
                        <div className="metric-header">
                          <span>CPU Usage</span>
                          <strong>{stat.cpuPercent}%</strong>
                        </div>
                        <div className="meter">
                          <div
                            className={getBarColorClass(stat.cpuPercent)}
                            style={{ width: `${Math.min(Number(stat.cpuPercent), 100)}%` }}
                          />
                        </div>
                      </div>

                      <div className="metric-block">
                        <div className="metric-header">
                          <span>Memory Usage</span>
                          <strong>{stat.memPercent}%</strong>
                        </div>
                        <div className="meter">
                          <div
                            className={getBarColorClass(stat.memPercent)}
                            style={{ width: `${Math.min(Number(stat.memPercent), 100)}%` }}
                          />
                        </div>
                        <p className="memory-copy">
                          {stat.memUsage} MB used of {stat.memLimit} MB
                        </p>
                      </div>

                      <div className="metric-block">
                        <div className="metric-header">
                          <span>Network RX</span>
                          <strong style={{ color: "#22c55e" }}>{stat.rxMB} MB</strong>
                        </div>
                        <div className="metric-header">
                          <span>Network TX</span>
                          <strong style={{ color: "#38bdf8" }}>{stat.txMB} MB</strong>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="inactive-note">
                      Container is not running right now, so live stats are unavailable.
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )}

        <DependencyGraph containers={containers} />
        <AgenticLog />
      </main>

      {chatOpen && (
        <div className="overlay-backdrop" onClick={() => setChatOpen(false)}>
          <div className="overlay-container" onClick={(event) => event.stopPropagation()}>
            <NLDockerChat onClose={() => setChatOpen(false)} />
          </div>
        </div>
      )}

      {predictOpen && (
        <div className="overlay-backdrop" onClick={() => setPredictOpen(false)}>
          <div
            className="overlay-container predict-overlay-container"
            onClick={(event) => event.stopPropagation()}
            style={{ padding: 16, overflowY: "auto" }}
          >
            <PredictiveScaling />
          </div>
        </div>
      )}
    </>
  );
}

export default App;
