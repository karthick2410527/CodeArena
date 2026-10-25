export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export interface User {
  id: string;
  username: string;
  /** null for a GitHub account that shared no verified email. */
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** false for accounts that only sign in through Google or GitHub. */
  has_password: boolean;
  role: "USER" | "ADMIN";
  created_at: string;
}

/** A sign-in provider; `enabled` is false until the server has its credentials. */
export interface AuthProvider {
  id: "google" | "github";
  name: string;
  enabled: boolean;
  /** Browser navigation target (not under /api/v1); null when not enabled. */
  authorize_url: string | null;
}

/** A Google or GitHub account connected to the signed-in user. */
export interface Identity {
  provider: "google" | "github";
  login: string | null;
  email: string | null;
  created_at: string;
  last_used_at: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export type ProblemStatus = "SOLVED" | "ATTEMPTED";

export interface ProblemSummary {
  number: number;
  slug: string;
  title: string;
  difficulty: Difficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
  tags: string[];
  /** Distinct users with an accepted submission. */
  solved_by: number;
  /** Accepted ÷ judged submissions, percent; null before any. */
  acceptance_rate: number | null;
  /** The signed-in caller's progress; null when untouched or signed out. */
  status: ProblemStatus | null;
  /** The community author's username; null for the platform's own problems. */
  author: string | null;
}

/** The envelope every paginated endpoint returns. */
export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export type ProblemList = Paginated<ProblemSummary>;

export interface Sample {
  input: string;
  expected_output: string;
  explanation: string | null;
}

export interface ProblemDetail extends ProblemSummary {
  /** Where an imported problem came from (Codeforces, AtCoder), shown as credit. */
  source_url: string | null;
  description: string;
  constraints: string;
  samples: Sample[];
  /** A finished contest's write-up for this problem, when its authors wrote one. */
  editorial?: { contest_slug: string; contest_title: string; label: string; text: string } | null;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface ProblemFilters {
  page: number;
  limit: number;
  difficulty?: Difficulty;
  tag?: string;
  q?: string;
  status?: "solved" | "attempted" | "unsolved";
  sort?: "number" | "difficulty" | "solved" | "newest";
}

// ------------------------------------------------- Phase 2: editor and runs

export interface Language {
  id: string;
  display_name: string;
  monaco_id: string;
  starter_code: string;
}

export interface ExecutionLimits {
  max_source_bytes: number;
  max_input_bytes: number;
  max_output_bytes: number;
}

export type RunStatus = "QUEUED" | "RUNNING" | "FINISHED";

export type RunOutcome =
  | "OK"
  | "COMPILATION_ERROR"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "INTERNAL_ERROR";

export type ExecStatus =
  | "OK"
  | "NON_ZERO_EXIT"
  | "SIGNALLED"
  | "TIME_LIMIT"
  | "MEMORY_LIMIT"
  | "OUTPUT_LIMIT";

export interface RunCase {
  position: number;
  label: string;
  input: string;
  expected_output: string | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  exec_status: ExecStatus;
  /** `null` for custom input: there is nothing to compare against. */
  passed: boolean | null;
  time_ms: number | null;
  memory_bytes: number | null;
  exit_code: number | null;
  signal: number | null;
}

export interface Run {
  run_id: string;
  problem_slug: string;
  language: string;
  mode: "SAMPLES" | "CUSTOM";
  status: RunStatus;
  outcome: RunOutcome | null;
  compile_output: string;
  compile_time_ms: number | null;
  cases: RunCase[];
  created_at: string;
  finished_at: string | null;
  message: string | null;
}

export interface CreateRunResponse {
  run_id: string;
  status: RunStatus;
}

// --------------------------------------------- Phase 3: submissions/verdicts

export type Verdict =
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "COMPILATION_ERROR"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "INTERNAL_ERROR";

/** What the API reports while polling: lifecycle first, then the verdict. */
export type SubmissionStatus = "QUEUED" | "RUNNING" | Verdict;

export const TERMINAL_VERDICTS: Verdict[] = [
  "ACCEPTED",
  "WRONG_ANSWER",
  "COMPILATION_ERROR",
  "RUNTIME_ERROR",
  "TIME_LIMIT_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
];

export function isTerminal(status: SubmissionStatus): boolean {
  return status !== "QUEUED" && status !== "RUNNING";
}

export interface SubmissionSummary {
  submission_id: string;
  problem_slug: string;
  problem_title: string;
  language: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  passed_tests: number;
  total_tests: number;
  execution_time_ms: number | null;
  memory_bytes: number | null;
  created_at: string;
}

export interface Submission extends SubmissionSummary {
  username: string;
  score: number;
  max_score: number;
  failed_case_position: number | null;
  finished_at: string | null;
  /** Present only for the owner (or an admin). */
  source_code?: string;
  compile_output?: string;
  message: string | null;
}

export interface CreateSubmissionResponse {
  submission_id: string;
  status: "QUEUED";
}

export interface TestResult {
  position: number;
  is_sample: boolean;
  verdict: Verdict;
  execution_time_ms: number | null;
  memory_bytes: number | null;
  points_awarded: number;
}

export interface TestResults {
  submission_id: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  passed_tests: number;
  total_tests: number;
  results: TestResult[];
}

export interface SubmissionFilters {
  page: number;
  limit: number;
  problem?: string;
  verdict?: string;
  language?: string;
}

// ------------------------------------------------ Phase 4: profile and admin

export interface UserStats {
  total_submissions: number;
  accepted_submissions: number;
  problems_solved: number;
  problems_available: number;
  solved_easy: number;
  solved_medium: number;
  solved_hard: number;
  available_easy: number;
  available_medium: number;
  available_hard: number;
  acceptance_rate: number;
  last_submission_at: string | null;
  verdict_counts: Partial<Record<Verdict, number>>;
}

export interface AdminProblem {
  /** Where an imported problem came from (Codeforces, AtCoder), shown as credit. */
  source_url: string | null;
  id: string;
  number: number;
  slug: string;
  title: string;
  description: string;
  constraints: string;
  difficulty: Difficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
  published: boolean;
  tags: string[];
  sample_count: number;
  hidden_count: number;
  submission_count: number;
  created_at: string;
  updated_at: string;
  /** Author's username; null for the platform's own problems. */
  owner: string | null;
  /** Slugs of the contests that use it. */
  contests: string[];
}

export interface ProblemInput {
  source_url?: string | null;
  slug: string;
  title: string;
  description: string;
  constraints?: string;
  difficulty: Difficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
  published?: boolean;
  tags?: string[];
}

export interface AdminTestCase {
  id: string;
  position: number;
  input: string;
  expected_output: string;
  explanation: string | null;
  is_sample: boolean;
  points: number;
}

export interface TestCaseInput {
  input: string;
  expected_output: string;
  explanation?: string | null;
  is_sample?: boolean;
  points?: number;
  position?: number;
}

// ------------------------------------------------- Phase 5: operations views

export interface Worker {
  worker_id: string;
  queue_driver: string;
  runner_strategy: string;
  version: string;
  started_at: string;
  last_seen_at: string;
  seconds_since_heartbeat: number;
  healthy: boolean;
  submissions_judged: number;
  runs_executed: number;
  failures: number;
  current_submission_id: string | null;
}

export interface WorkersReport {
  workers: Worker[];
  queued_submissions: number;
  running_submissions: number;
  queue_backlog: number;
  oldest_pending_secs: number | null;
  unresolved_dead_letters: number;
}

export interface DeadLetter {
  id: number;
  submission_id: string | null;
  event_type: string;
  reason: string;
  correlation_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

// ---- debug replays ---------------------------------------------------------

export type ReplayStatus = "QUEUED" | "RECORDING" | "FINISHED";

export type ReplayEnd =
  | "EXITED"
  | "CRASHED"
  | "STEP_LIMIT"
  | "TIME_LIMIT"
  | "COMPILE_ERROR"
  | "RECORDER_ERROR";

/** A recorded execution. `timeline` is `[line, depth]` per step, enough to step over, out and to breakpoints. */
export interface Replay {
  replay_id: string;
  status: ReplayStatus;
  problem_slug: string | null;
  language: string;
  source_code: string;
  stdin: string;
  step_count: number;
  termination: { kind: ReplayEnd; exit_code: number | null; detail: string } | null;
  compile_output: string;
  /** Everything the program printed; a step shows the first `stdout_length` characters. */
  stdout: string;
  timeline: [number, number][];
  created_at: string;
  finished_at: string | null;
  message: string | null;
}

export interface ReplayVariable {
  /** Path from the frame's variable: `v`, `v[2]`, `p.x`. */
  name: string;
  value: string;
  /** Declared type, for top-level variables only. */
  type: string | null;
  /** Set (or brought into scope) by this step. */
  changed: boolean;
}

/** `index` 0 is main; the last frame is the one executing. */
export interface ReplayFrame {
  index: number;
  function: string;
  line: number;
  variables: ReplayVariable[];
}

export interface ReplayStep {
  step: number;
  line: number;
  depth: number;
  stdout_length: number;
  frames: ReplayFrame[];
}

export interface ReplayStepPage {
  from: number;
  total: number;
  steps: ReplayStep[];
}

// ---- contests -----------------------------------------------------------------

export type ContestFormat = "CODEFORCES" | "ICPC" | "ATCODER" | "IOI";
export type ContestPhase = "UPCOMING" | "RUNNING" | "ENDED";

export interface ContestSummary {
  slug: string;
  title: string;
  format: ContestFormat;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  phase: ContestPhase;
  published: boolean;
  /** Usernames, owner first. */
  authors: string[];
  problem_count: number;
  participants: number;
  registered: boolean;
  my_role: "OWNER" | "AUTHOR" | null;
}

/** A contest the signed-in user registered for, with their place in it. */
export interface JoinedContest {
  contest: ContestSummary;
  /** Null before the start, or before a first submission. */
  rank: number | null;
  /** People on the board. */
  ranked: number;
  solved: number;
  score: number;
}

export interface ContestProblem {
  label: string;
  slug: string;
  title: string;
  points: number;
  solved_by: number;
  my_status: ProblemStatus | null;
}

export interface ContestDetail {
  contest: ContestSummary;
  description: string;
  problems: ContestProblem[];
  /** False before the start for anyone but the authors. */
  problems_visible: boolean;
  /** The caller can read an editorial now: the contest ended (or they author it) and one is written. */
  editorial_available: boolean;
  server_time: string;
}

export interface ContestEditorial {
  intro: string;
  problems: { label: string; slug: string; title: string; editorial: string }[];
  /** Everyone can read it (the contest has ended). */
  is_public: boolean;
}

export interface ContestInput {
  slug?: string;
  title?: string;
  description?: string;
  format?: ContestFormat;
  starts_at?: string;
  duration_minutes?: number;
}

export interface ContestProblemView {
  label: string;
  points: number;
  problem: ProblemDetail;
}

export interface ContestSubmission {
  submission_id: string;
  label: string;
  problem_title: string;
  language: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  passed_tests: number;
  total_tests: number;
  execution_time_ms: number | null;
  elapsed_seconds: number | null;
  in_contest: boolean;
  created_at: string;
}

export interface StandingsCell {
  label: string;
  solved: boolean;
  wrong: number;
  pending: number;
  solved_at: number | null;
  score: number | null;
  first_solve: boolean;
}

export interface StandingsRow {
  rank: number;
  participant: { user_id: string; username: string; display_name: string | null; avatar_url: string | null };
  score: number;
  /** ICPC: minutes; AtCoder: seconds; otherwise null. */
  penalty: number | null;
  solved: number;
  cells: StandingsCell[];
}

export interface StandingsView {
  format: ContestFormat;
  phase: ContestPhase;
  problems: { label: string; points: number }[];
  rows: StandingsRow[];
  generated_at: string;
}

// ---- profiles -----------------------------------------------------------------

export interface PersonHit {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  solved: number;
  contests: number;
  joined_at: string;
}

export interface ActivityDay {
  date: string;
  submissions: number;
  accepted: number;
}

export interface ContestHistoryEntry {
  slug: string;
  title: string;
  format: ContestFormat;
  starts_at: string;
  phase: ContestPhase;
  rank: number | null;
  participants: number;
  solved: number;
  score: number;
}

export interface Profile {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  role: "USER" | "ADMIN";
  joined_at: string;
  solved: { total: number; easy: number; medium: number; hard: number };
  submissions: number;
  accepted: number;
  acceptance_rate: number;
  current_streak: number;
  longest_streak: number;
  activity: ActivityDay[];
  recent: { slug: string; title: string; difficulty: Difficulty; solved_at: string }[];
  contests: ContestHistoryEntry[];
  problems_authored: number;
  contests_hosted: number;
}

// ---- billing ----------------------------------------------------------------

export type BillingMode = "razorpay" | "test" | "off";

export interface BillingPlan {
  id: string;
  name: string;
  amount_paise: number;
  currency: string;
  period_days: number;
}

export interface BillingPlans {
  /** Plans can be bought, for real or in test mode. */
  enabled: boolean;
  /** razorpay: real payments; test: the built-in test checkout, no money moves. */
  mode: BillingMode;
  /** Hosting needs a plan; false means hosting is free on this server. */
  required: boolean;
  key_id: string | null;
  plans: BillingPlan[];
}

export interface BillingPayment {
  id: string;
  plan: string;
  amount_paise: number;
  currency: string;
  status: "PAID" | "FAILED";
  razorpay_payment_id: string | null;
  /** Made with the test checkout: no money moved. */
  test: boolean;
  created_at: string;
  paid_at: string | null;
}

export interface BillingMe {
  enabled: boolean;
  mode: BillingMode;
  required: boolean;
  /** May publish contests now. */
  can_host: boolean;
  hosting_until: string | null;
  plan: string | null;
  payments: BillingPayment[];
}

export interface BillingOrder {
  order_id: string;
  mode: "razorpay" | "test";
  amount_paise: number;
  currency: string;
  /** Razorpay's public key; null for a test order. */
  key_id: string | null;
  plan: string;
  plan_name: string;
  name: string;
  email: string | null;
}

/** A problem read from Codeforces or AtCoder to prefill the editor; nothing is saved yet. */
export interface ImportedProblem {
  platform: "codeforces" | "atcoder";
  source_id: string;
  source_url: string;
  slug: string;
  title: string;
  description: string;
  constraints: string;
  difficulty: Difficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
  tags: string[];
  samples: { input: string; output: string }[];
  /** What could not be read, for the author to fill in. */
  warnings: string[];
}

/** A problem's editorial read from its judge, to prefill the contest editorial. */
export interface ImportedEditorial {
  /** Markdown; empty when only the link could be found. */
  text: string;
  editorial_url: string;
  warnings: string[];
}
