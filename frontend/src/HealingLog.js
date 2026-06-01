import { useEffect, useState } from "react";
import api from './api';

function HealingLog() {
  const [logs, setLogs] = useState([]);

  const fetchLogs = async () => {
    try {
      const res = await api.get("/healing-log");
      setLogs(res.data);
    } catch (err) {
      console.error("Failed to fetch healing log");
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="healing-section">
      <div className="healing-header">
        <div>
          <h2 className="graph-title">AI Self-Healing Engine</h2>
          <p className="graph-subtitle">
            Monitors all containers every 15 seconds. Automatically fixes issues and explains every action in plain English.
          </p>
        </div>
        <div className={`healing-status ${logs.length > 0 ? "healing-active" : "healing-idle"}`}>
          <span className="healing-dot" />
          {logs.length > 0 ? "Actions taken" : "All systems healthy"}
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="healing-empty">
          <p>No healing actions yet. The engine is watching your containers.</p>
        </div>
      ) : (
        <div className="healing-log-list">
          {logs.map((log, index) => (
            <div
              key={index}
              className={`healing-card ${log.severity === "critical" ? "healing-card-critical" : "healing-card-warning"}`}
            >
              <div className="healing-card-top">
                <div className="healing-card-left">
                  <span className={`healing-badge ${log.severity === "critical" ? "badge-critical" : "badge-warning"}`}>
                    {log.severity === "critical" ? "AUTO-FIXED" : "WARNING"}
                  </span>
                  <strong className="healing-container-name">{log.container}</strong>
                </div>
                <span className="healing-time">{log.time}</span>
              </div>

              <div className="healing-issue">
                <span className="healing-label">Issue detected</span>
                <p>{log.issue}</p>
              </div>

              <div className="healing-action">
                <span className="healing-label">Action taken</span>
                <p>{log.action}</p>
              </div>

              <div className="healing-explanation">
                <span className="healing-label">AI Explanation</span>
                <p>{log.explanation}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default HealingLog;
