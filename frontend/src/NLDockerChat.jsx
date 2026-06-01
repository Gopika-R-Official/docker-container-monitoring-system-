/**
 * NLDockerChat.jsx
 * ─────────────────────────────────────────────────────────────────
 * Enhanced AI chat overlay with Natural Language → Docker execution.
 *
 * Adds a "⚡ Command Mode" toggle to the existing chat interface.
 * In command mode, messages go to POST /nl-docker instead of
 * POST /conversations/:id/message, and the response shows a
 * structured action confirmation card before the AI answer.
 *
 * Drop this in as a replacement for (or merge with) your existing
 * ChatOverlay / AiChat component. The core chat logic is identical
 * to your current implementation; NL-Docker is a thin layer on top.
 * ─────────────────────────────────────────────────────────────────
 */

import React, {
  useState, useEffect, useRef, useCallback,
} from "react";
import API_BASE from "./config";

// ── small helpers ─────────────────────────────────────────────────
const ACTION_META = {
  restart: { icon: "🔄", color: "#6366f1", label: "Restart" },
  stop:    { icon: "⏹",  color: "#ef4444", label: "Stop"    },
  start:   { icon: "▶️", color: "#22c55e", label: "Start"   },
  status:  { icon: "ℹ️", color: "#3b82f6", label: "Status"  },
  list:    { icon: "📋", color: "#94a3b8", label: "List"    },
  none:    { icon: "💤", color: "#475569", label: "None"    },
};

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── action confirmation card ──────────────────────────────────────
function ActionCard({ result }) {
  const meta = ACTION_META[result.executed_action] ?? ACTION_META.none;

  return (
    <div style={styles.actionCard}>
      <div style={styles.actionHeader}>
        <span style={{ fontSize: 18 }}>{meta.icon}</span>
        <span style={{ ...styles.actionBadge, color: meta.color, borderColor: meta.color + "44" }}>
          {meta.label}
        </span>
        {result.container && (
          <span style={styles.actionTarget}>{result.container}</span>
        )}
        {result.success
          ? <span style={{ color: "#22c55e", fontSize: 12 }}>✓ Success</span>
          : <span style={{ color: "#ef4444", fontSize: 12 }}>✗ Failed</span>}
      </div>
      <p style={styles.actionDetail}>{result.confirm_message}</p>

      {/* list results */}
      {result.data && Array.isArray(result.data) && (
        <div style={styles.listGrid}>
          {result.data.map(c => (
            <div key={c.name} style={styles.listRow}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: c.state === "running" ? "#22c55e" : "#ef4444",
                display: "inline-block", flexShrink: 0,
              }} />
              <span style={{ fontWeight: 600, color: "#e2e8f0" }}>{c.name}</span>
              <span style={{ color: "#475569", marginLeft: "auto" }}>{c.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── message bubble ────────────────────────────────────────────────
function Bubble({ msg }) {
  const isUser = msg.role === "user";
  const isCMD  = msg.role === "command";   // NL→Docker user message
  const isACT  = msg.role === "action";    // action result card

  if (isACT) {
    return (
      <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
        <div style={{ maxWidth: "90%" }}>
          <ActionCard result={msg.result} />
          <div style={styles.ts}>{msg.time}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex",
      justifyContent: isUser || isCMD ? "flex-end" : "flex-start",
      marginBottom: 12,
    }}>
      <div style={{ maxWidth: "80%" }}>
        {!isUser && !isCMD && (
          <div style={styles.senderLabel}>
            {msg.role === "ai" ? "🤖 AI Assistant" : "🐳 Docker Agent"}
          </div>
        )}
        <div style={{
          ...styles.bubble,
          ...(isUser ? styles.bubbleUser : isCMD ? styles.bubbleCMD : styles.bubbleAI),
        }}>
          {isCMD && <span style={styles.cmdIcon}>⚡</span>}
          {msg.content}
        </div>
        <div style={{ ...styles.ts, textAlign: isUser || isCMD ? "right" : "left" }}>
          {msg.time}
        </div>
      </div>
    </div>
  );
}

// ── typing indicator ──────────────────────────────────────────────
function Typing() {
  return (
    <div style={{ display: "flex", marginBottom: 12 }}>
      <div style={{ ...styles.bubble, ...styles.bubbleAI, padding: "10px 14px" }}>
        <span style={styles.typingDot} /><span style={{ ...styles.typingDot, animationDelay: "0.2s" }} />
        <span style={{ ...styles.typingDot, animationDelay: "0.4s" }} />
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────
export default function NLDockerChat({
  conversationId,   // pass in from your parent
  onClose,          // () => void
}) {
  const [messages,    setMessages]    = useState([]);
  const [input,       setInput]       = useState("");
  const [cmdMode,     setCmdMode]     = useState(false);
  const [thinking,    setThinking]    = useState(false);
  const [convs,       setConvs]       = useState([]);
  const [activeConv,  setActiveConv]  = useState(conversationId ?? null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // ── fetch conversation list ──────────────────────────────────────
  const fetchConvs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`);
      setConvs(await res.json());
    } catch { /* offline */ }
  }, []);

  // ── load messages for active conversation ────────────────────────
  const loadMessages = useCallback(async (id) => {
    if (!id) return;
    try {
      const res  = await fetch(`${API_BASE}/conversations/${id}/messages`);
      const data = await res.json();
      setMessages(data.map(m => ({
        role:    m.role,
        content: m.content,
        time:    timeNow(),
      })));
    } catch { /* offline */ }
  }, []);

  // ── new conversation ─────────────────────────────────────────────
  const newConversation = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/conversations`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Chat" }),
      });
      const c = await res.json();
      setActiveConv(c.id);
      setMessages([]);
      await fetchConvs();
    } catch { /* offline */ }
  }, [fetchConvs]);

  useEffect(() => {
    fetchConvs();
    if (activeConv) loadMessages(activeConv);
  }, [fetchConvs, loadMessages, activeConv]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  // ── send ─────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || thinking) return;

    setInput("");
    setThinking(true);

    // ── COMMAND MODE → /nl-docker ─────────────────────────────────
    if (cmdMode) {
      setMessages(prev => [...prev, { role: "command", content: text, time: timeNow() }]);

      try {
        const res  = await fetch(`${API_BASE}/nl-docker`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ command: text }),
        });
        const data = await res.json();

        if (data.error) {
          setMessages(prev => [...prev, {
            role:    "ai",
            content: `⚠️ ${data.error}`,
            time:    timeNow(),
          }]);
        } else {
          setMessages(prev => [...prev, {
            role:   "action",
            result: data,
            time:   timeNow(),
          }]);
        }
      } catch {
        setMessages(prev => [...prev, {
          role:    "ai",
          content: "Command failed — backend unavailable.",
          time:    timeNow(),
        }]);
      } finally {
        setThinking(false);
      }
      return;
    }

    // ── CHAT MODE → /conversations/:id/message ───────────────────
    setMessages(prev => [...prev, { role: "user", content: text, time: timeNow() }]);

    // ensure we have an active conversation
    let convId = activeConv;
    if (!convId) {
      try {
        const res = await fetch(`${API_BASE}/conversations`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ title: "New Chat" }),
        });
        const c = await res.json();
        convId = c.id;
        setActiveConv(c.id);
        await fetchConvs();
      } catch {
        setThinking(false);
        return;
      }
    }

    try {
      const res  = await fetch(`${API_BASE}/conversations/${convId}/message`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ question: text }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: "ai", content: data.answer, time: timeNow() }]);
      fetchConvs();
    } catch {
      setMessages(prev => [...prev, {
        role:    "ai",
        content: "AI is unavailable right now.",
        time:    timeNow(),
      }]);
    } finally {
      setThinking(false);
    }
  }, [input, thinking, cmdMode, activeConv, fetchConvs]);

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // ── suggested commands (shown when input is empty in cmd mode) ──
  const SUGGESTIONS = [
    "restart nginx",
    "stop redis",
    "list all containers",
    "start my-app",
    "status of postgres",
  ];

  // ── render ────────────────────────────────────────────────────────
  return (
    <div style={styles.overlay}>
      {/* sidebar */}
      <div style={{ ...styles.sidebar, width: sidebarOpen ? 220 : 0 }}>
        {sidebarOpen && (
          <>
            <div style={styles.sidebarHeader}>
              <span style={{ fontWeight: 700, color: "#e2e8f0" }}>Chats</span>
              <button style={styles.iconBtn} onClick={newConversation} title="New chat">＋</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {convs.map(c => (
                <button
                  key={c.id}
                  style={{
                    ...styles.convBtn,
                    ...(c.id === activeConv ? styles.convBtnActive : {}),
                  }}
                  onClick={() => { setActiveConv(c.id); loadMessages(c.id); }}
                >
                  <span style={styles.convTitle}>{c.title}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* main chat */}
      <div style={styles.chatPane}>
        {/* header */}
        <div style={styles.chatHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button style={styles.iconBtn} onClick={() => setSidebarOpen(o => !o)}>☰</button>
            <div style={styles.headerLogo}>🐳</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Natural Language Control</div>
              <div style={{ fontSize: 10, color: "#475569" }}>
                {cmdMode ? "Inside chat · executes Docker actions" : "Inside chat · ask questions about the system"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* mode toggle */}
            <button
              style={{ ...styles.modeToggle, ...(cmdMode ? styles.modeToggleActive : {}) }}
              onClick={() => setCmdMode(m => !m)}
              title="Toggle command mode"
            >
              {cmdMode ? "⚡ CMD" : "💬 Chat"}
            </button>
            {onClose && (
              <button style={styles.iconBtn} onClick={onClose}>✕</button>
            )}
          </div>
        </div>

        {/* messages */}
        <div style={styles.messages}>
          {messages.length === 0 && !thinking && (
            <div style={styles.emptyState}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>
                {cmdMode ? "⚡" : "🤖"}
              </div>
              <div style={{ fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>
                {cmdMode ? "Natural Language Control" : "Chat Assistant"}
              </div>
              <div style={{ color: "#334155", fontSize: 12, maxWidth: 280, textAlign: "center" }}>
                {cmdMode
                  ? "Type a natural-language Docker command below. Actions are executed immediately."
                  : "Ask me anything about your containers, metrics, or recent healing events."}
              </div>
              {cmdMode && (
                <div style={styles.suggestionGrid}>
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s}
                      style={styles.suggestion}
                      onClick={() => { setInput(s); inputRef.current?.focus(); }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((m, i) => <Bubble key={i} msg={m} />)}
          {thinking && <Typing />}
          <div ref={bottomRef} />
        </div>

        {/* input row */}
        <div style={{ ...styles.inputRow, borderColor: cmdMode ? "#6366f155" : "#1e293b" }}>
          {cmdMode && <span style={styles.cmdPrefix}>⚡</span>}
          <textarea
            ref={inputRef}
            style={styles.input}
            rows={1}
            placeholder={cmdMode
              ? "e.g. restart nginx  or  stop redis  or  list all containers"
              : "Ask about containers, metrics, healing events…"}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <button
            style={{ ...styles.sendBtn, opacity: (!input.trim() || thinking) ? 0.4 : 1 }}
            onClick={send}
            disabled={!input.trim() || thinking}
          >
            {thinking ? "…" : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────
const styles = {
  overlay: {
    display:       "flex",
    height:        "100%",
    fontFamily:    "'JetBrains Mono', 'Fira Code', monospace",
    background:    "#0a0e17",
    borderRadius:  14,
    overflow:      "hidden",
    border:        "1px solid #1e293b",
  },
  // sidebar
  sidebar: {
    background:     "#0d1117",
    borderRight:    "1px solid #1e293b",
    display:        "flex",
    flexDirection:  "column",
    overflow:       "hidden",
    transition:     "width 0.25s ease",
    flexShrink:     0,
  },
  sidebarHeader: {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "center",
    padding:        "12px 14px",
    borderBottom:   "1px solid #1e293b",
  },
  convBtn: {
    display:     "block",
    width:       "100%",
    padding:     "9px 14px",
    background:  "none",
    border:      "none",
    cursor:      "pointer",
    textAlign:   "left",
    color:       "#64748b",
  },
  convBtnActive: { background: "rgba(99,102,241,0.1)", color: "#a5b4fc" },
  convTitle:     { fontSize: 11, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  // main pane
  chatPane: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  chatHeader: {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "center",
    padding:        "12px 16px",
    borderBottom:   "1px solid #1e293b",
    background:     "#0d1117",
    flexShrink:     0,
  },
  headerLogo: { fontSize: 22 },
  iconBtn: {
    background:   "none",
    border:       "1px solid #1e293b",
    borderRadius: 6,
    color:        "#64748b",
    cursor:       "pointer",
    padding:      "4px 9px",
    fontSize:     13,
  },
  modeToggle: {
    background:   "none",
    border:       "1px solid #1e293b",
    borderRadius: 20,
    color:        "#64748b",
    cursor:       "pointer",
    padding:      "4px 14px",
    fontSize:     11,
    fontWeight:   700,
    transition:   "all 0.2s",
  },
  modeToggleActive: {
    background:   "rgba(99,102,241,0.2)",
    color:        "#a5b4fc",
    borderColor:  "#6366f1",
  },
  // messages area
  messages: {
    flex:       1,
    overflowY:  "auto",
    padding:    "16px",
    display:    "flex",
    flexDirection: "column",
  },
  emptyState: {
    flex:           1,
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    justifyContent: "center",
    padding:        "40px 20px",
  },
  suggestionGrid: {
    display:   "flex",
    flexWrap:  "wrap",
    gap:       6,
    marginTop: 16,
    justifyContent: "center",
  },
  suggestion: {
    background:   "rgba(99,102,241,0.1)",
    border:       "1px solid #6366f133",
    borderRadius: 8,
    color:        "#818cf8",
    cursor:       "pointer",
    fontSize:     10,
    padding:      "5px 10px",
  },
  // bubbles
  senderLabel: { fontSize: 10, color: "#475569", marginBottom: 3 },
  bubble: {
    padding:      "9px 13px",
    borderRadius: 10,
    fontSize:     13,
    lineHeight:   1.6,
    wordBreak:    "break-word",
    whiteSpace:   "pre-wrap",
  },
  bubbleUser: { background: "#1e293b", color: "#e2e8f0" },
  bubbleCMD:  { background: "rgba(99,102,241,0.2)", color: "#c7d2fe", borderLeft: "3px solid #6366f1" },
  bubbleAI:   { background: "#111827", color: "#94a3b8", border: "1px solid #1e293b" },
  cmdIcon:    { marginRight: 6, fontSize: 12 },
  ts:         { fontSize: 9, color: "#334155", marginTop: 3 },
  // typing
  typingDot: {
    display:         "inline-block",
    width:           6,
    height:          6,
    borderRadius:    "50%",
    background:      "#475569",
    marginRight:     3,
    animation:       "bounce 1.2s infinite",
  },
  // action card
  actionCard: {
    background:   "#111827",
    border:       "1px solid #1e293b",
    borderRadius: 10,
    padding:      "12px 14px",
  },
  actionHeader: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    marginBottom: 6,
  },
  actionBadge: {
    fontSize:     10,
    fontWeight:   700,
    padding:      "2px 8px",
    borderRadius: 10,
    border:       "1px solid",
  },
  actionTarget: {
    fontSize:   12,
    fontWeight: 600,
    color:      "#f1f5f9",
  },
  actionDetail: { fontSize: 12, color: "#64748b", margin: 0 },
  listGrid: { display: "flex", flexDirection: "column", gap: 5, marginTop: 8 },
  listRow: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    fontSize:   11,
    color:      "#94a3b8",
  },
  // input
  inputRow: {
    display:      "flex",
    alignItems:   "center",
    gap:          8,
    padding:      "10px 14px",
    borderTop:    "1px solid",
    background:   "#0d1117",
    flexShrink:   0,
    transition:   "border-color 0.2s",
  },
  cmdPrefix: { fontSize: 14, color: "#6366f1", flexShrink: 0 },
  input: {
    flex:       1,
    background: "#111827",
    border:     "1px solid #1e293b",
    borderRadius: 8,
    color:      "#e2e8f0",
    fontSize:   13,
    padding:    "8px 12px",
    resize:     "none",
    outline:    "none",
    fontFamily: "inherit",
    lineHeight: 1.5,
  },
  sendBtn: {
    background:   "#6366f1",
    border:       "none",
    borderRadius: 8,
    color:        "#fff",
    cursor:       "pointer",
    fontSize:     16,
    fontWeight:   700,
    padding:      "7px 14px",
    transition:   "opacity 0.2s",
    flexShrink:   0,
  },
};
