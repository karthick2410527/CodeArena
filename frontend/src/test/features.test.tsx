import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContestDetail, ContestSummary } from "../api/types";
import { apiError, baseRoutes, detail, json, list, mockApi, paginated, renderSignedIn, summary } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const HOUR = 3600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const contest = (over: Partial<ContestSummary> = {}): ContestSummary => ({
  slug: "round-1",
  title: "Round 1",
  format: "ICPC",
  starts_at: iso(-3 * HOUR),
  ends_at: iso(-HOUR),
  duration_minutes: 120,
  phase: "ENDED",
  published: true,
  authors: ["host"],
  problem_count: 1,
  participants: 3,
  registered: true,
  my_role: null,
  ...over,
});

const detailOf = (c: ContestSummary, over: Partial<ContestDetail> = {}): ContestDetail => ({
  contest: c,
  description: "",
  problems: [{ label: "A", slug: "sum", title: "Sum", points: 1, solved_by: 2, my_status: null }],
  problems_visible: true,
  editorial_available: true,
  server_time: new Date().toISOString(),
  ...over,
});

describe("search everywhere", () => {
  it("opens with ⌘K and finds people, problems and contests", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /problems": (url) =>
        json(list(url.searchParams.get("q") ? [summary(7, { title: "Graph Walk", slug: "graph-walk" })] : [summary(1)])),
      "GET /tags": () => json([]),
      "GET /users/me/stats": () => json({}),
      "GET /profiles": () => json([{ username: "grace", display_name: "Grace H", avatar_url: null, solved: 12, contests: 2, joined_at: iso(0) }]),
      "GET /contests": (url) => json(paginated(url.searchParams.get("q") ? [contest({ title: "Graph Night" })] : [])),
      "GET /problems/graph-walk": () => json(detail({ slug: "graph-walk", title: "Graph Walk" })),
    });
    renderSignedIn("/problems");
    await screen.findByRole("list", { name: /problem list/i });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dialog).getByRole("combobox"), "gra");
    const options = await within(dialog).findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("grace"),
      expect.stringContaining("Graph Walk"),
      expect.stringContaining("Graph Night"),
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    // The second hit, a problem, opens; the palette closes.
    expect(await screen.findByRole("heading", { level: 1, name: /Graph Walk/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
  });

  it("finds people on the People page", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /profiles": (url) =>
        json(url.searchParams.get("q") === "zo" ? [{ username: "zoe", display_name: null, avatar_url: null, solved: 40, contests: 5, joined_at: iso(0) }] : []),
    });
    renderSignedIn("/people");
    await userEvent.type(await screen.findByPlaceholderText(/username or name/i), "zo");
    const link = await screen.findByRole("link", { name: /zoe/ });
    expect(link).toHaveAttribute("href", "/u/zoe");
    const people = screen.getByRole("list", { name: "People" });
    expect(people).toHaveTextContent("40 solved");
  });
});

describe("a live contest you joined", () => {
  it("is announced on every other page with the time left", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /contests": () =>
        json(paginated([contest({ phase: "RUNNING", starts_at: iso(-HOUR), ends_at: iso(HOUR), title: "Night Round", slug: "night" })])),
      "GET /problems": () => json(list([])),
      "GET /tags": () => json([]),
      "GET /users/me/stats": () => json({}),
    });
    renderSignedIn("/problems");
    const banner = await screen.findByRole("link", { name: /night round is live/i });
    expect(banner).toHaveAttribute("href", "/contests/night");
    expect(banner).toHaveTextContent(/left/);
  });
});

describe("editorials", () => {
  it("shows the write-ups after the end, per problem", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(detailOf(contest())),
      "GET /contests/round-1/editorial": () =>
        json({ intro: "Thanks for playing!", problems: [{ label: "A", slug: "sum", title: "Sum", editorial: "Add **both** numbers." }], is_public: true }),
    });
    renderSignedIn("/contests/round-1");
    await userEvent.click(await screen.findByRole("link", { name: "Editorial" }));
    expect(await screen.findByText("Thanks for playing!")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /A\.\s*Sum/ })).toBeInTheDocument();
    expect(screen.getByText("both").tagName).toBe("STRONG");
  });

  it("says when it is not out yet", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(detailOf(contest({ phase: "RUNNING", starts_at: iso(-HOUR), ends_at: iso(HOUR) }), { editorial_available: false })),
      "GET /contests/round-1/editorial": () => apiError(409, "EDITORIAL_NOT_YET", "later"),
    });
    renderSignedIn("/contests/round-1/editorial");
    expect(await screen.findByText(/the editorial appears when the contest ends/i)).toBeInTheDocument();
  });

  it("lets an author write it on the manage page", async () => {
    const mine = contest({ my_role: "OWNER", phase: "UPCOMING", starts_at: iso(HOUR), ends_at: iso(3 * HOUR), published: false });
    const api = mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(detailOf(mine, { editorial_available: false })),
      "GET /studio/problems": () => json(paginated([])),
      "GET /contests/round-1/editorial": () =>
        json({ intro: "", problems: [{ label: "A", slug: "sum", title: "Sum", editorial: "" }], is_public: false }),
      "PUT /contests/round-1/editorial": () =>
        json({ intro: "Hi", problems: [{ label: "A", slug: "sum", title: "Sum", editorial: "Use a long." }], is_public: false }),
    });
    renderSignedIn("/contests/round-1/manage");
    await userEvent.click(await screen.findByRole("tab", { name: /editorial/i }));
    await userEvent.type(await screen.findByLabelText("Introduction"), "Hi");
    await userEvent.type(screen.getByLabelText("A. Sum"), "Use a long.");
    await userEvent.click(screen.getByRole("button", { name: "Save editorial" }));
    await waitFor(() =>
      expect(api.bodiesFor("PUT /contests/round-1/editorial")).toEqual([{ intro: "Hi", problems: { A: "Use a long." } }]),
    );
    expect(await screen.findByText("Editorial saved.")).toBeInTheDocument();
  });

  it("appears folded away on the practice problem, linking to the contest's", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /problems/a-plus-b": () =>
        json(detail({ editorial: { contest_slug: "round-1", contest_title: "Round 1", label: "A", text: "Sum them." } })),
    });
    renderSignedIn("/problems/a-plus-b");
    const summaryEl = await screen.findByText(/from Round 1, problem A/);
    const box = summaryEl.closest("details")!;
    expect(box).not.toHaveAttribute("open");
    expect(within(box).getByRole("link", { name: /whole contest editorial/i })).toHaveAttribute("href", "/contests/round-1/editorial");
  });
});

describe("the adjustable editor", () => {
  it("changes the font size, folds the problem away in focus mode, and remembers it", async () => {
    mockApi({ ...baseRoutes(), "GET /problems/a-plus-b": () => json(detail()) });
    renderSignedIn("/problems/a-plus-b");
    await screen.findByRole("heading", { level: 1, name: /A Plus B/ });
    expect(screen.getByLabelText("Font size 14")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(screen.getByLabelText("Font size 15")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /focus mode/i }));
    expect(screen.queryByRole("heading", { level: 1, name: /A Plus B/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("vr.editor")!)).toMatchObject({ fontSize: 15, focus: true });
    await userEvent.click(screen.getByRole("button", { name: /show the problem/i }));
    expect(screen.getByRole("heading", { level: 1, name: /A Plus B/ })).toBeInTheDocument();
  });

  it("resizes the split and the editor from the keyboard", async () => {
    mockApi({ ...baseRoutes(), "GET /problems/a-plus-b": () => json(detail()) });
    renderSignedIn("/problems/a-plus-b");
    const divider = await screen.findByRole("separator", { name: /resize the problem and the editor/i });
    expect(divider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(divider).toHaveAttribute("aria-valuenow", "60");
    const handle = screen.getByRole("separator", { name: "Resize the editor" });
    const before = Number(handle.getAttribute("aria-valuenow"));
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before + 20);
  });
});
