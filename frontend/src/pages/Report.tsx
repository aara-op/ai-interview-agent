import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { CATEGORY_LABELS, INCIDENT_LABELS, type Report as ReportT } from "../types";

const REC_LABEL: Record<string, string> = {
  strong_yes: "Strong yes",
  yes: "Yes",
  mixed: "Mixed",
  no: "No",
  strong_no: "Strong no",
};

const DIM_LABELS: Record<string, string> = {
  technical_knowledge: "Technical knowledge",
  problem_solving: "Problem solving",
  communication: "Communication",
  role_fit: "Role fit",
};

function mmss(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function tsClock(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export default function Report() {
  const { sessionId } = useParams();
  const sid = Number(sessionId);
  const [report, setReport] = useState<ReportT | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [openIncident, setOpenIncident] = useState<number | null>(null);
  const [saved, setSaved] = useState("");
  // human integrity review — edited locally until the recruiter saves it
  const [integrity, setIntegrity] = useState({
    verdict: "",
    penalty: 0,
    note: "",
  });
  const integrityDirtyRef = useRef(false);

  const load = useCallback(
    async (withEvidence = true) => {
      try {
        setReport(await api.report(sid, withEvidence));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sid],
  );

  useEffect(() => {
    load();
  }, [load]);

  // poll while the evaluation engine is still running
  useEffect(() => {
    if (report?.evaluation_status !== "running") return;
    const t = window.setInterval(() => load(true), 2000);
    return () => window.clearInterval(t);
  }, [report?.evaluation_status, load]);

  useEffect(() => {
    if (report) setNotes(report.session.recruiter_notes ?? "");
  }, [report?.session.recruiter_notes]);

  // pull the saved integrity review — but never clobber edits in progress
  // (the report reloads on a poll while the evaluation engine runs)
  useEffect(() => {
    if (report && !integrityDirtyRef.current) {
      setIntegrity({
        verdict: report.integrity?.verdict ?? "",
        penalty: report.integrity?.penalty ?? 0,
        note: report.integrity?.note ?? "",
      });
    }
  }, [report]);

  const hasPendingOverrides = useMemo(
    () => Object.keys(overrides).length > 0,
    [overrides],
  );

  if (error) return <div className="notice err">{error}</div>;
  if (!report) return <p className="muted">Loading report…</p>;

  const {
    session,
    interview,
    answers,
    evaluation,
    incidents,
    proctoring_summary,
    suspicion,
  } = report;
  const evStatus = report.evaluation_status;

  async function setVeto(choice: "" | "reinstated" | "rejected") {
    setBusy(true);
    try {
      setReport(await api.updateReport(sid, { veto_override: choice }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setSaved("");
    try {
      const payload: Parameters<typeof api.updateReport>[1] = {
        recruiter_notes: notes,
        acknowledged_incidents: incidents
          .filter((i) => i.acknowledged)
          .map((i) => i.id),
        overrides: Object.entries(overrides).map(([answerId, score]) => ({
          answer_id: Number(answerId),
          score,
        })),
        integrity: {
          verdict: integrity.verdict,
          penalty: integrity.penalty,
          note: integrity.note,
        },
      };
      const next = await api.updateReport(sid, payload);
      setReport(next);
      setOverrides({});
      integrityDirtyRef.current = false;
      setSaved("Saved.");
      window.setTimeout(() => setSaved(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function recompute() {
    setBusy(true);
    try {
      await api.recompute(sid);
      await load(true);
    } finally {
      setBusy(false);
    }
  }

  async function toggleAck(id: number) {
    const target = incidents.find((i) => i.id === id);
    if (!target) return;
    await api.patchIncident(sid, id, { acknowledged: !target.acknowledged });
    await load(true);
  }

  const overall =
    evaluation?.overall_score ??
    (answers.some((a) => a.score !== null)
      ? Math.round(
          (answers.reduce((s, a) => s + (a.score ?? 0), 0) /
            Math.max(1, answers.filter((a) => a.score !== null).length)) * 10,
        ) / 10
      : null);

  return (
    <>
      <div className="spread mb">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <h1 style={{ margin: 0 }}>{session.candidate_name || "Candidate"}</h1>
            <span
              className={
                "badge " +
                (session.status === "completed"
                  ? "ok"
                  : session.status === "disqualified"
                    ? "high"
                    : "info")
              }
            >
              {session.status.replace("_", " ")}
            </span>
          </div>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            <Link to={`/interviews/${interview.id}`}>{interview.job_title}</Link>
            {" · "}
            {session.started_at
              ? new Date(session.started_at).toLocaleString()
              : "not started"}
            {" · "}
            {mmss(session.duration_seconds)} · {answers.length} questions asked
          </p>
        </div>
        <div className="row">
          <Link className="btn" to="/dashboard">
            Dashboard
          </Link>
          {session.recorder && (
            <a className="btn" href={`/api/sessions/${sid}/recording`} target="_blank" rel="noreferrer">
              ▶ Recording
            </a>
          )}
          <button className="btn" onClick={recompute} disabled={busy}>
            Re-run evaluation
          </button>
        </div>
      </div>

      {/* --------------------------------------------------------- summary */}
      <div className="grid grid-4 mb">
        <div className="stat">
          <div className="label">Overall score</div>
          <div className="value">{overall !== null ? `${overall}/5` : "—"}</div>
          <div className="sub">
            {report.adjusted_score !== null && integrity.penalty > 0
              ? `${report.adjusted_score}/5 after −${integrity.penalty} integrity penalty`
              : evStatus === "running"
                ? "scoring…"
                : evaluation?.engine === "llm"
                  ? "AI scored"
                  : "heuristic"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Recommendation</div>
          <div className="value" style={{ fontSize: 20 }}>
            {evaluation ? (REC_LABEL[evaluation.recommendation] ?? evaluation.recommendation) : "—"}
          </div>
          <div className="sub">suggestion only, not a decision</div>
        </div>
        <div className="stat">
          <div className="label">Answered</div>
          <div className="value">
            {answers.filter((a) => a.status === "answered").length}/{answers.length}
          </div>
          <div className="sub">
            {answers.filter((a) => a.status === "skipped").length} skipped ·{" "}
            {answers.filter((a) => a.status === "unanswered").length} unanswered
          </div>
        </div>
        <div className="stat">
          <div className="label">Proctoring events</div>
          <div className="value">{proctoring_summary.total}</div>
          <div className="sub">
            {proctoring_summary.by_severity.high ?? 0} high ·{" "}
            {proctoring_summary.by_severity.warning ?? 0} warning
          </div>
        </div>
      </div>

      <div className="notice mb">
        <strong>How to read this report.</strong> {proctoring_summary.disclaimer}
        {" "}Scores are AI-generated drafts: correct them below whenever the
        evidence disagrees.
      </div>

      {evStatus === "running" && (
        <div className="notice warn mb">
          <span className="spinner" /> The evaluation engine is still scoring this
          interview. This page refreshes automatically.
        </div>
      )}

      {report.scorecard && (
        <div className="card mb">
          <div className="card-title">
            <h2>Scorecard</h2>
            <span
              className={
                "badge " +
                (["auto_reject", "rejected"].includes(report.scorecard.veto.final)
                  ? "high"
                  : report.scorecard.veto.final === "review"
                    ? "warn"
                    : "ok")
              }
            >
              {{
                auto_reject: "Veto: auto-reject flag",
                rejected: "Rejected by recruiter",
                reinstated: "Reinstated by recruiter",
                review: "Needs human review",
                clear: "No integrity flags",
              }[report.scorecard.veto.final]}
            </span>
          </div>
          <div className="grid grid-3">
            <div>
              <div className="muted tiny">Technical</div>
              <h1 style={{ margin: 0 }}>
                {report.scorecard.technical_10 ?? "—"}
                <span className="muted"> /10</span>
              </h1>
            </div>
            <div>
              <div className="muted tiny">Behavioral</div>
              <h1 style={{ margin: 0 }}>
                {report.scorecard.behavioral_5 ?? "—"}
                <span className="muted"> /5</span>
              </h1>
            </div>
            <div>
              <div className="muted tiny">Integrity index</div>
              <h1 style={{ margin: 0 }}>
                {report.scorecard.integrity_index}
                <span className="muted"> /100</span>
              </h1>
            </div>
          </div>
          <p style={{ marginBottom: 4 }}>
            Composite <strong>{report.scorecard.composite_pct}%</strong> (weights:
            technical {report.scorecard.weights.technical}, behavioral{" "}
            {report.scorecard.weights.behavioral}, integrity{" "}
            {report.scorecard.weights.integrity})
          </p>
          <p className="muted tiny">{report.scorecard.veto.reason}</p>
          <p className="muted tiny">{report.scorecard.basis}</p>
          <div className="row">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void setVeto("reinstated")}
            >
              Reinstate candidate
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void setVeto("rejected")}
            >
              Confirm rejection
            </button>
            {report.scorecard.veto.override && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void setVeto("")}
              >
                Clear decision
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-2">
        {/* ------------------------------------------------- evaluation */}
        <div>
          {evaluation && (
            <div className="card">
              <div className="card-title">
                <h2>Assessment</h2>
                <span className="badge">{evaluation.engine === "llm" ? "AI" : "offline"}</span>
              </div>

              <p style={{ fontSize: 14.6 }}>{evaluation.summary}</p>

              <span className="flabel">Dimension scores</span>
              {Object.entries(evaluation.dimension_scores).map(([k, v]) => (
                <div className="dimbar" key={k}>
                  <span>{DIM_LABELS[k] ?? k}</span>
                  <div className="track">
                    <i style={{ width: `${(v.score / 5) * 100}%` }} />
                  </div>
                  <span className="right">{v.score}/5</span>
                </div>
              ))}

              <p className="tiny dim">{evaluation.scoring_basis}</p>

              <div className="grid grid-2 mt">
                <div>
                  <span className="flabel">Strengths</span>
                  <ul className="rules">
                    {evaluation.strengths.length === 0 && <li className="dim">None identified</li>}
                    {evaluation.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span className="flabel">Knowledge gaps</span>
                  <ul className="rules">
                    {evaluation.knowledge_gaps.length === 0 && <li className="dim">None identified</li>}
                    {evaluation.knowledge_gaps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <span className="flabel">Suggested further assessment</span>
              <ul className="rules">
                {evaluation.further_assessment.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>

              <span className="flabel">Scoring rubric in use</span>
              <table>
                <tbody>
                  {Object.entries(evaluation.rubric).map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ width: 60 }}>
                        <span className={`score-pill s${k}`}>{k}</span>
                      </td>
                      <td className="tiny">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ------------------------------------------ question by question */}
          <div className="card">
            <div className="card-title">
              <h2>Questions & responses</h2>
              <span className="badge">{answers.length}</span>
            </div>
            <div className="qlist">
              {answers.map((a, i) => {
                const detail = evaluation?.per_question.find(
                  (p) => p.answer_id === a.id,
                );
                const score = overrides[a.id] ?? a.score ?? detail?.score ?? null;
                return (
                  <div className="qitem" key={a.id}>
                    <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                      <span className="qnum">{String(i + 1).padStart(2, "0")}</span>
                      <div style={{ flex: 1 }}>
                        <div className="qtext">{a.question_text}</div>
                        <div className="qmeta">
                          <span className="badge">
                            {CATEGORY_LABELS[a.category] ?? a.category}
                          </span>
                          <span
                            className={
                              "badge " +
                              (a.status === "answered" ? "ok" : a.status === "skipped" ? "warn" : "high")
                            }
                          >
                            {a.status}
                          </span>
                          <span className="tiny dim">{a.duration_seconds}s</span>
                          {a.score_detail?.overridden_by_recruiter && (
                            <span className="badge accent">overridden</span>
                          )}
                          <span style={{ marginLeft: "auto" }} className="row">
                            <label className="tiny dim" style={{ marginRight: 6 }}>
                              score
                            </label>
                            <select
                              value={score ?? ""}
                              onChange={(e) =>
                                e.target.value &&
                                setOverrides((o) => ({
                                  ...o,
                                  [a.id]: Number(e.target.value),
                                }))
                              }
                              style={{ width: 76, padding: "4px 7px" }}
                            >
                              <option value="">—</option>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                  {n}/5
                                </option>
                              ))}
                            </select>
                            {score !== null && (
                              <span className={`score-pill s${score}`}>{score}</span>
                            )}
                          </span>
                        </div>

                        <div className="transcript mt">{a.transcript || "— no response recorded —"}</div>

                        {detail?.explanation && (
                          <p className="tiny" style={{ marginTop: 8, marginBottom: 4 }}>
                            <strong>Why this score:</strong> {detail.explanation}
                          </p>
                        )}
                        {detail?.evidence && (
                          <div className="quote mt">“{detail.evidence}”</div>
                        )}
                        {(detail?.strengths?.length || detail?.gaps?.length) ? (
                          <div className="row mt" style={{ gap: 14 }}>
                            {detail?.strengths?.length ? (
                              <div>
                                <span className="flabel">Strengths</span>
                                <ul className="rules tiny">
                                  {detail.strengths.map((s, k) => (
                                    <li key={k}>{s}</li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                            {detail?.gaps?.length ? (
                              <div>
                                <span className="flabel">Gaps</span>
                                <ul className="rules tiny">
                                  {detail.gaps.map((s, k) => (
                                    <li key={k}>{s}</li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div>
          {/* -------------------------------------- suspicion + integrity */}
          <div className="card mb">
            <div className="card-title">
              <h2>Suspicion & integrity review</h2>
              <span
                className={
                  "badge " +
                  (suspicion.level === "high"
                    ? "high"
                    : suspicion.level === "medium"
                      ? "warn"
                      : "info")
                }
              >
                suspicion {suspicion.level}
              </span>
            </div>
            <p className="tiny dim" style={{ marginTop: 0 }}>
              {suspicion.explanation}
            </p>
            <div className="chips mb">
              <span className="chip">{suspicion.score} weight</span>
              <span className="chip hit">{suspicion.high} high</span>
              <span className="chip miss">{suspicion.warning} warning</span>
              {suspicion.forgery_flags.length > 0 && (
                <span className="chip miss">
                  identity/assistance flags {suspicion.forgery_flags.length}
                </span>
              )}
            </div>

            {suspicion.events.length > 0 ? (
              <ul className="rules tiny mb">
                {suspicion.events.map((e) => (
                  <li key={e.id}>
                    <span className="ts">{tsClock(e.ts_ms)}</span> ·{" "}
                    {INCIDENT_LABELS[e.type] ?? e.type} — {e.observed}
                    {e.acknowledged ? " · reviewed" : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tiny dim">No suspicious behaviour was recorded.</p>
            )}

            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <label className="field" style={{ flex: 1, minWidth: 180 }}>
                <span>Your verdict after reviewing the evidence</span>
                <select
                  value={integrity.verdict}
                  onChange={(e) => {
                    integrityDirtyRef.current = true;
                    setIntegrity({ ...integrity, verdict: e.target.value });
                  }}
                >
                  <option value="">Not reviewed</option>
                  <option value="clean">Clean — no concern</option>
                  <option value="review">Needs human review</option>
                  <option value="suspicious">Suspicious</option>
                </select>
              </label>
              <label className="field" style={{ flex: 1, minWidth: 150 }}>
                <span>Points off the overall score (0–3)</span>
                <select
                  value={integrity.penalty}
                  onChange={(e) => {
                    integrityDirtyRef.current = true;
                    setIntegrity({
                      ...integrity,
                      penalty: Number(e.target.value),
                    });
                  }}
                >
                  {[0, 1, 2, 3].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Reviewer note</span>
              <textarea
                rows={3}
                value={integrity.note}
                placeholder="What the timestamps show, and how it affected the score…"
                onChange={(e) => {
                  integrityDirtyRef.current = true;
                  setIntegrity({ ...integrity, note: e.target.value });
                }}
              />
            </label>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              Save integrity review
            </button>
            {saved && (
              <span className="tiny" style={{ marginLeft: 10 }}>
                {saved}
              </span>
            )}
            <p className="tiny dim" style={{ marginBottom: 0 }}>
              The raw AI score stays visible next to the penalised one, so both
              remain auditable. Nothing here disqualifies a candidate
              automatically.
            </p>
          </div>

          {/* ------------------------------------------------ proctoring */}
          <div className="card">
            <div className="card-title">
              <h2>Proctoring timeline</h2>
              <span className="badge">{incidents.length} events</span>
            </div>

            <div className="chips mb">
              <span className="chip">{proctoring_summary.total} total</span>
              <span className="chip hit">
                {proctoring_summary.by_severity.high ?? 0} high
              </span>
              <span className="chip miss">
                {proctoring_summary.by_severity.warning ?? 0} warning
              </span>
              <span className="chip">
                {proctoring_summary.by_severity.info ?? 0} info
              </span>
              <span className="chip">{mmss(proctoring_summary.coverage_seconds)} covered</span>
            </div>

            <div className="timeline">
              {incidents.length === 0 && (
                <p className="muted">No proctoring events were recorded.</p>
              )}
              {incidents.map((inc) => (
                <div className="tl-item" key={inc.id}>
                  <span className="ts">{tsClock(inc.ts_ms)}</span>
                  <div>
                    <div className="row" style={{ gap: 7 }}>
                      <span
                        className={
                          "badge " +
                          (inc.severity === "high"
                            ? "high"
                            : inc.severity === "warning"
                              ? "warn"
                              : "info")
                        }
                      >
                        {INCIDENT_LABELS[inc.type] ?? inc.type}
                      </span>
                      {inc.acknowledged && <span className="badge ok">reviewed</span>}
                      <button
                        className="btn btn-sm"
                        style={{ marginLeft: "auto" }}
                        onClick={() => toggleAck(inc.id)}
                      >
                        {inc.acknowledged ? "Undo" : "Mark reviewed"}
                      </button>
                    </div>

                    <p className="tiny" style={{ margin: "7px 0 3px" }}>
                      <strong>Observed:</strong> {inc.observed}
                      {inc.duration_ms ? ` (${(inc.duration_ms / 1000).toFixed(1)}s)` : ""}
                    </p>
                    <p className="tiny dim" style={{ margin: "0 0 6px" }}>
                      <strong>May indicate:</strong> {inc.inference}
                    </p>

                    <div className="row" style={{ gap: 7 }}>
                      {inc.has_evidence && (
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            setOpenIncident(openIncident === inc.id ? null : inc.id)
                          }
                        >
                          {openIncident === inc.id ? "Hide frame" : "Show evidence frame"}
                        </button>
                      )}
                      <span className="tiny dim">id {inc.id}</span>
                    </div>

                    {openIncident === inc.id && inc.evidence_data_url && (
                      <img
                        src={inc.evidence_data_url}
                        alt={`Evidence frame at ${tsClock(inc.ts_ms)}`}
                        style={{
                          width: 240,
                          borderRadius: 8,
                          marginTop: 8,
                          border: "1px solid var(--line)",
                        }}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              <h2>Recruiter review</h2>
              {saved && <span className="badge ok">{saved}</span>}
            </div>

            <label className="field">
              <span>Notes / decision context</span>
              <textarea
                rows={5}
                value={notes}
                placeholder="What you verified, what still needs a human check…"
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>

            <div className="row">
              <button
                className="btn btn-primary"
                onClick={save}
                disabled={busy || (!hasPendingOverrides && notes === (session.recruiter_notes ?? ""))}
              >
                {busy ? "Saving…" : "Save review"}
              </button>
              {hasPendingOverrides && (
                <span className="badge warn">
                  {Object.keys(overrides).length} score override
                  {Object.keys(overrides).length === 1 ? "" : "s"} pending
                </span>
              )}
            </div>

            <p className="tiny dim mt">
              Overrides replace the AI score for this report only; the original
              AI rationale stays visible so both remain auditable.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
