import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import App from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { clearSession } from "../api/client";
import type {
  AdminProblem,
  AdminTestCase,
  AuthResponse,
  Language,
  Paginated,
  ProblemDetail,
  ProblemList,
  ProblemSummary,
  Run,
  RunCase,
  Submission,
  SubmissionSummary,
  TestResults,
  UserStats,
  WorkersReport,
} from "../api/types";

export const USER = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "ada",
  email: "ada@example.com",
  role: "USER" as const,
  created_at: "2026-01-02T03:04:05Z",
};

export const ADMIN = { ...USER, role: "ADMIN" as const, username: "root" };

export const authResponse = (over: Partial<AuthResponse> = {}): AuthResponse => ({
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "Bearer",
  expires_in: 900,
  user: USER,
  ...over,
});

export const summary = (n: number, over: Partial<ProblemSummary> = {}): ProblemSummary => ({
  number: n,
  slug: `problem-${n}`,
  title: `Problem ${n}`,
  difficulty: "EASY",
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  tags: ["math"],
  ...over,
});

export const list = (items: ProblemSummary[], over: Partial<ProblemList> = {}): ProblemList => ({
  items,
  page: 1,
  limit: 8,
  total: items.length,
  total_pages: items.length ? 1 : 0,
  ...over,
});

export const detail = (over: Partial<ProblemDetail> = {}): ProblemDetail => ({
  ...summary(1, { slug: "a-plus-b", title: "A Plus B" }),
  description: "Given two integers, print their **sum**.",
  constraints: "- `-10^9 <= a, b <= 10^9`",
  samples: [{ input: "3 5", expected_output: "8", explanation: "3 + 5 = 8." }],
  ...over,
});

export const LANGUAGES: Language[] = [
  {
    id: "cpp17",
    display_name: "C++17 (GCC)",
    monaco_id: "cpp",
    starter_code: "int main() { return 0; }\n",
  },
];

export const LIMITS = {
  max_source_bytes: 65536,
  max_input_bytes: 65536,
  max_output_bytes: 65536,
};

export const runCase = (over: Partial<RunCase> = {}): RunCase => ({
  position: 1,
  label: "Sample 1",
  input: "3 5",
  expected_output: "8",
  stdout: "8\n",
  stderr: "",
  stdout_truncated: false,
  stderr_truncated: false,
  exec_status: "OK",
  passed: true,
  time_ms: 4,
  memory_bytes: 1_048_576,
  exit_code: 0,
  signal: null,
  ...over,
});

export const run = (over: Partial<Run> = {}): Run => ({
  run_id: "run-1",
  problem_slug: "a-plus-b",
  language: "cpp17",
  mode: "SAMPLES",
  status: "FINISHED",
  outcome: "OK",
  compile_output: "",
  compile_time_ms: 120,
  cases: [runCase()],
  created_at: "2026-01-02T03:04:05Z",
  finished_at: "2026-01-02T03:04:07Z",
  message: null,
  ...over,
});

export const submissionSummary = (
  over: Partial<SubmissionSummary> = {},
): SubmissionSummary => ({
  submission_id: "sub-1",
  problem_slug: "a-plus-b",
  problem_title: "A Plus B",
  language: "cpp17",
  status: "ACCEPTED",
  verdict: "ACCEPTED",
  passed_tests: 5,
  total_tests: 5,
  execution_time_ms: 7,
  memory_bytes: 2_097_152,
  created_at: "2026-01-02T03:04:05Z",
  ...over,
});

export const submission = (over: Partial<Submission> = {}): Submission => ({
  ...submissionSummary(),
  username: "ada",
  score: 5,
  max_score: 5,
  failed_case_position: null,
  finished_at: "2026-01-02T03:04:09Z",
  source_code: "int main() { return 0; }",
  compile_output: "",
  message: null,
  ...over,
});

export const testResults = (over: Partial<TestResults> = {}): TestResults => ({
  submission_id: "sub-1",
  status: "ACCEPTED",
  verdict: "ACCEPTED",
  passed_tests: 2,
  total_tests: 2,
  results: [
    {
      position: 1,
      is_sample: true,
      verdict: "ACCEPTED",
      execution_time_ms: 3,
      memory_bytes: 1024,
      points_awarded: 0,
    },
    {
      position: 2,
      is_sample: false,
      verdict: "ACCEPTED",
      execution_time_ms: 5,
      memory_bytes: 2048,
      points_awarded: 1,
    },
  ],
  ...over,
});

export const stats = (over: Partial<UserStats> = {}): UserStats => ({
  total_submissions: 4,
  accepted_submissions: 2,
  problems_solved: 2,
  problems_available: 10,
  solved_easy: 2,
  solved_medium: 0,
  solved_hard: 0,
  available_easy: 4,
  available_medium: 4,
  available_hard: 2,
  acceptance_rate: 50,
  last_submission_at: "2026-01-02T03:04:05Z",
  verdict_counts: { ACCEPTED: 2, WRONG_ANSWER: 2 },
  ...over,
});

export const adminProblem = (over: Partial<AdminProblem> = {}): AdminProblem => ({
  id: "22222222-2222-2222-2222-222222222222",
  number: 1,
  slug: "a-plus-b",
  title: "A Plus B",
  description: "Add them.",
  constraints: "- small",
  difficulty: "EASY",
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  published: true,
  tags: ["math"],
  sample_count: 2,
  hidden_count: 3,
  submission_count: 7,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

export const adminTestCase = (over: Partial<AdminTestCase> = {}): AdminTestCase => ({
  id: "33333333-3333-3333-3333-333333333333",
  position: 1,
  input: "3 5",
  expected_output: "8",
  explanation: null,
  is_sample: true,
  points: 0,
  ...over,
});

export const workersReport = (over: Partial<WorkersReport> = {}): WorkersReport => ({
  workers: [
    {
      worker_id: "worker-a",
      queue_driver: "postgres",
      runner_strategy: "docker",
      version: "0.5.0",
      started_at: "2026-01-02T00:00:00Z",
      last_seen_at: "2026-01-02T03:04:05Z",
      seconds_since_heartbeat: 2,
      healthy: true,
      submissions_judged: 42,
      runs_executed: 10,
      failures: 0,
      current_submission_id: null,
    },
  ],
  queued_submissions: 1,
  running_submissions: 0,
  queue_backlog: 1,
  oldest_pending_secs: 3,
  unresolved_dead_letters: 0,
  ...over,
});

export const paginated = <T,>(items: T[], over: Partial<Paginated<T>> = {}): Paginated<T> => ({
  items,
  page: 1,
  limit: 15,
  total: items.length,
  total_pages: items.length ? 1 : 0,
  ...over,
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);
export const noContent = () => new Response(null, { status: 204 });

/**
 * Replaces global fetch with a router keyed by `"METHOD /path"` (path without
 * the `/api/v1` prefix). Unmocked routes return a loud 500 so a test never
 * passes by accident against a request nobody declared.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { key: string; url: URL; init?: RequestInit; body?: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const key = `${init?.method ?? "GET"} ${url.pathname.replace("/api/v1", "")}`;
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ key, url, init, body });
    const handler = routes[key];
    if (!handler) return apiError(500, "UNMOCKED", `no mock for ${key}`);
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    fn,
    /** All request bodies sent to a route, in order. */
    bodiesFor: (key: string) => calls.filter((c) => c.key === key).map((c) => c.body),
    countFor: (key: string) => calls.filter((c) => c.key === key).length,
  };
}

/** The routes nearly every page needs: session restore, languages, limits. */
export function baseRoutes(
  opts: { user?: typeof USER | typeof ADMIN; anonymous?: boolean } = {},
): Record<string, Handler> {
  const user = opts.user ?? USER;
  return {
    "POST /auth/refresh": () =>
      opts.anonymous
        ? apiError(401, "UNAUTHORIZED", "no session")
        : json(authResponse({ user })),
    "GET /languages": () => json(LANGUAGES),
    "GET /limits": () => json(LIMITS),
  };
}

export function renderWithProviders(ui: ReactElement | null, route = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui ?? <App />}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export function renderApp(route = "/", opts: { refreshToken?: string } = {}) {
  clearSession();
  if (opts.refreshToken) localStorage.setItem("codearena.refresh_token", opts.refreshToken);
  return renderWithProviders(null, route);
}

/** Renders the app with a restored session for `user`. */
export function renderSignedIn(route: string, user: typeof USER | typeof ADMIN = USER) {
  return renderApp(route, { refreshToken: `refresh-for-${user.username}` });
}
