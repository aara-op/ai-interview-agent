import * as React from "react";
import { Link } from "react-router-dom";
import CubeWave from "@/components/ui/cube-wave";
import {
  ArrowLeft,
  Sparkles,
  CheckCircle,
  ShieldCheck,
} from "lucide-react";

export default function CubeWaveDemo() {
  const [speed, setSpeed] = React.useState(1.0);
  const [grid, setGrid] = React.useState(16);
  const [theme] = React.useState<"auto" | "light" | "dark">("auto");

  return (
    <div className="h-screen w-full relative bg-[#0a0e1a] overflow-hidden select-none font-sans">
      {/* 3D Wave Layer */}
      <CubeWave
        key={`${grid}-${speed}-${theme}`}
        grid={grid}
        gap={0.76}
        speed={speed}
        theme={theme}
        className="h-full w-full"
      />

      {/* Top Navigation HUD */}
      <header className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-3 pointer-events-auto">
          <Link
            to="/"
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 text-slate-100 text-sm backdrop-blur-md border border-slate-700/60 shadow-lg transition"
          >
            <ArrowLeft size={16} />
            <span className="font-medium">Exit Demo</span>
          </Link>
          <div className="hidden sm:flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-900/60 text-xs text-slate-300 backdrop-blur-md border border-slate-800/80">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono">R3F Instanced Mesh &bull; 60 FPS</span>
          </div>
        </div>

        {/* Live Controls */}
        <div className="flex items-center gap-2 pointer-events-auto bg-slate-900/80 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700/60 shadow-lg text-xs text-slate-200">
          <span className="text-slate-400 font-mono">Speed:</span>
          {[0.5, 1.0, 1.6].map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-2 py-1 rounded-md transition ${speed === s ? "bg-indigo-600 text-white font-semibold" : "hover:bg-slate-800 text-slate-400"}`}
            >
              {s}x
            </button>
          ))}
          <div className="w-[1px] h-4 bg-slate-700 mx-1" />
          <span className="text-slate-400 font-mono">Grid:</span>
          {[12, 16, 20].map((g) => (
            <button
              key={g}
              onClick={() => setGrid(g)}
              className={`px-2 py-1 rounded-md transition ${grid === g ? "bg-indigo-600 text-white font-semibold" : "hover:bg-slate-800 text-slate-400"}`}
            >
              {g}²
            </button>
          ))}
        </div>
      </header>

      {/* Floating Sample UI Card Demonstrating Blend */}
      <div className="hidden md:flex absolute bottom-6 left-6 z-20 pointer-events-auto max-w-sm flex-col gap-3 p-4 rounded-2xl bg-slate-900/75 backdrop-blur-xl border border-slate-700/50 shadow-2xl">
        <div className="flex items-center gap-3">
          <img
            src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=120&q=80"
            alt="AI Interviewer"
            className="w-12 h-12 rounded-xl object-cover ring-2 ring-indigo-500/50 shadow-md"
          />
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-400">
              <Sparkles size={12} />
              <span>AI Lead Interviewer</span>
            </div>
            <div className="text-sm font-bold text-slate-100">Dr. Rachel Vance</div>
            <div className="text-[11px] text-slate-400">Autonomous Evaluation Agent</div>
          </div>
        </div>

        <div className="text-xs text-slate-300 leading-relaxed bg-slate-950/40 p-2.5 rounded-xl border border-slate-800/60">
          &ldquo;Welcome to the live assessment. The neural substrate wave reflects active cognitive evaluation and real-time biometric telemetry.&rdquo;
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800/80">
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckCircle size={12} /> Camera &amp; Mic Active
          </span>
          <span className="flex items-center gap-1 text-indigo-300">
            <ShieldCheck size={12} /> Proctoring V2
          </span>
        </div>
      </div>
    </div>
  );
}
