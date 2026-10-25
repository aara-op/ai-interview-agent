import { Link, NavLink, Route, Routes } from "react-router-dom";
import CandidateHome from "./pages/CandidateHome";
import Dashboard from "./pages/Dashboard";
import Home from "./pages/Home";
import InterviewDetail from "./pages/InterviewDetail";
import NewInterview from "./pages/NewInterview";
import Onboarding from "./pages/Onboarding";
import Report from "./pages/Report";
import Room from "./pages/Room";
import Secondary from "./pages/Secondary";
import CubeWaveDemo from "@/components/ui/demo";

export default function App() {
  return (
    <Routes>
      {/* Role chooser: the app opens on two separate doors */}
      <Route path="/" element={<Home />} />
      <Route path="/demo" element={<CubeWaveDemo />} />

      {/* Candidate-facing screens run full-bleed, without the recruiter chrome */}
      <Route path="/candidate" element={<CandidateHome />} />
      <Route path="/join/:sessionId" element={<Onboarding />} />
      <Route path="/room/:sessionId" element={<Room />} />
      <Route path="/secondary/:token" element={<Secondary />} />

      {/* Recruiter area: dashboard, configuration, reports */}
      <Route
        path="*"
        element={
          <div className="shell">
            <header className="topbar">
              <Link to="/" className="brand">
                <span className="brand-mark">◈</span> Interview Agent
              </Link>
              <nav>
                <NavLink to="/dashboard" end>
                  Dashboard
                </NavLink>
                <NavLink to="/new">New interview</NavLink>
                <NavLink to="/candidate">Candidate view</NavLink>
                <NavLink to="/demo">3D Wave</NavLink>
              </nav>
            </header>
            <main className="page">
              <Routes>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/new" element={<NewInterview />} />
                <Route path="/interviews/:id" element={<InterviewDetail />} />
                <Route path="/report/:sessionId" element={<Report />} />
                <Route
                  path="*"
                  element={
                    <div className="empty">
                      <h2>Page not found</h2>
                      <Link to="/dashboard">Back to dashboard</Link>
                    </div>
                  }
                />
              </Routes>
            </main>
          </div>
        }
      />
    </Routes>
  );
}
