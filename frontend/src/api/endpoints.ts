import { request } from "./client";
import type {
  AdminProblem,
  AdminTestCase,
  AuthResponse,
  CreateRunResponse,
  CreateSubmissionResponse,
  DeadLetter,
  ExecutionLimits,
  Language,
  Paginated,
  ProblemDetail,
  ProblemFilters,
  ProblemInput,
  ProblemList,
  Run,
  Submission,
  SubmissionFilters,
  SubmissionSummary,
  TagCount,
  TestCaseInput,
  TestResults,
  User,
  UserStats,
  WorkersReport,
} from "./types";

export const authApi = {
  register: (body: { username: string; email: string; password: string }) =>
    request<AuthResponse>("/auth/register", { method: "POST", body, auth: false }),
  login: (body: { email: string; password: string }) =>
    request<AuthResponse>("/auth/login", { method: "POST", body, auth: false }),
  logout: (refresh_token: string) =>
    request<void>("/auth/logout", { method: "POST", body: { refresh_token }, auth: false }),
  me: () => request<User>("/users/me"),
  stats: () => request<UserStats>("/users/me/stats"),
};

export const problemsApi = {
  list: (f: ProblemFilters, signal?: AbortSignal) =>
    request<ProblemList>("/problems", {
      query: { page: f.page, limit: f.limit, difficulty: f.difficulty, tag: f.tag, q: f.q },
      auth: false,
      signal,
    }),
  get: (slug: string, signal?: AbortSignal) =>
    request<ProblemDetail>(`/problems/${encodeURIComponent(slug)}`, { auth: false, signal }),
  tags: () => request<TagCount[]>("/tags", { auth: false }),
};

export const metaApi = {
  languages: () => request<Language[]>("/languages", { auth: false }),
  limits: () => request<ExecutionLimits>("/limits", { auth: false }),
};

export const runsApi = {
  create: (body: {
    problem_id: string;
    language: string;
    source_code: string;
    mode?: "samples" | "custom";
    stdin?: string;
  }) => request<CreateRunResponse>("/runs", { method: "POST", body }),
  /**
   * Fetches a run. `waitMs` asks the server to hold the response until the run
   * reaches a terminal state, so the editor's Run button feels immediate
   * without the client polling in a tight loop.
   */
  get: (runId: string, waitMs?: number, signal?: AbortSignal) =>
    request<Run>(`/runs/${encodeURIComponent(runId)}`, {
      query: { wait_ms: waitMs },
      signal,
    }),
};

export const submissionsApi = {
  create: (body: { problem_id: string; language: string; source_code: string }) =>
    request<CreateSubmissionResponse>("/submissions", { method: "POST", body }),
  get: (id: string, signal?: AbortSignal) =>
    request<Submission>(`/submissions/${encodeURIComponent(id)}`, { signal }),
  testResults: (id: string, signal?: AbortSignal) =>
    request<TestResults>(`/submissions/${encodeURIComponent(id)}/test-results`, { signal }),
  list: (f: SubmissionFilters, signal?: AbortSignal) =>
    request<Paginated<SubmissionSummary>>("/submissions", {
      query: {
        page: f.page,
        limit: f.limit,
        problem: f.problem,
        verdict: f.verdict,
        language: f.language,
      },
      signal,
    }),
};

export const adminApi = {
  listProblems: (params: { page: number; limit: number; published?: boolean; q?: string }) =>
    request<Paginated<AdminProblem>>("/admin/problems", {
      query: {
        page: params.page,
        limit: params.limit,
        published: params.published === undefined ? undefined : String(params.published),
        q: params.q,
      },
    }),
  getProblem: (id: string, signal?: AbortSignal) =>
    request<AdminProblem>(`/admin/problems/${encodeURIComponent(id)}`, { signal }),
  createProblem: (body: ProblemInput) =>
    request<AdminProblem>("/admin/problems", { method: "POST", body }),
  updateProblem: (id: string, body: Partial<ProblemInput>) =>
    request<AdminProblem>(`/admin/problems/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }),
  listTestCases: (problemId: string, signal?: AbortSignal) =>
    request<AdminTestCase[]>(`/admin/problems/${encodeURIComponent(problemId)}/test-cases`, {
      signal,
    }),
  createTestCase: (problemId: string, body: TestCaseInput) =>
    request<AdminTestCase>(`/admin/problems/${encodeURIComponent(problemId)}/test-cases`, {
      method: "POST",
      body,
    }),
  updateTestCase: (id: string, body: TestCaseInput) =>
    request<AdminTestCase>(`/admin/test-cases/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }),
  deleteTestCase: (id: string) =>
    request<void>(`/admin/test-cases/${encodeURIComponent(id)}`, { method: "DELETE" }),
  workers: () => request<WorkersReport>("/admin/workers"),
  deadLetters: (params: { page: number; limit: number; include_resolved?: boolean }) =>
    request<Paginated<DeadLetter>>("/admin/dead-letters", {
      query: {
        page: params.page,
        limit: params.limit,
        include_resolved: params.include_resolved ? "true" : undefined,
      },
    }),
  replayDeadLetter: (id: number, note?: string) =>
    request<{ submission_id: string; status: string }>(`/admin/dead-letters/${id}/replay`, {
      method: "POST",
      body: { note },
    }),
};
