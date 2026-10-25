import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { DashboardData, Interview, OrgProfile } from "../types";

interface SessionRow {
  id: number;
  interview_id: number;
  job_title: string;
  candidate_name: string;
  candidate_email: string;
  status: string;
  created_at: string | null;
  duration_seconds: number;
  answer_count: number;
  answered_count: number;
  incident_count: number;
  incidents_high: number;
  incidents_warning: number;
  evaluation_status: string;
  overall_score: number | null;
  recommendation: string | null;
  has_recording: boolean;
}

const REC_LABEL: Record<string, string> = {
  strong_yes: "Strong yes",
  yes: "Yes",
  mixed: "Mixed",
  no: "No",
  strong_no: "Strong no",
};

function fmtDuration(sec: number) {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function scoreClass(v: number | null) {
  if (v === null) return "";
  if (v >= 4) return "badge ok";
  if (v >= 3) return "badge info";
  if (v >= 2) return "badge warn";
  return "badge high";
}

export default function Dashboard() {
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [org, setOrg] = useState<OrgProfile | null>(null);
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgSaved, setOrgSaved] = useState("");
  const [llmOn, setLlmOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listInterviews()
      .then(setInterviews)
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));

    fetch("/api/sessions")
      .then((r) => r.json())
      .then((rows) => Array.isArray(rows) && setSessions(rows))
      .catch(() => undefined);

    api
      .health()
      .then((h) => setLlmOn(h.llm?.enabled ?? false))
      .catch(() => setLlmOn(null));

    api
      .dashboard()
      .then((d) => {
        setDash(d);
        setOrg(d.org);
      })
      .catch(() => undefined);
  }, []);

  async function saveOrg() {
    if (!org) return;
    setSavingOrg(true);
    setOrgSaved("");
    try {
      setOrg(await api.saveSettings(org));
      setOrgSaved("Saved.");
      window.setTimeout(() => setOrgSaved(""), 2500);
    } catch (e) {
      setOrgSaved(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingOrg(false);
    }
  }

  const stats = useMemo(() => {
    const completed = sessions.filter((s) => s.status === "completed");
    const scores = completed
      .map((s) => s.overall_score)
      .filter((v): v is number => typeof v === "number");
    const avg = scores.length
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
      : null;
    return {
      interviews: interviews.length,
      sessions: sessions.length,
      completed: completed.length,
      avg,
      incidents: sessions.reduce((a, s) => a + s.incident_count, 0),
    };
  }, [interviews, sessions]);

  return (
    <>
      <div className="spread mb">
        <div>
          <h1>Recruiter dashboard</h1>
          <p className="muted" style={{ margin: 0 }}>
            Configure interviews, watch them run, review evidence, decide.
          </p>
        </div>
        <Link className="btn btn-primary" to="/new">
          + New interview
        </Link>
      </div>

      {org && (
        <div className="card mb">
          <div className="card-title">
            <h2>Organisation</h2>
            <span className="tiny dim">contact details shown to candidates</span>
          </div>
          <div className="grid grid-4">
            <label className="field">
              <span>Organisation name</span>
              <input
                value={org.org_name}
                onChange={(e) => setOrg({ ...org, org_name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Contact email</span>
              <input
                type="email"
                value={org.org_email}
                onChange={(e) => setOrg({ ...org, org_email: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Phone</span>
              <input
                value={org.org_phone}
                onChange={(e) => setOrg({ ...org, org_phone: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Notes</span>
              <input
                value={org.org_notes}
                onChange={(e) => setOrg({ ...org, org_notes: e.target.value })}
                placeholder="e.g. Backend hiring, Q4"
              />
            </label>
          </div>
          <div className="row mt">
            <button className="btn btn-primary" onClick={saveOrg} disabled={savingOrg}>
              {savingOrg ? "Saving…" : "Save organisation details"}
            </button>
            {orgSaved && <span className="tiny dim">{orgSaved}</span>}
          </div>
        </div>
      )}

      {llmOn === false && (
        <div className="notice warn mb">
          <strong>Offline mode.</strong> No <code className="mono">OPENAI_API_KEY</code>{" "}
          is configured, so questions and scoring use the built-in heuristic engine.
          Add the key in <code className="mono">backend/.env</code> for full AI
          generation and evidence-quoted evaluation.
        </div>
      )}
      {error && <div className="notice err mb">Could not reach the API: {error}</div>}

      <div className="grid grid-4 mb">
        <div className="stat">
          <div className="label">Interviews</div>
          <div className="value">{stats.interviews}</div>
          <div className="sub">configured roles</div>
        </div>
        <div className="stat">
          <div className="label">Sessions</div>
          <div className="value">{stats.sessions}</div>
          <div className="sub">{stats.completed} completed</div>
        </div>
        <div className="stat">
          <div className="label">Average score</div>
          <div className="value">{stats.avg !== null ? `${stats.avg}/5` : "—"}</div>
          <div className="sub">across completed interviews</div>
        </div>
        <div className="stat">
          <div className="label">Proctoring events</div>
          <div className="value">{stats.incidents}</div>
          <div className="sub">awaiting human review</div>
        </div>
      </div>

      {dash && dash.upcoming.length > 0 && (
        <div className="card mb">
          <div className="card-title">
            <h2>Upcoming meetings</h2>
            <span className="badge info">{dash.upcoming.length} scheduled</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Candidate</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Candidate link</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {dash.upcoming.map((m) => (
                  <tr key={m.session_id}>
                    <td>
                      {m.meeting_at ? (
                        <>
                          <strong>{new Date(m.meeting_at).toLocaleDateString()}</strong>
                          <div className="tiny dim">
                            {new Date(m.meeting_at).toLocaleTimeString()} ·{" "}
                            {m.meeting_minutes} min
                          </div>
                        </>
                      ) : (
                        <span className="tiny dim">no time set</span>
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.candidate}</div>
                      <div className="tiny dim">{m.email}</div>
                    </td>
                    <td>
                      <Link to={`/interviews/${m.interview_id}`}>{m.job_title}</Link>
                    </td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (m.status === "in_progress"
                            ? "info"
                            : m.status === "completed"
                              ? "ok"
                              : "warn")
                        }
                      >
                        {m.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="tiny dim wrap-anywhere">
                      {`${window.location.origin}/join/${m.session_id}`}
                    </td>
                    <td className="right">
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          navigator.clipboard
                            ?.writeText(`${window.location.origin}/join/${m.session_id}`)
                            .then(() => undefined)
                            .catch(() => undefined)
                        }
                      >
                        Copy link
                      </button>{" "}
                      <Link className="btn btn-sm" to={`/report/${m.session_id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dash && dash.candidates.length > 0 && (
        <div className="card mb">
          <div className="card-title">
            <h2>Resume judgement</h2>
            <span className="tiny dim">
              required skills matched against each resume, then the interview score
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Role</th>
                  <th>Resume match</th>
                  <th>Missing skills</th>
                  <th>Score</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {dash.candidates.map((row) => (
                  <tr key={row.session_id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{row.candidate}</div>
                      <div className="tiny dim">{row.email}</div>
                    </td>
                    <td>
                      <Link to={`/interviews/${row.interview_id}`}>{row.job_title}</Link>
                      <div className="tiny dim">{row.years ?? 0} yrs experience</div>
                    </td>
                    <td>
                      {row.match ? (
                        <>
                          <div className="row" style={{ gap: 7 }}>
                            <strong>{Math.round(row.match.score * 100)}%</strong>
                            <span className="tiny dim">
                              {row.match.matched.length}/{row.match.required.length} skills
                            </span>
                          </div>
                          <div className="bar" style={{ marginTop: 5 }}>
                            <i style={{ width: `${Math.round(row.match.score * 100)}%` }} />
                          </div>
                        </>
                      ) : (
                        <span className="tiny dim">no resume on file</span>
                      )}
                    </td>
                    <td className="tiny">
                      {row.match && row.match.missing.length ? (
                        row.match.missing.join(", ")
                      ) : (
                        <span className="dim">all present</span>
                      )}
                    </td>
                    <td>
                      {row.score !== null ? (
                        <span className={`score-pill s${Math.round(row.score)}`}>
                          {row.score}
                        </span>
                      ) : (
                        <span className="tiny dim">not taken</span>
                      )}
                      {row.recommendation && (
                        <div className="tiny dim" style={{ marginTop: 4 }}>
                          {REC_LABEL[row.recommendation] ?? row.recommendation}
                        </div>
                      )}
                    </td>
                    <td className="right">
                      <Link className="btn btn-sm" to={`/report/${row.session_id}`}>
                        Open report
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card mb">
        <div className="card-title">
          <h2>Candidate sessions</h2>
          <span className="badge">{sessions.length} total</span>
        </div>
        {sessions.length === 0 ? (
          <p className="muted">
            No sessions yet. Create an interview, then launch a candidate session
            from its page.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Progress</th>
                  <th>Proctoring</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.candidate_name}</div>
                      <div className="tiny dim">{s.candidate_email}</div>
                    </td>
                    <td>
                      <Link to={`/interviews/${s.interview_id}`}>{s.job_title}</Link>
                    </td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (s.status === "completed"
                            ? "ok"
                            : s.status === "disqualified"
                              ? "high"
                              : s.status === "in_progress"
                                ? "info"
                                : "")
                        }
                      >
                        {s.status.replace("_", " ")}
                      </span>
                    </td>
                    <td>
                      {s.overall_score !== null ? (
                        <span className={`score-pill s${Math.round(s.overall_score)}`}>
                          {s.overall_score}
                        </span>
                      ) : (
                        <span className="tiny dim">
                          {s.evaluation_status === "running" ? "scoring…" : "—"}
                        </span>
                      )}
                      {s.recommendation && (
                        <div className="tiny dim" style={{ marginTop: 4 }}>
                          {REC_LABEL[s.recommendation] ?? s.recommendation}
                        </div>
                      )}
                    </td>
                    <td className="tiny">
                      {s.answered_count}/{s.answer_count} answered
                      <div className="dim">{fmtDuration(s.duration_seconds)}</div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        {s.incidents_high > 0 && (
                          <span className="badge high">{s.incidents_high} high</span>
                        )}
                        {s.incidents_warning > 0 && (
                          <span className="badge warn">{s.incidents_warning} warn</span>
                        )}
                        {s.incident_count === 0 && <span className="badge ok">clean</span>}
                      </div>
                    </td>
                    <td className="right">
                      <Link className="btn btn-sm" to={`/report/${s.id}`}>
                        Open report
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Configured interviews</h2>
          <span className="badge">{interviews.length} total</span>
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : interviews.length === 0 ? (
          <div className="empty">
            <h3>No interviews yet</h3>
            <p>Upload a job description and a resume to generate the first question set.</p>
            <Link className="btn btn-primary" to="/new">
              Create the first interview
            </Link>
          </div>
        ) : (
          <div className="grid grid-3">
            {interviews.map((iv) => (
              <div key={iv.id} className="qitem">
                <div className="spread">
                  <h3 style={{ margin: 0 }}>{iv.job_title}</h3>
                  <span className="badge accent">{iv.question_count} Q</span>
                </div>
                <div className="tiny dim" style={{ marginTop: 4 }}>
                  {iv.resume_name || "No resume"}
                  {iv.experience_level ? ` · ${iv.experience_level}` : ""}
                </div>
                <div className="chips" style={{ marginTop: 9 }}>
                  {iv.required_skills.slice(0, 4).map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                  {iv.required_skills.length > 4 && (
                    <span className="chip">+{iv.required_skills.length - 4}</span>
                  )}
                </div>
                <div className="row mt">
                  <Link className="btn btn-sm" to={`/interviews/${iv.id}`}>
                    Open
                  </Link>
                  <span className="tiny dim">
                    {iv.session_count ?? 0} session
                    {(iv.session_count ?? 0) === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
