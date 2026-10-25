export interface ParsedResume {
  skills?: string[];
  years_experience?: number;
  education?: string[];
  projects?: string[];
  certifications?: string[];
  experience_roles?: { company?: string; title?: string; duration?: string; highlights?: string[] }[];
  summary?: string;
  email?: string;
  phone?: string;
  extraction_method?: string;
}

export interface ResumeInfo {
  id: number;
  filename: string;
  candidate_name: string;
  candidate_email: string;
  candidate_phone: string;
  years_experience: number;
  parsed: ParsedResume;
  text_length: number;
  text_preview: string;
}

export interface Question {
  id: number;
  position: number;
  text: string;
  category: string;
  difficulty: string;
  source: string;
  rationale: string;
  skill_target: string;
}

export interface Interview {
  id: number;
  public_id: string;
  created_at: string | null;
  job_title: string;
  job_description: string;
  required_skills: string[];
  experience_level: string;
  responsibilities: string[];
  min_years_experience: number;
  duration_minutes: number;
  question_count: number;
  categories: string[];
  difficulty: string;
  per_question_limit_seconds: number;
  allow_followups: boolean;
  max_followups: number;
  /** recruiter scoring weights (percent, normalised when scored) */
  weights?: { technical: number; behavioral: number; integrity: number };
  status: string;
  resume: ResumeInfo | null;
  questions: Question[];
  question_count_actual?: number;
  resume_name?: string;
  session_count?: number;
}

export interface Answer {
  id: number;
  position: number;
  question_id: number;
  question_text: string;
  category: string;
  transcript: string;
  status: "pending" | "answered" | "skipped" | "unanswered";
  is_followup: boolean;
  parent_answer_id: number | null;
  duration_seconds: number;
  char_count: number;
  answered_at: string | null;
  score: number | null;
  score_detail: ScoreDetail | null;
}

export interface ScoreDetail {
  score?: number;
  question?: string;
  category?: string;
  strengths?: string[];
  gaps?: string[];
  evidence?: string;
  explanation?: string;
  overridden_by_recruiter?: boolean;
  override_note?: string;
  rubric_level?: string;
}

export interface Incident {
  id: number;
  ts_ms: number;
  wall_time: string | null;
  type: string;
  severity: "info" | "warning" | "high";
  observed: string;
  inference: string;
  value: string;
  duration_ms: number;
  acknowledged: boolean;
  reviewer_note: string;
  has_evidence: boolean;
  evidence_data_url?: string;
}

export interface IntegrityReview {
  verdict: "" | "clean" | "review" | "suspicious";
  penalty: number;
  note: string;
}

export interface SuspicionEvent {
  id: number;
  type: string;
  ts_ms: number;
  wall_time: string | null;
  severity: string;
  observed: string;
  has_evidence: boolean;
  acknowledged: boolean;
}

export interface SuspicionSummary {
  level: "none" | "low" | "medium" | "high";
  score: number;
  high: number;
  warning: number;
  forgery_flags: string[];
  events: SuspicionEvent[];
  explanation: string;
}

export interface Candidate {
  id: number;
  name: string;
  email: string;
  aadhaar_masked: string;
  pfp_url: string;
  has_pfp: boolean;
  resume_filename: string;
  resume_email: string;
  has_resume: boolean;
  has_voice: boolean;
  years_experience: number;
  skills: string[];
  roles: string[];
  education: string[];
  projects: string[];
  phone: string;
  summary: string;
  created_at: string | null;
  last_login_at: string | null;
}

/** One interview a candidate is booked on (their dashboard). */
export interface CandidateInterview {
  session_id: number;
  code: string;
  interview_id: number;
  job_title: string;
  status: string;
  meeting_at: string | null;
  meeting_minutes: number;
  started_at: string | null;
  ended_at: string | null;
  score: number | null;
  invite_email: string;
}

export interface OrgProfile {
  org_name: string;
  org_email: string;
  org_phone: string;
  org_notes: string;
}

export interface DashboardRow {
  session_id: number;
  interview_id: number;
  job_title: string;
  candidate: string;
  email: string;
  status: string;
  meeting_at: string | null;
  meeting_minutes: number;
  shortlisted: boolean;
  code: string;
  score: number | null;
  recommendation: string;
  match?: SkillMatch | null;
  years?: number;
  resume?: string;
  has_resume?: boolean;
}

export interface DashboardData {
  org: OrgProfile;
  stats: {
    interviews: number;
    sessions: number;
    upcoming: number;
    completed: number;
    avg_score: number | null;
  };
  upcoming: DashboardRow[];
  candidates: DashboardRow[];
}

export interface SkillMatch {
  required: string[];
  matched: string[];
  missing: string[];
  score: number;
}

export interface Applicant {
  session_id: number;
  candidate: Candidate;
  match: SkillMatch;
  years_experience: number;
  shortlisted: boolean;
  meeting_at: string | null;
  meeting_minutes: number;
  invite_email: string;
  invite_status: string;
  invite_sent_at: string | null;
  status: string;
}

export interface InviteResult {
  mail_backend: "smtp" | "outbox";
  meeting_at: string;
  results: {
    session_id: number;
    candidate?: string;
    email?: string;
    status: string;
    detail?: string;
    preview?: string;
  }[];
}

export interface DeviceCheck {
  camera?: string;
  microphone?: string;
  resolution?: string;
  earpiece?: string;
  notes?: string;
}

export interface Session {
  id: number;
  public_id: string;
  interview_id: number;
  candidate_name: string;
  candidate_email: string;
  status: string;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  consent_recording: boolean;
  consent_proctoring: boolean;
  device_check: DeviceCheck;
  pair_token: string;
  candidate: Candidate | null;
  evaluation_status: string;
  evaluation: Evaluation | null;
  recorder: boolean;
  recruiter_notes: string;
  integrity: IntegrityReview;
  answer_count: number;
  incident_count: number;
  answers: Answer[];
  incidents?: Incident[];
  interview?: Interview;
}

export interface QuestionScore {
  answer_id: number;
  question: string;
  category: string;
  score: number;
  strengths: string[];
  gaps: string[];
  evidence: string;
  explanation: string;
}

export interface Evaluation {
  per_question: QuestionScore[];
  dimension_scores: Record<string, { score: number; comment: string }>;
  strengths: string[];
  knowledge_gaps: string[];
  further_assessment: string[];
  summary: string;
  recommendation: string;
  overall_score: number;
  rubric: Record<string, string>;
  scoring_basis: string;
  engine: string;
}

export interface Scorecard {
  technical_10: number | null;
  technical_questions: number;
  behavioral_5: number | null;
  behavioral_questions: number;
  integrity_index: number;
  integrity_counts: { high: number; warning: number };
  composite_pct: number;
  weights: { technical: number; behavioral: number; integrity: number };
  veto: {
    auto_reject: boolean;
    decision: "auto_reject" | "review" | "clear";
    reason: string;
    override: "" | "reinstated" | "rejected";
    final: "auto_reject" | "review" | "clear" | "reinstated" | "rejected";
    threshold: number;
  };
  basis: string;
}

export interface Report {
  session: Session;
  interview: Interview;
  answers: Answer[];
  scorecard: Scorecard;
  evaluation: Evaluation | null;
  evaluation_status: string;
  incidents: Incident[];
  suspicion: SuspicionSummary;
  integrity: IntegrityReview;
  adjusted_score: number | null;
  proctoring_summary: {
    total: number;
    by_severity: Record<string, number>;
    coverage_seconds: number;
    disclaimer: string;
  };
}

export interface Progress {
  total: number;
  pending: number;
  answered: number;
  skipped: number;
  unanswered: number;
  followups_used: number;
  followups_budget: number;
  current: Answer | null;
  elapsed_seconds: number;
}

export const CATEGORY_LABELS: Record<string, string> = {
  icebreaker: "Warm-up",
  technical: "Technical",
  experience: "Experience",
  behavioral: "Behavioural",
  scenario: "Scenario",
  recruiter: "Recruiter",
  followup: "Follow-up",
};

export const INCIDENT_LABELS: Record<string, string> = {
  face_absent: "Face not in frame",
  multiple_faces: "More than one person",
  face_reacquired: "Face back in frame",
  identity_verified: "Identity verified",
  identity_mismatch: "Face does not match profile photo",
  gaze_aversion: "Attention off-screen",
  prolonged_gaze_aversion: "Prolonged off-screen attention",
  secondary_voice: "Possible additional voice",
  background_noise: "Audio while interviewer spoke",
  silence: "Extended silence",
  camera_lost: "Camera interrupted",
  microphone_lost: "Microphone interrupted",
  tab_blur: "Interview tab lost focus",
  window_blur: "Window lost focus",
  fullscreen_exit: "Left fullscreen mode",
  disqualified: "Interview disqualified",
  secondary_camera_disconnected: "Secondary camera disconnected",
  secondary_camera_connected: "Secondary camera connected",
  secondary_multiple_faces: "Multiple people in secondary view",
  recording_interrupted: "Recording interrupted",
  vision_unavailable: "Vision analysis unavailable",
  eye_gaze_hold: "Eyes held off-screen",
  mobile_glance: "Repeated glances toward the phone side",
  posture_aversion: "Off-axis head posture",
  lip_audio_desync: "Voice without lip movement",
  extra_device: "Unnecessary device in frame",
  camera_glitch: "Camera frozen, covered or stopped",
  backup_deployed: "Backup question deployed",
  environment_match: "Both cameras show the same room",
  environment_mismatch: "Cameras show different environments",
  secondary_camera_unstable: "Phone camera stopped repeatedly",
  note: "Note",
};
