import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { CATEGORY_LABELS, type Applicant, type Interview, type InviteResult } from "../types";

interface SessionRow {
  id: number;
  interview_id: number;
  candidate_name: string;
  status: string;
  created_at: string | null;
  duration_seconds: number;
  overall_score: number | null;
  incident_count: number;
}

export default function InterviewDetail() {
  const { id } = useParams();
  const numericId = Number(id);

  const [iv, setIv] = useState<Interview | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [newQ, setNewQ] = useState("");
  const [count, setCount] = useState(10);
  const [showResume, setShowResume] = useState(true);
  const [invite, setInvite] = useState<{
    id: number;
    link: string;
    code: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- applicants, shortlist, meeting + invitations --------------------
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [meetingAt, setMeetingAt] = useState("");
  const [meetingMins, setMeetingMins] = useState(45);
  const [inviteMsg, setInviteMsg] = useState("");
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, rows] = await Promise.all([
        api.getInterview(numericId),
        fetch("/api/sessions").then((r) => r.json()),
      ]);
      setIv(detail);
      setCount(detail.question_count);
      if (Array.isArray(rows)) {
        setSessions(
          rows.filter((s: SessionRow) => s.interview_id === numericId),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [numericId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .applicants(numericId)
      .then((rows) => {
        setApplicants(rows);
        setSelected(rows.filter((r) => r.shortlisted).map((r) => r.session_id));
      })
      .catch(() => setApplicants([]));
  }, [numericId, sessions.length]);

  if (error) return <div className="notice err">{error}</div>;
  if (!iv) return <p className="muted">Loading…</p>;

  const parsed = iv.resume?.parsed ?? {};
  const required = new Set(iv.required_skills.map((s) => s.toLowerCase()));
  const candidate = (parsed.skills ?? []).map((s) => s.toLowerCase());
  const matched = candidate.filter((s) => required.has(s));
  const gaps = iv.required_skills.filter(
    (r) => !candidate.some((c) => c.includes(r.toLowerCase()) || r.toLowerCase().includes(c)),
  );
  const extras = (parsed.skills ?? []).filter(
    (s) => !required.has(s.toLowerCase()),
  );

  async function regenerate() {
    setBusy("regen");
    setError("");
    try {
      setIv(await api.regenerate(numericId, { question_count: count }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function addQuestion() {
    if (!newQ.trim()) return;
    setBusy("add");
    try {
      setIv(await api.addQuestion(numericId, newQ.trim()));
      setNewQ("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function removeQuestion(qid: number) {
    setBusy(`del${qid}`);
    try {
      setIv(await api.deleteQuestion(numericId, qid));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function launch() {
    setBusy("launch");
    setError("");
    try {
      const session = await api.createSession(
        numericId,
        iv?.resume?.candidate_name ?? "",
        iv?.resume?.candidate_email ?? "",
      );
      // Recruiter stays here: the candidate opens the link on their own device.
      setInvite({
        id: session.id,
        link: `${window.location.origin}/join/${session.id}`,
        code: session.public_id,
      });
      setCopied(false);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function copyInvite() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Clipboard blocked — select the link and copy it manually.");
    }
  }

  async function sendInvites() {
    if (!selected.length || !meetingAt) return;
    setInviteBusy(true);
    setError("");
    try {
      const res = await api.sendInvites(numericId, {
        session_ids: selected,
        meeting_at: meetingAt,
        duration_minutes: meetingMins,
        origin: window.location.origin,
        message: inviteMsg,
      });
      setInviteResult(res);
      const rows = await api.applicants(numericId);
      setApplicants(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInviteBusy(false);
    }
  }

  function toggleSelected(id: number) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <>
      <div className="spread mb">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <h1 style={{ margin: 0 }}>{iv.job_title}</h1>
            <span className="badge accent">{iv.questions.length} questions</span>
            <span className="badge">{iv.duration_minutes} min</span>
            <span className="badge">{iv.experience_level}</span>
          </div>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            {iv.resume ? `Resume: ${iv.resume.filename}` : "No resume uploaded"} ·{" "}
            {iv.allow_followups
              ? `up to ${iv.max_followups} follow-ups`
              : "fixed question set"}
          </p>
        </div>
        <div className="row">
          <Link className="btn" to="/dashboard">
            Dashboard
          </Link>
          <button className="btn btn-primary" onClick={launch} disabled={busy !== ""}>
            {busy === "launch"
              ? "Creating link…"
              : invite
                ? "Create another candidate link →"
                : "Create candidate link →"}
          </button>
        </div>
      </div>

      {error && <div className="notice err mb">{error}</div>}

      {invite && (
        <div className="notice mb">
          <strong>Candidate link ready.</strong> Send it to the candidate — they
          open it on their own device and see only the candidate dashboard,
          onboarding and interview screens. This page stays in your view.
          <div className="row mt" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code style={{ flex: 1, minWidth: 220, wordBreak: "break-all" }}>
              {invite.link}
            </code>
            <button className="btn" onClick={copyInvite}>
              {copied ? "Copied ✓" : "Copy link"}
            </button>
            <a
              className="btn"
              href={invite.link}
              target="_blank"
              rel="noreferrer"
            >
              Preview as candidate ↗
            </a>
          </div>
          <div className="row mt" style={{ gap: 8, alignItems: "center" }}>
            <span className="tiny dim">Candidate can also type this code:</span>
            <code>{invite.code}</code>
          </div>
        </div>
      )}

      {/* ------------------------------------------- applicants + invite */}
      <div className="card mb">
        <div className="card-title">
          <h2>Applicants & shortlist</h2>
          <span className="badge">{applicants.length}</span>
        </div>

        {applicants.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Nobody has signed up yet. Send a candidate the link or code above —
            they enrol with their resume, photo and voice test, and appear here
            ranked by skill match.
          </p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th>
                  <th>Candidate</th>
                  <th>Skill match</th>
                  <th>Exp</th>
                  <th>Resume</th>
                  <th>Voice test</th>
                  <th>Invitation</th>
                </tr>
              </thead>
              <tbody>
                {applicants.map((a) => (
                  <tr key={a.session_id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(a.session_id)}
                        onChange={() => toggleSelected(a.session_id)}
                      />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        {a.candidate.pfp_url && (
                          <img
                            className="avatar"
                            src={a.candidate.pfp_url}
                            alt={a.candidate.name}
                            style={{ width: 30, height: 30 }}
                          />
                        )}
                        <div>
                          <div style={{ fontWeight: 620 }}>{a.candidate.name}</div>
                          <div className="tiny dim">
                            {a.candidate.resume_email || a.candidate.email}
                          </div>
                          {a.candidate.aadhaar_masked && (
                            <div className="tiny dim">
                              Aadhaar {a.candidate.aadhaar_masked}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 7, alignItems: "center" }}>
                        <strong>{Math.round(a.match.score * 100)}%</strong>
                        <span className="tiny dim">
                          {a.match.matched.length}/{a.match.required.length} skills
                        </span>
                      </div>
                      <div className="tiny dim">
                        {a.match.missing.length
                          ? `missing: ${a.match.missing.join(", ")}`
                          : "all required skills present"}
                      </div>
                    </td>
                    <td>{a.years_experience} yrs</td>
                    <td className="tiny">
                      {a.candidate.resume_filename || "—"}
                    </td>
                    <td>
                      {a.candidate.has_voice ? (
                        <audio
                          controls
                          preload="none"
                          src={`/api/candidates/${a.candidate.id}/voice`}
                          style={{ width: 150 }}
                        />
                      ) : (
                        <span className="tiny dim">—</span>
                      )}
                    </td>
                    <td>
                      {a.invite_status ? (
                        <>
                          <span
                            className={
                              "badge " +
                              (a.invite_status.startsWith("failed")
                                ? "high"
                                : a.invite_status === "sent"
                                  ? "ok"
                                  : "info")
                            }
                          >
                            {a.invite_status.startsWith("failed")
                              ? "failed"
                              : a.invite_status === "sent"
                                ? "emailed"
                                : "saved to outbox"}
                          </span>
                          <div className="tiny dim">
                            meeting {a.meeting_at ? new Date(a.meeting_at).toLocaleString() : "—"}
                          </div>
                        </>
                      ) : a.shortlisted ? (
                        <span className="badge warn">shortlisted</span>
                      ) : (
                        <span className="tiny dim">not shortlisted</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="row mt" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field" style={{ margin: 0 }}>
                <span>Meeting date & time</span>
                <input
                  type="datetime-local"
                  value={meetingAt}
                  onChange={(e) => setMeetingAt(e.target.value)}
                />
              </label>
              <label className="field" style={{ margin: 0, width: 120 }}>
                <span>Minutes</span>
                <input
                  type="number"
                  min={5}
                  max={240}
                  value={meetingMins}
                  onChange={(e) => setMeetingMins(Number(e.target.value) || 45)}
                />
              </label>
              <label className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
                <span>Note to include in the mail (optional)</span>
                <input
                  type="text"
                  value={inviteMsg}
                  placeholder="Bring a photo ID, join 5 minutes early…"
                  onChange={(e) => setInviteMsg(e.target.value)}
                />
              </label>
              <button
                className="btn btn-primary"
                disabled={!selected.length || !meetingAt || inviteBusy}
                onClick={sendInvites}
              >
                {inviteBusy
                  ? "Sending…"
                  : `Schedule meeting & email ${selected.length || ""} invite${
                      selected.length === 1 ? "" : "s"
                    }`}
              </button>
            </div>
            <p className="tiny dim" style={{ marginBottom: 0 }}>
              Selected candidates are shortlisted, the meeting is recorded on
              their session, and the invitation with their personal interview
              link is emailed to the address parsed from their resume (falling
              back to their login email).
            </p>

            {inviteResult && (
              <div
                className={"notice mt " + (inviteResult.mail_backend === "smtp" ? "ok" : "warn")}
              >
                <strong>
                  {inviteResult.mail_backend === "smtp"
                    ? "Invitations sent."
                    : "SMTP is not configured — invitations were saved to data/outbox instead of being sent."}
                </strong>{" "}
                Meeting {new Date(inviteResult.meeting_at).toLocaleString()}.
                <ul className="rules tiny" style={{ marginBottom: 0 }}>
                  {inviteResult.results.map((r) => (
                    <li key={r.session_id}>
                      {r.candidate} → {r.email || "no address"}: {r.status}
                    </li>
                  ))}
                </ul>
                {inviteResult.results[0]?.preview && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="tiny">Preview the invitation email</summary>
                    <pre className="tiny" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
                      {inviteResult.results[0].preview}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="grid grid-2">
        {/* --------------------------------------------------- analysis */}
        <div>
          <div className="card">
            <div className="card-title">
              <h2>Job ↔ resume match</h2>
              <span className="badge">
                {matched.length}/{iv.required_skills.length} required skills present
              </span>
            </div>

            <span className="flabel">Required by the role</span>
            <div className="chips mb">
              {iv.required_skills.map((s) => (
                <span
                  key={s}
                  className={"chip " + (matched.some((m) => m === s.toLowerCase()) ? "hit" : "miss")}
                >
                  {matched.some((m) => m === s.toLowerCase()) ? "✓ " : "! "}
                  {s}
                </span>
              ))}
            </div>

            {gaps.length > 0 && (
              <>
                <span className="flabel">Not evident on the resume</span>
                <div className="chips mb">
                  {gaps.map((s) => (
                    <span key={s} className="chip miss">
                      {s}
                    </span>
                  ))}
                </div>
              </>
            )}

            {extras.length > 0 && (
              <>
                <span className="flabel">Candidate skills beyond the role</span>
                <div className="chips mb">
                  {extras.slice(0, 14).map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
              </>
            )}

            <p className="tiny dim" style={{ marginBottom: 0 }}>
              Extraction: {(parsed.extraction_method ?? "n/a") as string} ·{" "}
              {(parsed.years_experience ?? 0) as number} years experience detected
            </p>
          </div>

          {iv.resume && (
            <div className="card">
              <div className="card-title">
                <h2>Candidate</h2>
                <button className="btn btn-sm" onClick={() => setShowResume(!showResume)}>
                  {showResume ? "Hide raw text" : "Show raw text"}
                </button>
              </div>
              <dl className="kv">
                <dt>Name</dt>
                <dd>{iv.resume.candidate_name || "—"}</dd>
                <dt>Email</dt>
                <dd>{iv.resume.candidate_email || "—"}</dd>
                <dt>Phone</dt>
                <dd>{iv.resume.candidate_phone || "—"}</dd>
                <dt>Experience</dt>
                <dd>{(parsed.years_experience ?? 0) as number} years</dd>
              </dl>

              {(parsed.education as string[] | undefined)?.length ? (
                <>
                  <span className="flabel mt">Education</span>
                  <ul className="rules">
                    {(parsed.education as string[]).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {(parsed.projects as string[] | undefined)?.length ? (
                <>
                  <span className="flabel mt">Projects</span>
                  <ul className="rules">
                    {(parsed.projects as string[]).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {(parsed.certifications as string[] | undefined)?.length ? (
                <>
                  <span className="flabel mt">Certifications</span>
                  <div className="chips">
                    {(parsed.certifications as string[]).map((e, i) => (
                      <span key={i} className="chip">
                        {e}
                      </span>
                    ))}
                  </div>
                </>
              ) : null}

              {showResume && (
                <pre className="transcript mt" style={{ maxHeight: 260, overflow: "auto", fontSize: 13 }}>
                  {iv.resume.text_preview}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* --------------------------------------------------- questions */}
        <div>
          <div className="card">
            <div className="card-title">
              <h2>Question set</h2>
              <div className="row" style={{ gap: 8 }}>
                <input
                  type="number"
                  min={1}
                  max={40}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  style={{ width: 78, padding: "6px 9px" }}
                />
                <button className="btn btn-sm" onClick={regenerate} disabled={busy !== ""}>
                  {busy === "regen" ? "Generating…" : "Regenerate"}
                </button>
              </div>
            </div>

            <div className="qlist">
              {iv.questions.map((q, i) => (
                <div className="qitem" key={q.id}>
                  <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                    <span className="qnum">{String(i + 1).padStart(2, "0")}</span>
                    <div style={{ flex: 1 }}>
                      <div className="qtext">{q.text}</div>
                      <div className="qmeta">
                        <span className="badge">{CATEGORY_LABELS[q.category] ?? q.category}</span>
                        <span className="badge">{q.difficulty}</span>
                        <span className={"badge " + (q.source === "recruiter" ? "accent" : "")}>
                          {q.source === "recruiter" ? "recruiter" : "AI"}
                        </span>
                        {q.skill_target && <span className="tiny dim">→ {q.skill_target}</span>}
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy !== ""}
                          onClick={() => removeQuestion(q.id)}
                          style={{ marginLeft: "auto" }}
                        >
                          {busy === `del${q.id}` ? "…" : "Remove"}
                        </button>
                      </div>
                      {q.rationale && <div className="rationale">“{q.rationale}”</div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="row mt">
              <input
                type="text"
                placeholder="Add a recruiter-written question…"
                value={newQ}
                onChange={(e) => setNewQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addQuestion()}
                style={{ flex: 1, minWidth: 200 }}
              />
              <button className="btn" onClick={addQuestion} disabled={busy !== ""}>
                Add
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              <h2>Sessions for this role</h2>
              <span className="badge">{sessions.length}</span>
            </div>
            {sessions.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                None yet. Start a candidate session to run the interview.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{s.candidate_name}</td>
                      <td>
                        <span
                          className={
                            "badge " +
                            (s.status === "completed"
                              ? "ok"
                              : s.status === "disqualified"
                                ? "high"
                                : "info")
                          }
                        >
                          {s.status.replace("_", " ")}
                        </span>
                      </td>
                      <td>{s.overall_score !== null ? `${s.overall_score}/5` : "—"}</td>
                      <td className="right">
                        <Link className="btn btn-sm" to={`/report/${s.id}`}>
                          Report
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
