import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContestDetail, ImportedProblem } from "../api/types";
import { USER, adminProblem, apiError, baseRoutes, json, mockApi, paginated, renderSignedIn } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const imported: ImportedProblem = {
  platform: "codeforces",
  source_id: "1999A",
  source_url: "https://codeforces.com/problemset/problem/1999/A",
  slug: "twin-piles",
  title: "Twin Piles",
  description: "You have $n$ stones.\n\n## Input\n\nOne integer $n$.",
  constraints: "",
  difficulty: "EASY",
  time_limit_ms: 2000,
  memory_limit_mb: 256,
  tags: ["brute-force", "math"],
  samples: [{ input: "8\n", output: "YES\n" }],
  warnings: [],
};

const NEW_ID = "44444444-4444-4444-4444-444444444444";

describe("importing a problem", () => {
  it("fills the editor from a Codeforces link and creates it with its samples", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "POST /studio/problems/import": () => json(imported),
      "POST /studio/problems": () => json(adminProblem({ id: NEW_ID, slug: "twin-piles", title: "Twin Piles" }), 201),
      [`POST /studio/problems/${NEW_ID}/test-cases`]: () => json({ id: "t1", position: 1, input: "8\n", expected_output: "YES\n", explanation: null, is_sample: true, points: 0 }, 201),
      [`GET /studio/problems/${NEW_ID}`]: () => json(adminProblem({ id: NEW_ID, slug: "twin-piles", title: "Twin Piles" })),
      [`GET /studio/problems/${NEW_ID}/test-cases`]: () => json([]),
    });
    renderSignedIn("/studio/problems/new");
    await userEvent.type(await screen.findByLabelText("Problem link"), imported.source_url);
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText(/imported “twin piles”/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Twin Piles");
    expect(screen.getByLabelText("Slug (URL)")).toHaveValue("twin-piles");
    expect(screen.getByLabelText("Time limit (ms)")).toHaveValue(2000);
    expect(screen.getByLabelText("Tags (comma separated)")).toHaveValue("brute-force, math");
    expect(screen.getByLabelText("Statement (Markdown)")).toHaveValue(imported.description);
    expect(screen.getByLabelText("Sample 1 input")).toHaveValue("8\n");
    expect(screen.getByText(/belongs to its original authors/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create problem" }));
    await waitFor(() => expect(api.bodiesFor(`POST /studio/problems/${NEW_ID}/test-cases`)).toHaveLength(1));
    expect(api.bodiesFor("POST /studio/problems")[0]).toMatchObject({
      slug: "twin-piles",
      time_limit_ms: 2000,
      source_url: imported.source_url,
    });
    expect(api.bodiesFor(`POST /studio/problems/${NEW_ID}/test-cases`)[0]).toMatchObject({
      input: "8\n",
      expected_output: "YES\n",
      is_sample: true,
    });
  });

  it("shows why a link could not be imported", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /studio/problems/import": () => apiError(400, "BAD_REQUEST", "only Codeforces and AtCoder links can be imported"),
    });
    renderSignedIn("/studio/problems/new");
    await userEvent.type(await screen.findByLabelText("Problem link"), "https://example.com/p/1");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/only codeforces and atcoder/i)).toBeInTheDocument();
  });

  it("suggests the slug from the title until you type one", async () => {
    mockApi(baseRoutes());
    renderSignedIn("/studio/problems/new");
    await userEvent.type(await screen.findByLabelText("Title"), "Two Sum, Again!");
    expect(screen.getByLabelText("Slug (URL)")).toHaveValue("two-sum-again");
  });
});

describe("a problem written for a contest", () => {
  it("goes back to the contest and is added to it", async () => {
    const draft: ContestDetail = {
      contest: {
        slug: "round-1",
        title: "Round 1",
        format: "ICPC",
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        duration_minutes: 120,
        phase: "UPCOMING",
        published: false,
        authors: ["ada"],
        problem_count: 0,
        participants: 0,
        registered: false,
        my_role: "OWNER",
      },
      description: "",
      problems: [],
      problems_visible: true,
      editorial_available: false,
      server_time: new Date().toISOString(),
    };
    const api = mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(draft),
      "GET /studio/problems": () => json(paginated([adminProblem({ id: NEW_ID, slug: "twin-piles", title: "Twin Piles", hidden_count: 0 })])),
      "GET /contests/round-1/editorial": () => json({ intro: "", problems: [], is_public: false }),
      "PUT /contests/round-1/problems": () =>
        json({ ...draft, problems: [{ label: "A", slug: "twin-piles", title: "Twin Piles", points: 1, solved_by: 0, my_status: null }] }),
    });
    renderSignedIn(`/contests/round-1/manage?add=${NEW_ID}`);
    expect(await screen.findByText(/“twin piles” was added to the contest/i)).toBeInTheDocument();
    expect(api.bodiesFor("PUT /contests/round-1/problems")).toEqual([[{ problem_id: NEW_ID }]]);
    const problems = screen.getByRole("region", { name: "Problems" });
    expect(within(problems).getByText("needs hidden tests")).toBeInTheDocument();
    expect(within(problems).getByRole("link", { name: /^write$/i })).toHaveAttribute(
      "href",
      "/studio/problems/new?contest=round-1",
    );
  });
});

describe("editorials from the source judge", () => {
  it("imports a problem's editorial into the contest editorial, with credit", async () => {
    const d: ContestDetail = {
      contest: {
        slug: "round-1",
        title: "Round 1",
        format: "ICPC",
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        duration_minutes: 120,
        phase: "UPCOMING",
        published: false,
        authors: ["ada"],
        problem_count: 1,
        participants: 0,
        registered: false,
        my_role: "OWNER",
      },
      description: "",
      problems: [{ label: "A", slug: "twin-piles", title: "Twin Piles", points: 1, solved_by: 0, my_status: null }],
      problems_visible: true,
      editorial_available: false,
      server_time: new Date().toISOString(),
    };
    const api = mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(d),
      "GET /studio/problems": () =>
        json(paginated([adminProblem({ id: NEW_ID, slug: "twin-piles", title: "Twin Piles", source_url: imported.source_url })])),
      "GET /contests/round-1/editorial": () =>
        json({ intro: "", problems: [{ label: "A", slug: "twin-piles", title: "Twin Piles", editorial: "" }], is_public: false }),
      "POST /studio/problems/import-editorial": () =>
        json({ text: "Split $n$ in half.", editorial_url: "https://codeforces.com/blog/entry/222", warnings: [] }),
    });
    renderSignedIn("/contests/round-1/manage?tab=editorial");
    await userEvent.click(await screen.findByRole("button", { name: /import from codeforces 1999a/i }));
    await waitFor(() =>
      expect(screen.getByLabelText("A. Twin Piles")).toHaveValue(
        "Split $n$ in half.\n\n*Based on the [original editorial](https://codeforces.com/blog/entry/222).*",
      ),
    );
    expect(api.bodiesFor("POST /studio/problems/import-editorial")).toEqual([{ url: imported.source_url }]);
  });
});

describe("your name", () => {
  it("is shown in the top bar and can be changed in your account", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "GET /users/me": () => json({ ...USER, display_name: "Ada Lovelace" }),
      "PATCH /users/me": () => json({ ...USER, display_name: "Ada King" }),
    });
    renderSignedIn("/profile");
    const name = await screen.findByLabelText("Name");
    await waitFor(() => expect(name).toHaveValue("Ada Lovelace"));
    await userEvent.clear(name);
    await userEvent.type(name, "Ada King");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(api.bodiesFor("PATCH /users/me")).toEqual([{ display_name: "Ada King" }]);
  });
});
