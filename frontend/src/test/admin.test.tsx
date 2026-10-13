/**
 * Admin UI: problem CRUD, test-case management with confirmation for
 * destructive changes, and the judge operations console.
 *
 * The API enforces authorisation independently; these tests cover what the UI
 * must not do — offer admin screens to a normal user, or delete something
 * without asking.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ADMIN,
  adminProblem,
  adminTestCase,
  apiError,
  baseRoutes,
  json,
  mockApi,
  noContent,
  paginated,
  renderSignedIn,
  workersReport,
} from "./helpers";

describe("access", () => {
  it("refuses the admin area to a normal user without calling the API", async () => {
    const api = mockApi(baseRoutes());
    renderSignedIn("/admin/problems");

    expect(await screen.findByText("Administrators only")).toBeInTheDocument();
    expect(api.countFor("GET /admin/problems")).toBe(0);
  });

  it("sends an anonymous visitor to log in", async () => {
    mockApi(baseRoutes({ anonymous: true }));
    renderSignedIn("/admin/problems");
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
  });
});

describe("the problem catalogue", () => {
  it("lists drafts alongside published problems with their test counts", async () => {
    mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /admin/problems": () =>
        json(
          paginated([
            adminProblem(),
            adminProblem({
              id: "44444444-4444-4444-4444-444444444444",
              number: 2,
              slug: "draft-one",
              title: "Draft One",
              published: false,
              sample_count: 0,
              hidden_count: 0,
            }),
          ]),
        ),
    });
    renderSignedIn("/admin/problems", ADMIN);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Published")).toBeInTheDocument();
    expect(within(table).getByText("Draft")).toBeInTheDocument();
    expect(within(table).getByText("2 sample / 3 hidden")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "A Plus B" })).toHaveAttribute(
      "href",
      "/admin/problems/22222222-2222-2222-2222-222222222222",
    );
  });

  it("filters by publication state through the API", async () => {
    const api = mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /admin/problems": () => json(paginated([adminProblem()])),
    });
    renderSignedIn("/admin/problems", ADMIN);
    await screen.findByRole("table");

    await userEvent.selectOptions(
      screen.getByLabelText("Filter by publication state"),
      "false",
    );
    await waitFor(() => {
      const last = api.calls.filter((c) => c.key === "GET /admin/problems").at(-1)!;
      expect(last.url.searchParams.get("published")).toBe("false");
    });
  });
});

describe("editing a problem", () => {
  const editRoutes = (overrides: Record<string, () => Response> = {}) => ({
    ...baseRoutes({ user: ADMIN }),
    "GET /admin/problems/22222222-2222-2222-2222-222222222222": () => json(adminProblem()),
    "GET /admin/problems/22222222-2222-2222-2222-222222222222/test-cases": () =>
      json([adminTestCase(), adminTestCase({ id: "hidden-1", position: 2, is_sample: false, points: 1 })]),
    ...overrides,
  });

  it("loads the existing problem into the form", async () => {
    mockApi(editRoutes());
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    expect(await screen.findByLabelText("Title")).toHaveValue("A Plus B");
    expect(screen.getByLabelText("Slug (URL)")).toHaveValue("a-plus-b");
    expect(screen.getByLabelText("Difficulty")).toHaveValue("EASY");
    expect(screen.getByLabelText("Time limit (ms)")).toHaveValue(1000);
    expect(screen.getByLabelText("Tags (comma separated)")).toHaveValue("math");
  });

  it("validates before sending anything to the server", async () => {
    const api = mockApi(editRoutes());
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    const slug = await screen.findByLabelText("Slug (URL)");
    await userEvent.clear(slug);
    await userEvent.type(slug, "Not A Slug");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/correct the highlighted/);
    expect(screen.getByText(/Lowercase letters, digits and single hyphens/)).toBeInTheDocument();
    expect(api.countFor("PATCH /admin/problems/22222222-2222-2222-2222-222222222222")).toBe(0);
  });

  it("rejects a time limit the sandbox would refuse", async () => {
    const api = mockApi(editRoutes());
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    const time = await screen.findByLabelText("Time limit (ms)");
    await userEvent.clear(time);
    await userEvent.type(time, "600000");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Between 100 and 10000 ms")).toBeInTheDocument();
    expect(api.countFor("PATCH /admin/problems/22222222-2222-2222-2222-222222222222")).toBe(0);
  });

  it("saves a valid change and confirms it", async () => {
    const api = mockApi(
      editRoutes({
        "PATCH /admin/problems/22222222-2222-2222-2222-222222222222": () =>
          json(adminProblem({ title: "A Plus B (revised)" })),
      }),
    );
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    const title = await screen.findByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "A Plus B (revised)");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    const [body] = api.bodiesFor(
      "PATCH /admin/problems/22222222-2222-2222-2222-222222222222",
    ) as Array<Record<string, unknown>>;
    expect(body.title).toBe("A Plus B (revised)");
    expect(body.tags).toEqual(["math"]);
  });

  it("relays the server's reason when a save is rejected", async () => {
    mockApi(
      editRoutes({
        "PATCH /admin/problems/22222222-2222-2222-2222-222222222222": () =>
          apiError(409, "CONFLICT", 'slug "a-plus-b" is already in use'),
      }),
    );
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    await screen.findByLabelText("Title");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already in use/);
  });

  it("explains why publishing a draft can fail", async () => {
    mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /admin/problems/22222222-2222-2222-2222-222222222222": () =>
        json(adminProblem({ published: false, sample_count: 0, hidden_count: 0 })),
      "GET /admin/problems/22222222-2222-2222-2222-222222222222/test-cases": () => json([]),
      "PATCH /admin/problems/22222222-2222-2222-2222-222222222222": () =>
        apiError(
          400,
          "BAD_REQUEST",
          "add at least one test case before publishing this problem",
        ),
    });
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    expect(await screen.findByText(/Drafts are invisible to users/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one test case/);
  });
});

describe("test cases", () => {
  const routes = (overrides: Record<string, () => Response> = {}) => ({
    ...baseRoutes({ user: ADMIN }),
    "GET /admin/problems/22222222-2222-2222-2222-222222222222": () => json(adminProblem()),
    "GET /admin/problems/22222222-2222-2222-2222-222222222222/test-cases": () =>
      json([
        adminTestCase(),
        adminTestCase({ id: "hidden-1", position: 2, is_sample: false, points: 1 }),
      ]),
    ...overrides,
  });

  it("marks clearly which cases are public and which are hidden", async () => {
    mockApi(routes());
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    expect(await screen.findByText("Public sample")).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });

  it("adds a hidden case with points, and a sample without", async () => {
    const api = mockApi(
      routes({
        "POST /admin/problems/22222222-2222-2222-2222-222222222222/test-cases": () =>
          json(adminTestCase({ id: "new-1", position: 3 }), 201),
      }),
    );
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    await screen.findByText("Add a test case");
    await userEvent.type(screen.getByLabelText("Input"), "1 2");
    await userEvent.type(screen.getByLabelText("Expected output"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Add test case" }));

    const key = "POST /admin/problems/22222222-2222-2222-2222-222222222222/test-cases";
    await waitFor(() => expect(api.countFor(key)).toBe(1));
    const [hidden] = api.bodiesFor(key) as Array<Record<string, unknown>>;
    expect(hidden).toMatchObject({ input: "1 2", expected_output: "3", is_sample: false, points: 1 });

    // Ticking "public sample" zeroes the points, because samples illustrate
    // rather than score.
    await userEvent.click(screen.getByLabelText("Public sample"));
    expect(screen.getByLabelText("Points")).toHaveValue(0);
  });

  it("refuses to add a case with no expected output", async () => {
    const api = mockApi(routes());
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    await screen.findByText("Add a test case");
    await userEvent.type(screen.getByLabelText("Input"), "1 2");
    await userEvent.click(screen.getByRole("button", { name: "Add test case" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/must not be empty/);
    expect(
      api.countFor("POST /admin/problems/22222222-2222-2222-2222-222222222222/test-cases"),
    ).toBe(0);
  });

  it("asks for confirmation before deleting, and can be cancelled", async () => {
    const api = mockApi(
      routes({ "DELETE /admin/test-cases/hidden-1": () => noContent() }),
    );
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    await screen.findByText("Public sample");
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Test #2 \(hidden\)/)).toBeInTheDocument();

    // Cancelling must not delete anything.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.countFor("DELETE /admin/test-cases/hidden-1")).toBe(0);

    // Confirming does.
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    const again = await screen.findByRole("dialog");
    await userEvent.click(within(again).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.countFor("DELETE /admin/test-cases/hidden-1")).toBe(1));
  });

  it("relays the server's refusal to remove the last hidden test", async () => {
    mockApi(
      routes({
        "DELETE /admin/test-cases/hidden-1": () =>
          apiError(
            409,
            "CONFLICT",
            "a published problem must keep at least one hidden test case; unpublish it first",
          ),
      }),
    );
    renderSignedIn("/admin/problems/22222222-2222-2222-2222-222222222222", ADMIN);

    await screen.findByText("Public sample");
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one hidden test case/);
  });
});

describe("judge operations", () => {
  it("shows worker liveness and queue lag", async () => {
    mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /admin/workers": () => json(workersReport()),
      "GET /admin/dead-letters": () => json(paginated([])),
    });
    renderSignedIn("/admin/ops", ADMIN);

    expect(await screen.findByRole("heading", { name: "Judge operations" })).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("worker-a")).toBeInTheDocument();
    expect(within(table).getByText("Healthy")).toBeInTheDocument();
    expect(within(table).getByText("42")).toBeInTheDocument();
    expect(screen.getByText("oldest 3s")).toBeInTheDocument();
    expect(screen.getByText(/no judge job has exhausted its retries/)).toBeInTheDocument();
  });

  it("flags a stale worker rather than quietly omitting it", async () => {
    mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /admin/workers": () =>
        json(
          workersReport({
            workers: [
              {
                ...workersReport().workers[0],
                worker_id: "worker-dead",
                healthy: false,
                seconds_since_heartbeat: 3600,
                failures: 3,
              },
            ],
          }),
        ),
      "GET /admin/dead-letters": () => json(paginated([])),
    });
    renderSignedIn("/admin/ops", ADMIN);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Stale")).toBeInTheDocument();
    expect(within(table).getByText("3600s ago")).toBeInTheDocument();
  });

  it("warns when no worker has reported at all", async () => {
    mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /admin/workers": () => json(workersReport({ workers: [] })),
      "GET /admin/dead-letters": () => json(paginated([])),
    });
    renderSignedIn("/admin/ops", ADMIN);

    expect(await screen.findByText(/No worker has reported in/)).toBeInTheDocument();
    expect(screen.getByText("codearena-worker")).toBeInTheDocument();
  });

  it("replays a dead-lettered job only after confirmation", async () => {
    const api = mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /admin/workers": () => json(workersReport({ unresolved_dead_letters: 1 })),
      "GET /admin/dead-letters": () =>
        json(
          paginated([
            {
              id: 7,
              submission_id: "aaaaaaaa-0000-0000-0000-000000000000",
              event_type: "submission.created",
              reason: "judge attempts exhausted",
              correlation_id: "trace-1",
              created_at: "2026-01-02T03:04:05Z",
              resolved_at: null,
              resolution: null,
            },
          ]),
        ),
      "POST /admin/dead-letters/7/replay": () =>
        json({ submission_id: "aaaaaaaa-0000-0000-0000-000000000000", status: "QUEUED" }),
    });
    renderSignedIn("/admin/ops", ADMIN);

    expect(await screen.findByText("judge attempts exhausted")).toBeInTheDocument();
    expect(screen.getByText(/trace trace-1/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/fresh attempt budget/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Replay" }));

    await waitFor(() => expect(api.countFor("POST /admin/dead-letters/7/replay")).toBe(1));
    expect(await screen.findByRole("status")).toHaveTextContent(/re-queued/);
  });
});
