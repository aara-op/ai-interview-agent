import * as React from "react";
import { Link } from "react-router-dom";
import { CubeWave } from "@/components/ui/cube-wave";
import {
  Sparkles,
  Building2,
  UserCheck,
  ArrowRight,
  ShieldAlert,
  FileText,
  BarChart3,
  Camera,
  Bot,
  Sliders,
  Maximize2,
  Lock,
} from "lucide-react";

/** Role chooser: the app opens on two clearly separated doors blended with an interactive 3D wave. */
export default function Home() {
  const [speed, setSpeed] = React.useState(0.9);
  const [grid, setGrid] = React.useState(16);
  const [showControls, setShowControls] = React.useState(false);

  return (
    <div className="chooser">
      {/* 3D Ambient Wave Canvas Background */}
      <div className="chooser-bg">
        <CubeWave
          key={`${grid}-${speed}`}
          grid={grid}
          gap={0.78}
          speed={speed}
          className="w-full h-full"
        />
      </div>

      {/* Floating 3D Controls Pill */}
      <div
        style={{
          position: "fixed",
          top: "18px",
          right: "22px",
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <button
          onClick={() => setShowControls((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "12px",
            padding: "8px 14px",
            borderRadius: "999px",
            background: "rgba(20, 26, 44, 0.75)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "var(--text)",
            cursor: "pointer",
            transition: "all 0.2s ease",
          }}
          title="Tweak 3D Wave parameters"
        >
          <Sliders size={13} className="text-indigo-400" />
          <span>3D Wave FX</span>
        </button>

        <Link
          to="/demo"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "12px",
            padding: "8px 14px",
            borderRadius: "999px",
            background: "rgba(20, 26, 44, 0.75)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "var(--accent)",
            textDecoration: "none",
            transition: "all 0.2s ease",
          }}
          title="View Fullscreen 3D demo"
        >
          <Maximize2 size={13} />
          <span>Fullscreen</span>
        </Link>
      </div>

      {/* Popover Controls Menu */}
      {showControls && (
        <div
          style={{
            position: "fixed",
            top: "60px",
            right: "22px",
            zIndex: 50,
            width: "240px",
            padding: "16px",
            borderRadius: "14px",
            background: "rgba(15, 20, 36, 0.9)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            boxShadow: "0 18px 40px rgba(0, 0, 0, 0.5)",
            color: "var(--text)",
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "10px", color: "var(--muted)" }}>
            WAVE SPEED: {speed.toFixed(1)}x
          </div>
          <div style={{ display: "flex", gap: "6px", marginBottom: "14px" }}>
            {[0.5, 0.9, 1.4].map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  fontSize: "11px",
                  borderRadius: "6px",
                  border: speed === s ? "1px solid var(--accent)" : "1px solid var(--line)",
                  background: speed === s ? "rgba(91, 140, 255, 0.2)" : "rgba(20, 26, 44, 0.6)",
                  color: speed === s ? "#fff" : "var(--muted)",
                  cursor: "pointer",
                }}
              >
                {s}x
              </button>
            ))}
          </div>

          <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "10px", color: "var(--muted)" }}>
            GRID MATRIX: {grid}×{grid}
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {[12, 16, 20].map((g) => (
              <button
                key={g}
                onClick={() => setGrid(g)}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  fontSize: "11px",
                  borderRadius: "6px",
                  border: grid === g ? "1px solid var(--accent)" : "1px solid var(--line)",
                  background: grid === g ? "rgba(91, 140, 255, 0.2)" : "rgba(20, 26, 44, 0.6)",
                  color: grid === g ? "#fff" : "var(--muted)",
                  cursor: "pointer",
                }}
              >
                {g}²
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Foreground Content with Frosted Glassmorphism */}
      <div className="chooser-content">
        <div style={{ marginBottom: "12px" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 14px",
              borderRadius: "999px",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              background: "rgba(124, 92, 255, 0.12)",
              border: "1px solid rgba(124, 92, 255, 0.28)",
              color: "#a78bfa",
              backdropFilter: "blur(12px)",
            }}
          >
            <Sparkles size={13} />
            Autonomous AI Interview System
          </span>
        </div>

        <div className="chooser-head">
          <span
            className="brand-mark"
            style={{
              fontSize: 42,
              filter: "drop-shadow(0 0 20px rgba(124, 92, 255, 0.5))",
              display: "inline-block",
              marginBottom: "4px",
            }}
          >
            ◈
          </span>
          <h1
            style={{
              fontSize: "36px",
              fontWeight: 750,
              letterSpacing: "-0.03em",
              background: "linear-gradient(180deg, #ffffff 40%, #c4b5fd 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              marginBottom: "8px",
            }}
          >
            AI Video Interview Agent
          </h1>
          <p
            className="muted"
            style={{
              maxWidth: "600px",
              fontSize: "16px",
              lineHeight: 1.6,
              margin: "0 auto",
            }}
          >
            End-to-end intelligent voice interviews, real-time computer vision proctoring,
            and objective evidence-based evaluation.
          </p>
        </div>

        {/* Portals Grid */}
        <div className="chooser-grid">
          {/* Recruiter Card */}
          <Link className="chooser-card recruiter" to="/dashboard">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "12px",
                  background: "rgba(91, 140, 255, 0.14)",
                  border: "1px solid rgba(91, 140, 255, 0.28)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)",
                }}
              >
                <Building2 size={22} />
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: "var(--accent)",
                  background: "rgba(91, 140, 255, 0.1)",
                  padding: "4px 8px",
                  borderRadius: "6px",
                }}
              >
                RECRUITER
              </span>
            </div>

            <h2 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "12px" }}>
              Interviewer Dashboard
            </h2>

            <ul className="rules" style={{ listStyle: "none", padding: 0 }}>
              <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                <FileText size={15} style={{ flexShrink: 0, marginTop: "4px", color: "var(--accent)" }} />
                <span>Configure roles, parse resumes/JDs and customize rubrics</span>
              </li>
              <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                <BarChart3 size={15} style={{ flexShrink: 0, marginTop: "4px", color: "var(--accent)" }} />
                <span>Review scores, evidence quotes, and recruiter overrides</span>
              </li>
              <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: "4px", color: "var(--accent)" }} />
                <span>Examine proctoring timelines, frame captures & telemetry</span>
              </li>
            </ul>

            <span className="cta">
              Open recruiter dashboard <ArrowRight size={16} />
            </span>
          </Link>

          {/* Candidate Card */}
          <Link className="chooser-card candidate" to="/candidate">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "12px",
                  background: "rgba(46, 207, 142, 0.14)",
                  border: "1px solid rgba(46, 207, 142, 0.28)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--ok)",
                }}
              >
                <UserCheck size={22} />
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: "var(--ok)",
                  background: "rgba(46, 207, 142, 0.1)",
                  padding: "4px 8px",
                  borderRadius: "6px",
                }}
              >
                CANDIDATE
              </span>
            </div>

            <h2 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "12px" }}>
              Candidate Workspace
            </h2>

            <ul className="rules" style={{ listStyle: "none", padding: 0 }}>
              <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                <Camera size={15} style={{ flexShrink: 0, marginTop: "4px", color: "var(--ok)" }} />
                <span>Hardware check: test microphone, webcam & optional phone camera</span>
              </li>
              <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                <Bot size={15} style={{ flexShrink: 0, marginTop: "4px", color: "var(--ok)" }} />
                <span>Engage in an AI-led voice interview with conversational follow-ups</span>
              </li>
              <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                <Sparkles size={15} style={{ flexShrink: 0, marginTop: "4px", color: "var(--ok)" }} />
                <span>Live transcription & instant response capture</span>
              </li>
            </ul>

            <span className="cta">
              Open candidate portal <ArrowRight size={16} />
            </span>
          </Link>
        </div>

        <p
          className="tiny dim chooser-foot"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            background: "rgba(10, 14, 26, 0.6)",
            backdropFilter: "blur(8px)",
            padding: "8px 16px",
            borderRadius: "999px",
            border: "1px solid rgba(255, 255, 255, 0.05)",
          }}
        >
          <Lock size={12} className="text-slate-400" />
          <span>Strict isolation: Candidates never access recruiter evaluation matrices.</span>
        </p>
      </div>
    </div>
  );
}
