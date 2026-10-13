/**
 * Submission history, detail and profile statistics (Phase 4 from the user's
 * side), plus the privacy rules the UI must not undermine.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ADMIN,
  apiError,
  baseRoutes,
  json,
  mockApi,
  paginated,
  renderSignedIn,
  stats,
  submission,
  submissionSummary,
  testResults,
} from "./helpers";

describe("submission history", () => {
  it("lists the user's submissions newest first with their verdicts", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /submissions": () =>
        json(
          paginated([
            submissionSummary({ submission_id: "sub-1", status: "ACCEPTED" }),
            submissionSummary({
              submission_id: "sub-2",
              status: "WRONG_ANSWER",
              verdict: "WRONG_ANSWER",
              passed_tests: 2,
              total_tests: 5,
            }),
          ]),
        ),
    });
    renderSignedIn("/submissions");

    const rows = await screen.findByRole("list", { name: "Submissions" });
    expect(within(rows).getByText("Accepted")).toBeInTheDocument();
    expect(within(rows).getByText("Wrong Answer")).toBeInTheDocument();
    expect(within(rows).getByText("2/5")).toBeInTheDocument();
    expect(screen.getByText("2 submissions")).toBeInTheDocument();
  });

  it("shows a helpful empty state with a way out", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /submissions": () => json(paginated([])),
    });
    renderSignedIn("/submissions");

    expect(await screen.findByText("No submissions yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse problems" })).toHaveAttribute(
      "href",
      "/problems",
    );
  });

  it("puts the verdict filter in the URL so it can be shared", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "GET /submissions": () => json(paginated([submissionSummary()])),
    });
    renderSignedIn("/submissions");
    await screen.findByRole("list", { name: "Submissions" });

    await userEvent.selectOptions(
      screen.getByLabelText("Filter by verdict"),
      "WRONG_ANSWER",
    );

    await waitFor(() => {
      const last = api.calls.filter((c) => c.key === "GET /submissions").at(-1)!;
      expect(last.url.searchParams.get("verdict")).toBe("WRONG_ANSWER");
    });
  });

  it("requests a bounded page size", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "GET /submissions": () => json(paginated([submissionSummary()])),
    });
    renderSignedIn("/submissions");
    await screen.findByRole("list", { name: "Submissions" });

    const first = api.calls.find((c) => c.key === "GET /submissions")!;
    const limit = Number(first.url.searchParams.get("limit"));
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(50);
  });

  it("surfaces a load failure with a retry rather than an empty page", async () => {
    let attempts = 0;
    mockApi({
      ...baseRoutes(),
      "GET /submissions": () => {
        attempts += 1;
        return attempts === 1
          ? apiError(500, "INTERNAL", "internal server error")
          : json(paginated([submissionSummary()]));
      },
    });
    renderSignedIn("/submissions");

    expect(await screen.findByText("Couldn't load your submissions")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Submissions" })).toBeInTheDocument();
  });
});

describe("submission detail", () => {
  it("shows the verdict, metrics, per-test results and the user's own code", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /submissions/sub-1": () => json(submission()),
      "GET /submissions/sub-1/test-results": () => json(testResults()),
    });
    renderSignedIn("/submissions/sub-1");

    expect(await screen.findByRole("heading", { name: "A Plus B" })).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    // "5 / 5" is both the test count and the score, so read each metric from
    // its own label.
    const metric = (label: string) =>
      screen.getByText(label).parentElement!.querySelector("dd")!.textContent;
    expect(metric("Tests passed")).toBe("5 / 5");
    expect(metric("Score")).toBe("5 / 5");
    expect(metric("Max time")).toBe("7 ms");
    expect(metric("Max memory")).toBe("2.0 MB");

    // The per-test table names the kind of each test but carries none of its
    // data: no column exists for an input or an expected output.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Sample")).toBeInTheDocument();
    expect(within(table).getByText("Hidden")).toBeInTheDocument();
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Test", "Kind", "Verdict", "Time", "Memory", "Points"]);

    // The owner sees their submitted code, read only.
    const code = await screen.findByLabelText(/cpp17 \(read only\)/i);
    expect(code).toHaveValue("int main() { return 0; }");
    expect(code).toHaveAttribute("readonly");
  });

  it("explains a wrong answer without naming the hidden data", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /submissions/sub-1": () =>
        json(
          submission({
            status: "WRONG_ANSWER",
            verdict: "WRONG_ANSWER",
            passed_tests: 1,
            total_tests: 4,
            failed_case_position: 2,
            message: "Your output did not match the expected output.",
          }),
        ),
      "GET /submissions/sub-1/test-results": () =>
        json(
          testResults({
            status: "WRONG_ANSWER",
            verdict: "WRONG_ANSWER",
            passed_tests: 1,
            total_tests: 4,
            results: [
              {
                position: 1,
                is_sample: true,
                verdict: "ACCEPTED",
                execution_time_ms: 2,
                memory_bytes: 1024,
                points_awarded: 0,
              },
              {
                position: 2,
                is_sample: false,
                verdict: "WRONG_ANSWER",
                execution_time_ms: 3,
                memory_bytes: 1024,
                points_awarded: 0,
              },
            ],
          }),
        ),
    });
    renderSignedIn("/submissions/sub-1");

    expect(await screen.findByText("Wrong Answer")).toBeInTheDocument();
    expect(screen.getByText(/Failed on test 2/)).toBeInTheDocument();
    expect(screen.getByText(/hidden test data is not shown/i)).toBeInTheDocument();
  });

  it("keeps polling while the verdict is still pending", async () => {
    let polls = 0;
    mockApi({
      ...baseRoutes(),
      "GET /submissions/sub-1": () => {
        polls += 1;
        return polls < 2
          ? json(submission({ status: "QUEUED", verdict: null, finished_at: null }))
          : json(submission());
      },
      "GET /submissions/sub-1/test-results": () => json(testResults()),
    });
    renderSignedIn("/submissions/sub-1");

    expect(await screen.findByText("Queued")).toBeInTheDocument();
    expect(
      screen.getByText("Results appear once judging finishes."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Accepted", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("reports someone else's submission as not found, not forbidden", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /submissions/sub-9": () => apiError(404, "NOT_FOUND", "submission not found"),
    });
    renderSignedIn("/submissions/sub-9");

    expect(await screen.findByText("Submission not found")).toBeInTheDocument();
    // The UI must not imply the submission exists and is merely off-limits.
    expect(screen.queryByText(/forbidden/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not allowed/i)).not.toBeInTheDocument();
  });

  it("omits the code block when the API withheld the source", async () => {
    const withoutSource = submission();
    delete withoutSource.source_code;
    delete withoutSource.compile_output;
    mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /submissions/sub-1": () => json(withoutSource),
      "GET /submissions/sub-1/test-results": () => json(testResults()),
    });
    renderSignedIn("/submissions/sub-1", ADMIN);

    expect(await screen.findByText("Accepted")).toBeInTheDocument();
    expect(screen.queryByText("Submitted code")).not.toBeInTheDocument();
  });
});

describe("profile statistics", () => {
  it("shows solved counts, acceptance rate and the verdict breakdown", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /users/me": () =>
        json({
          id: "11111111-1111-1111-1111-111111111111",
          username: "ada",
          email: "ada@example.com",
          role: "USER",
          created_at: "2026-01-02T03:04:05Z",
        }),
      "GET /users/me/stats": () => json(stats()),
    });
    renderSignedIn("/profile");

    expect(await screen.findByRole("heading", { name: "Your profile" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();

    expect(await screen.findByText("Statistics")).toBeInTheDocument();
    expect(screen.getByText("of 10 published")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    // Difficulty progress is exposed to assistive technology, not just colour.
    const easy = screen.getByRole("progressbar", { name: /Easy problems solved/ });
    expect(easy).toHaveAttribute("aria-valuenow", "2");
    expect(easy).toHaveAttribute("aria-valuemax", "4");
  });

  it("invites a new user to start rather than showing zeroes everywhere", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /users/me": () =>
        json({
          id: "11111111-1111-1111-1111-111111111111",
          username: "ada",
          email: "ada@example.com",
          role: "USER",
          created_at: "2026-01-02T03:04:05Z",
        }),
      "GET /users/me/stats": () =>
        json(
          stats({
            total_submissions: 0,
            accepted_submissions: 0,
            problems_solved: 0,
            solved_easy: 0,
            solved_medium: 0,
            solved_hard: 0,
            acceptance_rate: 0,
            last_submission_at: null,
            verdict_counts: {},
          }),
        ),
    });
    renderSignedIn("/profile");

    expect(await screen.findByText(/haven't submitted anything yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pick a problem" })).toBeInTheDocument();
  });
});

describe("navigation", () => {
  it("offers the admin areas only to administrators", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /submissions": () => json(paginated([])),
    });
    renderSignedIn("/submissions");
    await screen.findByText("No submissions yet");

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Submissions" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Judge" })).not.toBeInTheDocument();
  });

  it("shows the admin areas to an administrator", async () => {
    mockApi({
      ...baseRoutes({ user: ADMIN }),
      "GET /submissions": () => json(paginated([])),
    });
    renderSignedIn("/submissions", ADMIN);
    await screen.findByText("No submissions yet");

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Admin" })).toHaveAttribute(
      "href",
      "/admin/problems",
    );
    expect(within(nav).getByRole("link", { name: "Judge" })).toHaveAttribute(
      "href",
      "/admin/ops",
    );
  });

  it("sends an anonymous visitor to the login page for a private route", async () => {
    mockApi(baseRoutes({ anonymous: true }));
    renderSignedIn("/submissions");

    expect(
      await screen.findByRole("heading", { name: "Welcome back" }),
    ).toBeInTheDocument();
  });
});
