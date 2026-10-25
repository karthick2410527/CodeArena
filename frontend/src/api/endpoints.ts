import { apiBase, request } from "./client";
import type {
  AdminProblem,
  AdminTestCase,
  AuthResponse,
  ContestDetail,
  ContestEditorial,
  BillingMe,
  BillingOrder,
  BillingPlans,
  ContestInput,
  ImportedEditorial,
  ImportedProblem,
  ContestProblemView,
  ContestSubmission,
  ContestSummary,
  JoinedContest,
  PersonHit,
  Profile,
  StandingsView,
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
  Replay,
  ReplayStepPage,
  Run,
  Submission,
  SubmissionFilters,
  SubmissionSummary,
  TagCount,
  TestCaseInput,
  TestResults,
  User,
  AuthProvider,
  Identity,
  UserStats,
  WorkersReport,
} from "./types";

export const authApi = {
  register: (body: { username: string; email: string; password: string; display_name?: string }) =>
    request<AuthResponse>("/auth/register", { method: "POST", body, auth: false }),
  login: (body: { email: string; password: string }) =>
    request<AuthResponse>("/auth/login", { method: "POST", body, auth: false }),
  logout: (refresh_token: string) =>
    request<void>("/auth/logout", { method: "POST", body: { refresh_token }, auth: false }),
  me: () => request<User>("/users/me"),
  /** Changes the name shown on your profile and in standings; blank shows the username. */
  updateMe: (body: { display_name: string }) => request<User>("/users/me", { method: "PATCH", body }),
  stats: () => request<UserStats>("/users/me/stats"),

  providers: () => request<AuthProvider[]>("/auth/providers", { auth: false }),
  /** Trades the one-time code from /auth/callback for a session; the browser's cookie must match. */
  exchange: (code: string) =>
    request<AuthResponse>("/auth/oauth/exchange", { method: "POST", body: { code }, auth: false }),
  linkIntent: (provider: string) =>
    request<{ authorize_url: string }>("/auth/oauth/link-intent", { method: "POST", body: { provider } }),
  identities: () => request<Identity[]>("/users/me/identities"),
  unlink: (provider: string) =>
    request<void>(`/users/me/identities/${encodeURIComponent(provider)}`, { method: "DELETE" }),
};

export const problemsApi = {
  list: (f: ProblemFilters, signal?: AbortSignal) =>
    request<ProblemList>("/problems", {
      query: { page: f.page, limit: f.limit, difficulty: f.difficulty, tag: f.tag, q: f.q, status: f.status, sort: f.sort },
      signal,
    }),
  get: (slug: string, signal?: AbortSignal) =>
    request<ProblemDetail>(`/problems/${encodeURIComponent(slug)}`, { signal }),
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

export const billingApi = {
  plans: () => request<BillingPlans>("/billing/plans", { auth: false }),
  me: () => request<BillingMe>("/billing/me"),
  createOrder: (plan: string) => request<BillingOrder>("/billing/orders", { method: "POST", body: { plan } }),
  /** Pays a test order (test mode only): no money moves. */
  testPay: (orderId: string) => request<BillingMe>("/billing/test-pay", { method: "POST", body: { order_id: orderId } }),
  /** Checkout's signed success result; the server checks the signature before granting anything. */
  verify: (body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
    request<BillingMe>("/billing/verify", { method: "POST", body }),
};

export const replaysApi = {
  /** Queues a recording of the program for step-by-step replay (C++ only). */
  create: (body: { problem_id?: string; language: string; source_code: string; stdin: string }) =>
    request<{ replay_id: string; status: string }>("/replays", { method: "POST", body }),
  /** Long-polls like runs: the server holds the response until it is recorded or `waitMs` passes. */
  get: (id: string, waitMs?: number, signal?: AbortSignal) =>
    request<Replay>(`/replays/${encodeURIComponent(id)}`, { query: { wait_ms: waitMs }, signal }),
  steps: (id: string, from: number, count: number, signal?: AbortSignal) =>
    request<ReplayStepPage>(`/replays/${encodeURIComponent(id)}/steps`, { query: { from, count }, signal }),
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

/**
 * Problem authoring. The same API is served at /admin (every problem, for
 * admins) and /studio (the caller's own problems and their contests').
 */
function problemAuthoring(base: "/admin" | "/studio") {
  return {
    listProblems: (params: { page: number; limit: number; published?: boolean; q?: string }) =>
      request<Paginated<AdminProblem>>(`${base}/problems`, {
        query: {
          page: params.page,
          limit: params.limit,
          published: params.published === undefined ? undefined : String(params.published),
          q: params.q,
        },
      }),
    getProblem: (id: string, signal?: AbortSignal) =>
      request<AdminProblem>(`${base}/problems/${encodeURIComponent(id)}`, { signal }),
    createProblem: (body: ProblemInput) => request<AdminProblem>(`${base}/problems`, { method: "POST", body }),
    updateProblem: (id: string, body: Partial<ProblemInput>) =>
      request<AdminProblem>(`${base}/problems/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    deleteProblem: (id: string) =>
      request<void>(`${base}/problems/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listTestCases: (problemId: string, signal?: AbortSignal) =>
      request<AdminTestCase[]>(`${base}/problems/${encodeURIComponent(problemId)}/test-cases`, { signal }),
    createTestCase: (problemId: string, body: TestCaseInput) =>
      request<AdminTestCase>(`${base}/problems/${encodeURIComponent(problemId)}/test-cases`, {
        method: "POST",
        body,
      }),
    updateTestCase: (id: string, body: TestCaseInput) =>
      request<AdminTestCase>(`${base}/test-cases/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    deleteTestCase: (id: string) =>
      request<void>(`${base}/test-cases/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** Reads a Codeforces or AtCoder problem link to prefill the editor; saves nothing. */
    importProblem: (url: string) =>
      request<ImportedProblem>(`${base}/problems/import`, { method: "POST", body: { url } }),
    /** The editorial of a Codeforces or AtCoder problem (by its link); saves nothing. */
    importEditorial: (url: string) =>
      request<ImportedEditorial>(`${base}/problems/import-editorial`, { method: "POST", body: { url } }),
  };
}

export type ProblemAuthoringApi = ReturnType<typeof problemAuthoring>;

export const studioApi = problemAuthoring("/studio");

export const adminApi = {
  ...problemAuthoring("/admin"),
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

const c = (slug: string) => `/contests/${encodeURIComponent(slug)}`;

export const contestsApi = {
  /** @param exclude leave out your own rounds: "hosted", "registered" or both, comma separated */
  list: (phase: "upcoming" | "running" | "past" | undefined, page = 1, limit = 20, q?: string, exclude?: string) =>
    request<Paginated<ContestSummary>>("/contests", { query: { phase, page, limit, q, exclude } }),
  mine: () => request<ContestSummary[]>("/contests/mine"),
  joined: () => request<JoinedContest[]>("/contests/joined"),
  get: (slug: string, signal?: AbortSignal) => request<ContestDetail>(c(slug), { signal }),
  create: (body: ContestInput) => request<ContestDetail>("/contests", { method: "POST", body }),
  update: (slug: string, body: ContestInput) => request<ContestDetail>(c(slug), { method: "PATCH", body }),
  remove: (slug: string) => request<void>(c(slug), { method: "DELETE" }),
  publish: (slug: string, published: boolean) =>
    request<ContestDetail>(`${c(slug)}/publish`, { method: "POST", body: { published } }),
  addAuthor: (slug: string, username: string) =>
    request<ContestDetail>(`${c(slug)}/authors`, { method: "POST", body: { username } }),
  removeAuthor: (slug: string, username: string) =>
    request<void>(`${c(slug)}/authors/${encodeURIComponent(username)}`, { method: "DELETE" }),
  setProblems: (slug: string, problems: { problem_id: string; points?: number }[]) =>
    request<ContestDetail>(`${c(slug)}/problems`, { method: "PUT", body: problems }),
  register: (slug: string) => request<ContestDetail>(`${c(slug)}/registration`, { method: "POST" }),
  unregister: (slug: string) => request<ContestDetail>(`${c(slug)}/registration`, { method: "DELETE" }),
  problem: (slug: string, label: string, signal?: AbortSignal) =>
    request<ContestProblemView>(`${c(slug)}/problems/${encodeURIComponent(label)}`, { signal }),
  submit: (slug: string, body: { label: string; language: string; source_code: string }) =>
    request<{ submission_id: string; status: string; in_contest: boolean }>(`${c(slug)}/submissions`, {
      method: "POST",
      body,
    }),
  mySubmissions: (slug: string, signal?: AbortSignal) =>
    request<ContestSubmission[]>(`${c(slug)}/submissions`, { signal }),
  standings: (slug: string, signal?: AbortSignal) => request<StandingsView>(`${c(slug)}/standings`, { signal }),
  editorial: (slug: string) => request<ContestEditorial>(`${c(slug)}/editorial`),
  saveEditorial: (slug: string, body: { intro?: string; problems?: Record<string, string> }) =>
    request<ContestEditorial>(`${c(slug)}/editorial`, { method: "PUT", body }),
  /** Server-Sent Events: "standings" whenever a verdict in this contest changes. */
  liveUrl: (slug: string) => `${apiBase()}${c(slug)}/live`,
};

export const profilesApi = {
  get: (username: string, signal?: AbortSignal) =>
    request<Profile>(`/profiles/${encodeURIComponent(username)}`, { signal }),
  search: (q: string, limit = 10, signal?: AbortSignal) =>
    request<PersonHit[]>("/profiles", { query: { q, limit }, signal }),
};
