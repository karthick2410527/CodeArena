import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, baseRoutes, detail, json, list, mockApi, renderApp, summary } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("problem list", () => {
  it("shows a loading state, then the problems", async () => {
    mockApi({
      "GET /problems": () =>
        json(list([summary(1, { title: "A Plus B" }), summary(2, { title: "Count Islands", difficulty: "MEDIUM", tags: ["graphs"] })])),
      "GET /tags": () => json([{ name: "math", count: 1 }]),
    });
    renderApp("/problems");

    expect(screen.getByRole("status", { name: /loading problems/i })).toBeInTheDocument();
    const listEl = await screen.findByRole("list", { name: /problem list/i });
    expect(within(listEl).getByText("A Plus B")).toBeInTheDocument();
    expect(within(listEl).getByText("Count Islands")).toBeInTheDocument();
    expect(within(listEl).getByText("Medium")).toBeInTheDocument();
    expect(within(listEl).getByRole("link", { name: /A Plus B/ })).toHaveAttribute("href", "/problems/problem-1");
  });

  it("requests the selected difficulty from the API", async () => {
    const api = mockApi({
      "GET /problems": () => json(list([summary(1)])),
      "GET /tags": () => json([]),
    });
    renderApp("/problems");
    await screen.findByRole("list", { name: /problem list/i });

    await userEvent.selectOptions(screen.getByLabelText(/filter by difficulty/i), "HARD");
    await waitFor(() =>
      expect(api.calls.some((c) => c.key === "GET /problems" && c.url.searchParams.get("difficulty") === "HARD")).toBe(true),
    );
  });

  it("paginates with the Next button", async () => {
    const api = mockApi({
      "GET /problems": (url) =>
        json(
          url.searchParams.get("page") === "2"
            ? list([summary(9, { title: "Ninth" })], { page: 2, total: 9, total_pages: 2 })
            : list([summary(1, { title: "First" })], { page: 1, total: 9, total_pages: 2 }),
        ),
      "GET /tags": () => json([]),
    });
    renderApp("/problems");
    await screen.findByText("First");
    expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("Ninth");
    expect(api.calls.some((c) => c.url.searchParams.get("page") === "2")).toBe(true);
  });

  it("shows an empty state with a way to clear filters", async () => {
    mockApi({
      "GET /problems": () => json(list([])),
      "GET /tags": () => json([]),
    });
    renderApp("/problems?difficulty=HARD");
    expect(await screen.findByText(/no problems found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });

  it("shows an error state and retries", async () => {
    let fail = true;
    mockApi({
      "GET /problems": () => (fail ? apiError(500, "INTERNAL", "internal server error") : json(list([summary(1, { title: "Recovered" })]))),
      "GET /tags": () => json([]),
    });
    renderApp("/problems");
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load problems/i);

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });
});

describe("problem detail", () => {
  it("renders the statement, constraints, limits and public examples", async () => {
    mockApi({ ...baseRoutes(), "GET /problems/a-plus-b": () => json(detail()) });
    renderApp("/problems/a-plus-b");

    expect(await screen.findByRole("heading", { level: 1, name: /A Plus B/ })).toBeInTheDocument();
    expect(screen.getByText("sum").tagName).toBe("STRONG"); // markdown rendered
    expect(screen.getByText(/-10\^9 <= a, b <= 10\^9/)).toBeInTheDocument();
    // Limits sit together in the problem header.
    expect(screen.getByText("1000 ms · 256 MB")).toBeInTheDocument();
    expect(screen.getByText("Example 1")).toBeInTheDocument();
    expect(screen.getByText("3 5")).toBeInTheDocument();
    expect(screen.getByText("3 + 5 = 8.")).toBeInTheDocument();
  });

  it("shows a not-found state for a missing problem", async () => {
    mockApi({ ...baseRoutes(), "GET /problems/nope": () => apiError(404, "NOT_FOUND", "problem not found") });
    renderApp("/problems/nope");
    expect(await screen.findByText(/problem not found/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to problems/i })).toHaveAttribute("href", "/problems");
  });

  it("shows an error state for server failures", async () => {
    mockApi({ ...baseRoutes(), "GET /problems/a-plus-b": () => apiError(500, "INTERNAL", "internal server error") });
    renderApp("/problems/a-plus-b");
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load this problem/i);
  });
});
