export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export interface User {
  id: string;
  username: string;
  email: string;
  role: "USER" | "ADMIN";
  created_at: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export interface ProblemSummary {
  number: number;
  slug: string;
  title: string;
  difficulty: Difficulty;
  time_limit_ms: number;
  memory_limit_mb: number;
  tags: string[];
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
  description: string;
  constraints: string;
  samples: Sample[];
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
}

export interface ProblemInput {
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
