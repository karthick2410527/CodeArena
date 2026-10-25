import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContestDetail, ContestSummary, StandingsView } from "../api/types";
import {
  adminProblem,
  apiError,
  baseRoutes,
  detail,
  json,
  list,
  mockApi,
  paginated,
  renderApp,
  renderSignedIn,
  stats,
  submission,
  summary,
} from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const contest = (over: Partial<ContestSummary> = {}): ContestSummary => ({
  slug: "round-1",
  title: "Round 1",
  format: "ICPC",
  starts_at: iso(2 * HOUR),
  ends_at: iso(4 * HOUR),
  duration_minutes: 120,
  phase: "UPCOMING",
  published: true,
  authors: ["host", "cohost"],
  problem_count: 2,
  participants: 7,
  registered: false,
  my_role: null,
  ...over,
});

const running = (over: Partial<ContestSummary> = {}) =>
  contest({ phase: "RUNNING", starts_at: iso(-HOUR), ends_at: iso(HOUR), registered: true, ...over });

const contestDetail = (c: ContestSummary, over: Partial<ContestDetail> = {}): ContestDetail => ({
  contest: c,
  description: "Two problems, two hours.",
  problems:
    c.phase === "UPCOMING" && !c.my_role
      ? []
      : [
          { label: "A", slug: "sum", title: "Sum", points: 1, solved_by: 5, my_status: "SOLVED" },
          { label: "B", slug: "paths", title: "Paths", points: 1, solved_by: 1, my_status: null },
        ],
  problems_visible: c.phase !== "UPCOMING" || c.my_role !== null,
  editorial_available: false,
  server_time: new Date().toISOString(),
  ...over,
});

const standings: StandingsView = {
  format: "ICPC",
  phase: "RUNNING",
  problems: [
    { label: "A", points: 1 },
    { label: "B", points: 1 },
  ],
  rows: [
    {
      rank: 1,
      participant: { user_id: "u1", username: "zoe", display_name: null, avatar_url: null },
      score: 2,
      penalty: 95,
      solved: 2,
      cells: [
        { label: "A", solved: true, wrong: 1, pending: 0, solved_at: 600, score: null, first_solve: true },
        { label: "B", solved: true, wrong: 0, pending: 0, solved_at: 3900, score: null, first_solve: true },
      ],
    },
    {
      rank: 2,
      participant: { user_id: "u2", username: "ada", display_name: null, avatar_url: null },
      score: 1,
      penalty: 12,
      solved: 1,
      cells: [
        { label: "A", solved: true, wrong: 0, pending: 0, solved_at: 720, score: null, first_solve: false },
        { label: "B", solved: false, wrong: 2, pending: 1, solved_at: null, score: null, first_solve: false },
      ],
    },
  ],
  generated_at: new Date().toISOString(),
};

describe("the contests page", () => {
  it("lists live and upcoming rounds and registers in one click", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "GET /contests": (url) => {
        const phase = url.searchParams.get("phase");
        if (phase === "running") return json(paginated([running({ slug: "live", title: "Live Round" })]));
        if (phase === "upcoming") return json(paginated([contest()]));
        return json(paginated([]));
      },
      "POST /contests/round-1/registration": () => json(contestDetail(contest({ registered: true }))),
    });
    renderSignedIn("/contests");

    const live = await screen.findByRole("region", { name: "Live now" });
    expect(within(live).getByRole("link", { name: "Live Round" })).toHaveAttribute("href", "/contests/live");
    expect(within(live).getByText(/ends in/i)).toBeInTheDocument();
    const upcoming = screen.getByRole("region", { name: "Upcoming" });
    expect(within(upcoming).getByText(/starts in/i)).toBeInTheDocument();
    expect(within(upcoming).getByText("ICPC rules")).toBeInTheDocument();
    expect(within(upcoming).getByText("2 h")).toBeInTheDocument();
    await userEvent.click(within(upcoming).getByRole("button", { name: "Register" }));
    await waitFor(() => expect(api.countFor("POST /contests/round-1/registration")).toBe(1));
    for (const link of within(screen.getByRole("main")).queryAllByRole("link", { name: /host a contest/i })) {
      expect(link).toHaveAttribute("href", "/contests/new");
    }
    // Your own rounds are listed apart, so the general list leaves them out.
    const upcomingCall = api.calls.find((c) => c.key === "GET /contests" && c.url.searchParams.get("phase") === "upcoming");
    expect(upcomingCall?.url.searchParams.get("exclude")).toBe("hosted,registered");
    expect(screen.getByRole("region", { name: "Registered" })).toBeInTheDocument();
    // Hosting has its own section, so the Contests page doesn't offer it.
    expect(screen.queryByRole("region", { name: "Hosting" })).not.toBeInTheDocument();
  });

  it("shows the rounds you registered for apart from the rest", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /contests/joined": () =>
        json([{ contest: contest({ slug: "mine-reg", title: "Signed Up Round", registered: true }), rank: null, ranked: 0, solved: 0, score: 0 }]),
    });
    renderSignedIn("/contests");
    const reg = await screen.findByRole("region", { name: "Registered" });
    expect(await within(reg).findByRole("link", { name: "Signed Up Round" })).toHaveAttribute("href", "/contests/mine-reg");
  });
});

describe("the Host section", () => {
  it("is its own item in the top bar, current on every hosting page", async () => {
    mockApi({ ...baseRoutes(), "GET /studio/problems": () => json(paginated([])) });
    renderSignedIn("/host");
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Host" })).toHaveAttribute("aria-current", "page");
    expect(within(primary).getByRole("link", { name: /contests/i })).not.toHaveAttribute("aria-current");
    expect(await screen.findByRole("heading", { level: 1, name: /run your own rounds/i })).toBeInTheDocument();
    const tabs = screen.getByRole("navigation", { name: "Host pages" });
    expect(within(tabs).getByRole("link", { name: /problems/i })).toHaveAttribute("href", "/studio/problems");
    expect(screen.getByRole("heading", { name: /your problems/i })).toBeInTheDocument();
  });

  it("counts the contest wizard as hosting, not competing", async () => {
    mockApi(baseRoutes());
    renderSignedIn("/contests/new");
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(within(primary).getByRole("link", { name: "Host" })).toHaveAttribute("aria-current", "page"));
    expect(within(primary).getByRole("link", { name: /contests/i })).not.toHaveAttribute("aria-current");
  });
});

describe("a contest", () => {
  it("keeps its problems hidden until the start and counts down to it", async () => {
    mockApi({ ...baseRoutes(), "GET /contests/round-1": () => json(contestDetail(contest({ registered: true }))) });
    renderSignedIn("/contests/round-1");
    expect(await screen.findByRole("heading", { level: 1, name: "Round 1" })).toBeInTheDocument();
    expect(screen.getByText(/the problems appear when the contest starts/i)).toBeInTheDocument();
    expect(screen.getAllByText(/starts in/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /registered ✓ · withdraw/i })).toBeInTheDocument();
  });

  it("shows the problems and a live ICPC scoreboard while it runs", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(contestDetail(running())),
      "GET /contests/round-1/standings": () => json(standings),
    });
    renderSignedIn("/contests/round-1");
    const problems = await screen.findByRole("list", { name: "Contest problems" });
    expect(within(problems).getByRole("link", { name: /Sum/ })).toHaveAttribute("href", "/contests/round-1/problems/A");
    expect(within(problems).getByLabelText("Solved")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Standings" }));
    const table = await screen.findByRole("table", { name: "Standings" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("zoe");
    expect(rows[1]).toHaveTextContent("+1");
    expect(rows[1]).toHaveTextContent("0:10");
    // ada is the viewer: her row is marked, and her pending try shows as "?".
    expect(rows[2]).toHaveAttribute("aria-current", "true");
    expect(within(rows[2]).getByTitle("Being judged")).toHaveTextContent("?");
  });

  it("submits from the arena through the contest", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(contestDetail(running())),
      "GET /contests/round-1/problems/A": () =>
        json({ label: "A", points: 1, problem: detail({ slug: "sum", title: "Sum" }) }),
      "POST /contests/round-1/submissions": () => json({ submission_id: "sub-1", status: "QUEUED", in_contest: true }, 202),
      "GET /submissions/sub-1": () => json(submission({ status: "ACCEPTED", verdict: "ACCEPTED" })),
    });
    renderSignedIn("/contests/round-1/problems/A");
    expect(await screen.findByRole("heading", { level: 1, name: /A\.\s*Sum/ })).toBeInTheDocument();
    const chips = screen.getByRole("group", { name: "Problems" });
    expect(within(chips).getByRole("link", { name: "A" })).toHaveAttribute("aria-current", "page");
    expect(within(chips).getByRole("link", { name: "A" })).toHaveAttribute("title", "A. Sum (solved)");

    const submit = await screen.findByRole("button", { name: "Submit to contest" });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    expect(await screen.findByText("5 / 5 tests passed", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(api.bodiesFor("POST /contests/round-1/submissions")[0]).toMatchObject({ label: "A", language: "cpp17" });
    expect(api.countFor("POST /submissions")).toBe(0);
  });
});

describe("after a reload", () => {
  it("asks for a contest only once the session is back, so it never caches an anonymous view", async () => {
    const api = mockApi({ ...baseRoutes(), "GET /contests/round-1": () => json(contestDetail(running())) });
    renderSignedIn("/contests/round-1");
    expect(await screen.findByText("Registered ✓")).toBeInTheDocument();
    const asks = api.calls.filter((c) => c.key === "GET /contests/round-1");
    expect(asks.length).toBeGreaterThan(0);
    for (const c of asks) {
      expect((c.init?.headers as Record<string, string>)?.Authorization).toMatch(/^Bearer /);
    }
  });
});

describe("hosting", () => {
  it("creates a draft with the chosen schedule and format", async () => {
    const created = contest({ published: false, my_role: "OWNER", slug: "my-round" });
    const api = mockApi({
      ...baseRoutes(),
      "POST /contests": () => json(contestDetail(created), 201),
      "GET /contests/my-round": () => json(contestDetail(created)),
      "GET /studio/problems": () => json(paginated([])),
    });
    renderSignedIn("/contests/new");
    // One step at a time: a title is needed before moving on.
    await userEvent.click(await screen.findByRole("button", { name: /continue/i }));
    expect(screen.getByText("Give the contest a title.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Title"), "My Round");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.click(screen.getByRole("radio", { name: "ICPC rules" }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.click(screen.getByRole("radio", { name: "3 h" }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    const review = screen.getByRole("heading", { name: "Check and create" }).closest("form")!;
    expect(review).toHaveTextContent("My Round");
    expect(review).toHaveTextContent("ICPC rules");
    expect(within(screen.getByRole("complementary", { name: "Preview" })).getByText("My Round")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create draft" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Round 1" })).toBeInTheDocument();
    const body = api.bodiesFor("POST /contests")[0] as Record<string, unknown>;
    expect(body).toMatchObject({ title: "My Round", format: "ICPC", duration_minutes: 180 });
    expect(new Date(body.starts_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(screen.getByText(/draft: only its authors can see it/i)).toBeInTheDocument();
  });

  it("adds one of your problems and reports why publishing is refused", async () => {
    const draft = contest({ published: false, my_role: "OWNER", problem_count: 0 });
    const api = mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(contestDetail(draft, { problems: [] })),
      "GET /studio/problems": () =>
        json(paginated([adminProblem({ id: "p-1", slug: "sum", title: "Sum", published: false })])),
      "PUT /contests/round-1/problems": () =>
        json(contestDetail(draft, { problems: [{ label: "A", slug: "sum", title: "Sum", points: 1, solved_by: 0, my_status: null }] })),
      "POST /contests/round-1/publish": () => apiError(400, "BAD_REQUEST", "problem A has no test cases yet, so it could not be judged"),
    });
    renderSignedIn("/contests/round-1/manage");

    await userEvent.click(await screen.findByRole("tab", { name: /problems/i }));
    await userEvent.selectOptions(await screen.findByLabelText("Add a problem"), "p-1");
    await userEvent.click(screen.getByRole("button", { name: "Save problems" }));
    await waitFor(() => expect(api.bodiesFor("PUT /contests/round-1/problems")).toEqual([[{ problem_id: "p-1" }]]));

    await userEvent.click(screen.getByRole("tab", { name: /overview/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Publish contest" }));
    expect(await screen.findByText(/problem A has no test cases yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /authors/i }));
    expect(screen.getByRole("button", { name: /add author/i })).toBeInTheDocument();
  });
});

describe("the problems dashboard", () => {
  it("shows your progress and each problem's status and figures", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /problems": () =>
        json(
          list([
            summary(1, { title: "Solved one", status: "SOLVED", solved_by: 12, acceptance_rate: 61.5 }),
            summary(2, { title: "Tried one", status: "ATTEMPTED", author: "zoe" }),
          ]),
        ),
      "GET /tags": () => json([{ name: "math", count: 2 }]),
      "GET /users/me/stats": () => json(stats()),
    });
    renderSignedIn("/problems");
    const listEl = await screen.findByRole("list", { name: /problem list/i });
    const items = within(listEl).getAllByRole("listitem");
    expect(within(items[0]).getByText("Solved")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("61.5%");
    expect(items[0]).toHaveTextContent("12");
    expect(within(items[1]).getByText("Attempted")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("by zoe");
    expect(await screen.findByRole("region", { name: "Your progress" })).toHaveTextContent(/2\s*\/\s*10/);
    expect(screen.getByLabelText("Filter by your progress")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /math/ })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("themes", () => {
  it("offers three light themes, green among them, and two dark ones, and applies the choice", async () => {
    mockApi({ ...baseRoutes(), "GET /problems": () => json(list([])), "GET /tags": () => json([]), "GET /users/me/stats": () => json(stats()) });
    renderSignedIn("/problems");
    await userEvent.click(await screen.findByRole("button", { name: "Theme" }));
    const group = screen.getByRole("radiogroup", { name: "Colour theme" });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual([
      "Light",
      "Sand",
      "Emerald",
      "Dark",
      "Midnight",
    ]);
    await userEvent.click(within(group).getByRole("radio", { name: "Emerald" }));
    expect(document.documentElement.dataset.theme).toBe("emerald");
    expect(within(group).getByRole("radio", { name: "Emerald" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(group).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("signed out", () => {
  it("can browse contests but is asked to sign in to register", async () => {
    mockApi({
      ...baseRoutes({ anonymous: true }),
      "GET /contests": (url) => json(paginated(url.searchParams.get("phase") === "upcoming" ? [contest()] : [])),
    });
    renderApp("/contests");
    expect(await screen.findByRole("link", { name: /sign in to register/i })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("link", { name: /host a contest/i })).not.toBeInTheDocument();
  });
});

describe("joined contests", () => {
  it("lists what is coming up apart from past results with your place", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /contests/joined": () =>
        json([
          { contest: contest({ title: "Next Round", slug: "next", registered: true }), rank: null, ranked: 0, solved: 0, score: 0 },
          {
            contest: contest({ title: "Old Round", slug: "old", phase: "ENDED", starts_at: iso(-5 * HOUR), ends_at: iso(-3 * HOUR) }),
            rank: 2,
            ranked: 40,
            solved: 3,
            score: 3,
          },
        ]),
    });
    renderSignedIn("/contests/joined");
    const ahead = await screen.findByRole("list", { name: "Live and upcoming" });
    expect(within(ahead).getByRole("link", { name: /Next Round/ })).toHaveAttribute("href", "/contests/next");
    expect(ahead).toHaveTextContent(/starts in/i);
    const results = screen.getByRole("list", { name: "Results" });
    expect(within(results).getByRole("link", { name: "Old Round" })).toHaveAttribute("href", "/contests/old/standings");
    expect(results).toHaveTextContent("#2 of 40 · top 5%");
  });
});

describe("community problems", () => {
  it("can't be published from the studio: they go public through a contest", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    mockApi({
      ...baseRoutes(),
      [`GET /studio/problems/${id}`]: () => json(adminProblem({ published: false })),
      [`GET /studio/problems/${id}/test-cases`]: () => json([]),
    });
    renderSignedIn(`/studio/problems/${id}`);
    expect(await screen.findByText(/problems go public through contests/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Host a contest" })).toHaveAttribute("href", "/contests/new");
  });
});
