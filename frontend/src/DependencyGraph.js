import { useEffect, useRef, useState } from "react";
import { Network } from "vis-network";
import axios from "axios";

function DependencyGraph({ containers }) {
  const containerRef = useRef(null);
  const networkRef = useRef(null);
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [liveStats, setLiveStats] = useState({});

  useEffect(() => {
    const fetchAllStats = async () => {
      const updated = {};
      await Promise.all(
        containers
          .filter((c) => c.State === "running")
          .map(async (c) => {
            try {
              const res = await axios.get(
                `http://localhost:5000/containers/${c.Id}/stats`
              );
              const data = res.data;
              const cpuDelta =
                data.cpu_stats.cpu_usage.total_usage -
                data.precpu_stats.cpu_usage.total_usage;
              const systemDelta =
                data.cpu_stats.system_cpu_usage -
                data.precpu_stats.system_cpu_usage;
              const cpuPercent =
                systemDelta > 0
                  ? (
                      (cpuDelta / systemDelta) *
                      data.cpu_stats.online_cpus *
                      100
                    ).toFixed(1)
                  : "0.0";
              const memPercent = (
                (data.memory_stats.usage / data.memory_stats.limit) *
                100
              ).toFixed(1);
              const memUsage = (
                data.memory_stats.usage /
                1024 /
                1024
              ).toFixed(1);
            const networks = data.networks || {};
            let rxBytes = 0, txBytes = 0;
            Object.values(networks).forEach((net) => {
                rxBytes += net.rx_bytes || 0;
                txBytes += net.tx_bytes || 0;
            });

            const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
            updated[c.Id] = {
                cpuPercent,
                memPercent,
                memUsage,
                rxMB: toMB(rxBytes),
                txMB: toMB(txBytes),
            };
            } catch {
              updated[c.Id] = { cpuPercent: "0.0", memPercent: "0.0", memUsage: "0.0" };
            }
          })
      );
      setLiveStats(updated);
    };

    fetchAllStats();
    const interval = setInterval(fetchAllStats, 5000);
    return () => clearInterval(interval);
  }, [containers]);

  useEffect(() => {
    if (!containerRef.current || containers.length === 0) return;

    const getNodeColor = (state, cpu, mem) => {
      if (state !== "running") return { bg: "#2d1f1f", border: "#ef4444" };
      const maxLoad = Math.max(Number(cpu || 0), Number(mem || 0));
      if (maxLoad > 80) return { bg: "#2d1a1a", border: "#ef4444" };
      if (maxLoad > 50) return { bg: "#2d2a1a", border: "#f59e0b" };
      return { bg: "#1a2d1a", border: "#22c55e" };
    };

    const getNodeSize = (cpu, mem) => {
      const maxLoad = Math.max(Number(cpu || 0), Number(mem || 0));
      if (maxLoad > 80) return 36;
      if (maxLoad > 50) return 30;
      if (maxLoad > 20) return 26;
      return 22;
    };

    const nodes = containers.map((c) => {
      const stat = liveStats[c.Id];
      const cpu = stat?.cpuPercent || "0.0";
      const mem = stat?.memPercent || "0.0";
      const { bg, border } = getNodeColor(c.State, cpu, mem);
      const size = getNodeSize(cpu, mem);
      const name = c.Names[0].replace("/", "");

      const label =
        c.State === "running"
          ? `${name}\nCPU: ${cpu}%  MEM: ${mem}%`
          : `${name}\n[stopped]`;

      return {
        id: c.Id,
        label,
        color: {
          background: bg,
          border: border,
          highlight: { background: "#1e293b", border: "#38bdf8" },
          hover: { background: "#1e293b", border: "#38bdf8" },
        },
        font: { color: "#f1f5f9", size: 13, multi: false },
        shape: "box",
        margin: { top: 10, bottom: 10, left: 14, right: 14 },
        borderWidth: 2,
        borderWidthSelected: 3,
        size,
        shadow: {
          enabled: true,
          color: border + "55",
          size: 12,
          x: 0,
          y: 0,
        },
      };
    });

    const networkGroups = {};
    containers.forEach((c) => {
      const nets = Object.keys(c.NetworkSettings?.Networks || {});
      nets.forEach((net) => {
        if (!networkGroups[net]) networkGroups[net] = [];
        networkGroups[net].push(c.Id);
      });
    });

    const edges = [];
    let edgeId = 0;
    Object.entries(networkGroups).forEach(([netName, ids]) => {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const sharedCount = Object.values(networkGroups).filter(
            (group) => group.includes(ids[i]) && group.includes(ids[j])
          ).length;
          edges.push({
            id: edgeId++,
            from: ids[i],
            to: ids[j],
            label: netName,
            title: `Network: ${netName}`,
            width: 1 + sharedCount,
            color: { color: "#38bdf8", opacity: 0.5 + sharedCount * 0.15 },
            font: { color: "#94a3b8", size: 11, align: "middle", background: "#0f172a" },
            smooth: { type: "curvedCW", roundness: 0.2 },
            dashes: netName === "bridge",
          });
        }
      }
    });

    const options = {
      physics: {
        enabled: true,
        stabilization: { iterations: 150 },
        barnesHut: {
          gravitationalConstant: -4000,
          springLength: 220,
          springConstant: 0.04,
          damping: 0.2,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 100,
        zoomView: true,
        dragView: true,
      },
      edges: { arrows: { to: { enabled: false } } },
    };

    if (networkRef.current) {
      networkRef.current.setData({ nodes, edges });
    } else {
      networkRef.current = new Network(
        containerRef.current,
        { nodes, edges },
        options
      );

      networkRef.current.on("click", (params) => {
        if (params.nodes.length > 0) {
          const clickedId = params.nodes[0];
          const clicked = containers.find((c) => c.Id === clickedId);
          setSelectedContainer(clicked || null);
        } else {
          setSelectedContainer(null);
        }
      });
    }

    return () => {};
  }, [containers, liveStats]);

  const criticalCount = containers.filter((c) => {
    const s = liveStats[c.Id];
    return s && (Number(s.cpuPercent) > 80 || Number(s.memPercent) > 80);
  }).length;

  const selectedStat = selectedContainer ? liveStats[selectedContainer.Id] : null;
  const selectedName = selectedContainer?.Names[0].replace("/", "");
  const selectedNets = selectedContainer
    ? Object.keys(selectedContainer.NetworkSettings?.Networks || {})
    : [];

  return (
    <section className="graph-section">

      <div className="graph-statusbar">
        <div className="gsb-item">
          <span className="gsb-label">Total</span>
          <strong>{containers.length}</strong>
        </div>
        <div className="gsb-item">
          <span className="gsb-label">Running</span>
          <strong style={{ color: "#22c55e" }}>
            {containers.filter((c) => c.State === "running").length}
          </strong>
        </div>
        <div className="gsb-item">
          <span className="gsb-label">Stopped</span>
          <strong style={{ color: "#64748b" }}>
            {containers.filter((c) => c.State === "exited").length}
          </strong>
        </div>
        <div className="gsb-item">
          <span className="gsb-label">Critical</span>
          <strong style={{ color: criticalCount > 0 ? "#ef4444" : "#22c55e" }}>
            {criticalCount}
          </strong>
        </div>
        {criticalCount > 0 && (
          <div className="gsb-alert">
            {criticalCount} container{criticalCount > 1 ? "s" : ""} need attention
          </div>
        )}
      </div>

      <div className="graph-header">
        <div>
          <h2 className="graph-title">Live Dependency Map</h2>
          <p className="graph-subtitle">
            Nodes resize by load. Click any container to inspect. Updates every 5s.
          </p>
        </div>
        <div className="graph-legend">
          <span className="legend-dot legend-green" /> Healthy
          <span className="legend-dot legend-yellow" /> Medium load
          <span className="legend-dot legend-red" /> Critical
          <span className="legend-dot legend-gray" /> Stopped
        </div>
      </div>

      <div className="graph-wrapper">
        <div ref={containerRef} className="graph-canvas" />

        {selectedContainer && (
          <div className="graph-panel">
            <div className="panel-header">
              <h3>{selectedName}</h3>
              <button
                className="panel-close"
                onClick={() => setSelectedContainer(null)}
              >
                ✕
              </button>
            </div>
            <div className="panel-body">
              <div className="panel-row">
                <span>Status</span>
                <strong
                  style={{
                    color:
                      selectedContainer.State === "running"
                        ? "#22c55e"
                        : "#ef4444",
                  }}
                >
                  {selectedContainer.State}
                </strong>
              </div>
              <div className="panel-row">
                <span>Image</span>
                <strong>{selectedContainer.Image}</strong>
              </div>
              <div className="panel-row">
                <span>ID</span>
                <strong>{selectedContainer.Id.slice(0, 12)}</strong>
              </div>
              {selectedStat && (
                <>
                <div className="panel-row">
                    <span>CPU</span>
                    <strong>{selectedStat.cpuPercent}%</strong>
                </div>
                <div className="panel-row">
                    <span>Network RX</span>
                    <strong style={{ color: "#22c55e" }}>{selectedStat.rxMB} MB</strong>
                </div>
                <div className="panel-row">
                     <span>Network TX</span>
                     <strong style={{ color: "#38bdf8" }}>{selectedStat.txMB} MB</strong>
                </div>
                </>
              )}
              <div className="panel-row">
                <span>Networks</span>
                <strong>{selectedNets.join(", ") || "none"}</strong>
              </div>
              {selectedNets.map((net) => {
                const netInfo =
                  selectedContainer.NetworkSettings.Networks[net];
                return (
                  <div key={net} className="panel-network-block">
                    <p className="panel-net-name">{net}</p>
                    <div className="panel-row">
                      <span>IP Address</span>
                      <strong>{netInfo.IPAddress || "—"}</strong>
                    </div>
                    <div className="panel-row">
                      <span>Gateway</span>
                      <strong>{netInfo.Gateway || "—"}</strong>
                    </div>
                    <div className="panel-row">
                      <span>MAC</span>
                      <strong>{netInfo.MacAddress || "—"}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default DependencyGraph;