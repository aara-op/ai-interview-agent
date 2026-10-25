import type {
  Answer,
  Applicant,
  Candidate,
  CandidateInterview,
  DashboardData,
  Incident,
  Interview,
  InviteResult,
  OrgProfile,
  Report,
  Session,
} from "./types";

const BASE = "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export interface InterviewConfig {
  job_title: string;
  job_description: string;
  required_skills: string;
  experience_level: string;
  min_years_experience: number;
  duration_minutes: number;
  question_count: number;
  categories: string;
  difficulty: string;
  per_question_limit_seconds: number;
  allow_followups: boolean;
  max_followups: number;
  recruiter_questions: string;
  weight_technical: number;
  weight_behavioral: number;
  weight_integrity: number;
}

export const api = {
  health: () => request<{ ok: boolean; llm: { enabled: boolean; model: string } }>(
    "/api/health",
  ),

  createInterview: async (
    cfg: InterviewConfig,
    resume: File | null,
    jdFile: File | null,
  ): Promise<Interview> => {
    const form = new FormData();
    Object.entries(cfg).forEach(([k, v]) => form.append(k, String(v)));
    if (resume) form.append("resume", resume);
    if (jdFile) form.append("jd_file", jdFile);
    return request<Interview>("/api/interviews", { method: "POST", body: form });
  },

  listInterviews: () => request<Interview[]>("/api/interviews"),
  getInterview: (id: number) => request<Interview>(`/api/interviews/${id}`),

  regenerate: (id: number, payload: Record<string, unknown>) =>
    request<Interview>(`/api/interviews/${id}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  addQuestion: (id: number, text: string) =>
    request<Interview>(`/api/interviews/${id}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),

  deleteQuestion: (id: number, qid: number) =>
    request<Interview>(`/api/interviews/${id}/questions/${qid}`, {
      method: "DELETE",
    }),

  createSession: (interview_id: number, candidate_name = "", candidate_email = "") =>
    request<Session>("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interview_id, candidate_name, candidate_email }),
    }),

  getSession: (id: number) => request<Session>(`/api/sessions/${id}`),

  consent: (
    id: number,
    payload: {
      consent_recording: boolean;
      consent_proctoring: boolean;
      device_check: Record<string, string>;
    },
  ) =>
    request<Session>(`/api/sessions/${id}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  startSession: (id: number) =>
    request<Session>(`/api/sessions/${id}/start`, { method: "POST" }),

  next: (id: number) => request<import("./types").Progress>(`/api/sessions/${id}/next`),

  submitAnswer: (
    id: number,
    answerId: number,
    payload: { transcript: string; status: string; duration_seconds: number },
  ) =>
    request<Answer>(`/api/sessions/${id}/answers/${answerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  followup: (id: number, parentAnswerId: number) =>
    request<{
      allowed: boolean;
      reason?: string;
      /** complete = task done · unsatisfactory = follow-up warranted ·
       *  unclear = nothing usable was captured (room re-asks) */
      verdict?: "complete" | "unsatisfactory" | "unclear";
      detail?: string;
      question: string | null;
      answer?: Answer;
      used?: number;
      budget?: number;
    }>(`/api/sessions/${id}/followup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_answer_id: parentAnswerId }),
    }),

  /** Deploy a reserve question after a camera glitch / camera cut. */
  backup: (id: number) =>
    request<{
      allowed: boolean;
      reason?: string;
      answer: Answer | null;
      used?: number;
      budget?: number;
    }>(`/api/sessions/${id}/backup`, { method: "POST" }),

  complete: (id: number, status: "completed" | "disqualified" = "completed") =>
    request<Session>(`/api/sessions/${id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }),

  recompute: (id: number) =>
    request<{ evaluation_status: string }>(`/api/sessions/${id}/evaluate`, {
      method: "POST",
    }),

  report: (id: number, evidence = false) =>
    request<Report>(
      `/api/sessions/${id}/report${evidence ? "?evidence=true" : ""}`,
    ),

  updateReport: (
    id: number,
    payload: {
      recruiter_notes?: string;
      overrides?: { answer_id: number; score: number; note?: string }[];
      acknowledged_incidents?: number[];
      integrity?: { verdict: string; penalty: number; note: string };
      veto_override?: "" | "reinstated" | "rejected";
    },
  ) =>
    request<Report>(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  logIncident: (
    id: number,
    payload: {
      type: string;
      ts_ms: number;
      observed?: string;
      inference?: string;
      value?: string;
      duration_ms?: number;
      severity?: string;
      evidence_data_url?: string | null;
    },
  ) =>
    request<Incident>(`/api/sessions/${id}/incidents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  incidents: (id: number, evidence = false) =>
    request<Incident[]>(
      `/api/sessions/${id}/incidents${evidence ? "?evidence=true" : ""}`,
    ),

  patchIncident: (
    id: number,
    incidentId: number,
    payload: { acknowledged?: boolean; reviewer_note?: string },
  ) =>
    request<Incident>(`/api/sessions/${id}/incidents/${incidentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  pairInfo: (id: number) =>
    request<{ token: string; session_id: number }>(`/api/sessions/${id}/pair`),

  resolveJoin: (code: string) =>
    request<{ id: number; status: string; job_title: string; candidate_name: string }>(
      `/api/join/${encodeURIComponent(code)}`,
    ),

  enroll: (form: FormData) =>
    request<{ candidate: Candidate; session: Session }>("/api/candidates/enroll", {
      method: "POST",
      body: form,
    }),

  applicants: (interviewId: number) =>
    request<Applicant[]>(`/api/interviews/${interviewId}/applicants`),

  sendInvites: (
    interviewId: number,
    payload: {
      session_ids: number[];
      meeting_at: string;
      duration_minutes: number;
      origin: string;
      message: string;
    },
  ) =>
    request<InviteResult>(`/api/interviews/${interviewId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  candidateInterviews: (candidateId: number) =>
    request<CandidateInterview[]>(`/api/candidates/${candidateId}/interviews`),

  settings: () => request<OrgProfile>("/api/settings"),

  saveSettings: (payload: OrgProfile) =>
    request<OrgProfile>("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  dashboard: () => request<DashboardData>("/api/dashboard"),

  login: (payload: { code: string; email: string; password: string }) =>
    request<{ candidate: Candidate; session: Session }>("/api/candidates/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  uploadRecording: (id: number, blob: Blob) => {
    const form = new FormData();
    form.append("file", blob, "recording.webm");
    return request<{ stored: boolean; bytes: number }>(
      `/api/sessions/${id}/recording`,
      { method: "POST", body: form },
    );
  },
};

export function secondarySocketUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/rtc/${token}`;
}

export function secondaryPageUrl(token: string): string {
  return `${window.location.origin}/secondary/${token}`;
}
