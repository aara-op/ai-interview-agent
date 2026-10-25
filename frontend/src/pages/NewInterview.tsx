import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type InterviewConfig } from "../api";

const CATEGORIES = [
  { id: "technical", label: "Technical depth" },
  { id: "experience", label: "Past experience" },
  { id: "behavioral", label: "Behavioural" },
  { id: "scenario", label: "Scenario / problem solving" },
];

const DEFAULTS: InterviewConfig = {
  job_title: "",
  job_description: "",
  required_skills: "",
  experience_level: "mid",
  min_years_experience: 0,
  duration_minutes: 30,
  question_count: 10,
  categories: "technical,behavioral,experience,scenario",
  difficulty: "mixed",
  per_question_limit_seconds: 90,
  allow_followups: true,
  max_followups: 3,
  recruiter_questions: "",
  weight_technical: 50,
  weight_behavioral: 20,
  weight_integrity: 30,
};

export default function NewInterview() {
  const nav = useNavigate();
  const [cfg, setCfg] = useState<InterviewConfig>(DEFAULTS);
  const [resume, setResume] = useState<File | null>(null);
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof InterviewConfig>(k: K, v: InterviewConfig[K]) =>
    setCfg((c) => ({ ...c, [k]: v }));

  const toggleCategory = (id: string) => {
    const current = cfg.categories.split(",").filter(Boolean);
    const next = current.includes(id)
      ? current.filter((c) => c !== id)
      : [...current, id];
    set("categories", next.join(","));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!cfg.job_title.trim()) return setError("Enter a job title.");
    if (!cfg.job_description.trim() && !jdFile)
      return setError("Provide a job description as text or a file.");
    setBusy(true);
    try {
      const iv = await api.createInterview(cfg, resume, jdFile);
      nav(`/interviews/${iv.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="spread mb">
        <div>
          <h1>Configure an interview</h1>
          <p className="muted" style={{ margin: 0 }}>
            The agent matches the role requirements against the resume and writes
            the question set.
          </p>
        </div>
        <Link className="btn" to="/dashboard">
          Back
        </Link>
      </div>

      {error && <div className="notice err mb">{error}</div>}

      <form onSubmit={submit}>
        <div className="grid grid-2">
          <div className="card">
            <div className="card-title">
              <h2>1 · Role</h2>
            </div>

            <label className="field">
              <span>Job title</span>
              <input
                type="text"
                value={cfg.job_title}
                placeholder="Senior Backend Engineer"
                onChange={(e) => set("job_title", e.target.value)}
              />
            </label>

            <label className="field">
              <span>Required skills (comma separated)</span>
              <input
                type="text"
                value={cfg.required_skills}
                placeholder="Java, Spring Boot, Kafka, Kubernetes"
                onChange={(e) => set("required_skills", e.target.value)}
              />
              <div className="hint">
                Leave blank to derive them automatically from the job description.
              </div>
            </label>

            <label className="field">
              <span>Job description</span>
              <textarea
                rows={7}
                value={cfg.job_description}
                placeholder="Responsibilities, requirements, team context…"
                onChange={(e) => set("job_description", e.target.value)}
              />
            </label>

            <label className="field">
              <span>…or upload the job description</span>
              <div className="filepick">
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={(e) => setJdFile(e.target.files?.[0] ?? null)}
                />
                <span className="pick">Choose file</span>
                <span className="name">
                  {jdFile ? jdFile.name : "PDF, DOCX or TXT"}
                </span>
              </div>
            </label>

            <div className="grid grid-2">
              <label className="field">
                <span>Experience level</span>
                <select
                  value={cfg.experience_level}
                  onChange={(e) => set("experience_level", e.target.value)}
                >
                  <option value="intern">Intern</option>
                  <option value="junior">Junior</option>
                  <option value="mid">Mid</option>
                  <option value="senior">Senior</option>
                  <option value="lead">Lead</option>
                </select>
              </label>
              <label className="field">
                <span>Minimum years</span>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={cfg.min_years_experience}
                  onChange={(e) =>
                    set("min_years_experience", Number(e.target.value))
                  }
                />
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              <h2>2 · Candidate resume</h2>
            </div>

            <label className="field">
              <span>Resume file (PDF or DOCX)</span>
              <div className="filepick">
                <input
                  type="file"
                  accept=".pdf,.docx"
                  onChange={(e) => setResume(e.target.files?.[0] ?? null)}
                />
                <span className="pick">Choose file</span>
                <span className="name">
                  {resume ? resume.name : "No file selected"}
                </span>
              </div>
              <div className="hint">
                Skills, experience, education, projects and certifications are
                extracted and used to target the questions. Optional — the agent
                can also interview without one.
              </div>
            </label>

            <div className="card-title mt">
              <h2>3 · Interview settings</h2>
            </div>

            <div className="grid grid-2">
              <label className="field">
                <span>Number of questions</span>
                <input
                  type="number"
                  min={1}
                  max={40}
                  value={cfg.question_count}
                  onChange={(e) => set("question_count", Number(e.target.value))}
                />
                <div className="hint">Default is 10 when left unset.</div>
              </label>
              <label className="field">
                <span>Total duration (minutes)</span>
                <input
                  type="number"
                  min={5}
                  max={240}
                  value={cfg.duration_minutes}
                  onChange={(e) => set("duration_minutes", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Time per answer (seconds)</span>
                <input
                  type="number"
                  min={15}
                  max={600}
                  value={cfg.per_question_limit_seconds}
                  onChange={(e) =>
                    set("per_question_limit_seconds", Number(e.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>Difficulty</span>
                <select
                  value={cfg.difficulty}
                  onChange={(e) => set("difficulty", e.target.value)}
                >
                  <option value="easy">Easier</option>
                  <option value="mixed">Mixed by category</option>
                  <option value="hard">Harder</option>
                </select>
              </label>
            </div>

            <span className="flabel">Question categories</span>
            <div className="chips mb">
              {CATEGORIES.map((c) => {
                const on = cfg.categories.split(",").includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={"chip" + (on ? " hit" : "")}
                    onClick={() => toggleCategory(c.id)}
                    style={{ cursor: "pointer" }}
                  >
                    {on ? "✓ " : ""}
                    {c.label}
                  </button>
                );
              })}
            </div>

            <label className="checkrow">
              <input
                type="checkbox"
                checked={cfg.allow_followups}
                onChange={(e) => set("allow_followups", e.target.checked)}
              />
              <span>
                Allow contextual follow-up questions
                <div className="hint">
                  Follow-ups stay inside the configured budget so the interview
                  never silently grows longer.
                </div>
              </span>
            </label>

            {cfg.allow_followups && (
              <label className="field">
                <span>Maximum follow-ups</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={cfg.max_followups}
                  onChange={(e) => set("max_followups", Number(e.target.value))}
                />
              </label>
            )}

            <label className="field">
              <span>Recruiter-written questions (one per line, optional)</span>
              <textarea
                rows={4}
                value={cfg.recruiter_questions}
                placeholder={"Walk us through your most recent deployment."}
                onChange={(e) => set("recruiter_questions", e.target.value)}
              />
              <div className="hint">
                These are kept as-is; AI questions fill the remaining slots up to
                the configured count.
              </div>
            </label>
          </div>
        </div>

        <div className="card mt">
          <div className="card-title">
            <h2>Scoring weights</h2>
          </div>
          <p className="muted">
            How much each part counts toward the composite score. Technical and
            integrity weigh more than behavioral by default; the values are
            normalised, so they need not add up to 100.
          </p>
          <div className="grid grid-3">
            {([
              ["weight_technical", "Technical %"],
              ["weight_behavioral", "Behavioral %"],
              ["weight_integrity", "Integrity (computer vision) %"],
            ] as const).map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={cfg[key]}
                  onChange={(e) =>
                    set(key, Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                  }
                />
              </label>
            ))}
          </div>
        </div>

        <div className="row mt">
          <button className="btn btn-primary btn-lg" disabled={busy} type="submit">
            {busy ? (
              <>
                <span className="spinner" /> Analysing and generating questions…
              </>
            ) : (
              "Create interview & generate questions"
            )}
          </button>
          <Link className="btn" to="/dashboard">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
