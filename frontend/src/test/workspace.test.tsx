/**
 * Editor and Run/Submit workflow (Phase 2 and 3 from the user's side).
 *
 * Monaco is stubbed to a textarea (see `src/test/stubs/`), so these tests drive
 * the same props the real editor receives.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  apiError,
  baseRoutes,
  detail,
  json,
  mockApi,
  renderSignedIn,
  run,
  runCase,
  submission,
} from "./helpers";

const problemRoutes = () => ({
  ...baseRoutes(),
  "GET /problems/a-plus-b": () => json(detail()),
});

async function openProblem() {
  renderSignedIn("/problems/a-plus-b");
  expect(await screen.findByRole("heading", { name: /A Plus B/ })).toBeInTheDocument();
}

describe("the editor", () => {
  it("loads the language's starter code and can reset it", async () => {
    mockApi(problemRoutes());
    await openProblem();

    // The editor label is the language's display name once Monaco has mounted;
    // before that a plain-textarea fallback is shown, so wait for the real one.
    const editor = await screen.findByLabelText("C++17 (GCC)");
    await waitFor(() => expect(editor).toHaveValue("int main() { return 0; }\n"));

    await userEvent.clear(editor);
    await userEvent.type(editor, "my own code");
    expect(editor).toHaveValue("my own code");

    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(editor).toHaveValue("int main() { return 0; }\n");
  });

  it("reports the source size against the server's limit", async () => {
    mockApi(problemRoutes());
    await openProblem();
    expect(await screen.findByText(/of 65,536 allowed/)).toBeInTheDocument();
  });

  it("offers only the languages the server returned", async () => {
    mockApi(problemRoutes());
    await openProblem();
    const select = await screen.findByLabelText("Language");
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "C++17 (GCC)" })).toBeInTheDocument();
  });
});

describe("running code", () => {
  it("runs against the public samples and shows the output", async () => {
    const api = mockApi({
      ...problemRoutes(),
      "POST /runs": () => json({ run_id: "run-1", status: "QUEUED" }, 202),
      "GET /runs/run-1": () => json(run()),
    });
    await openProblem();

    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Ran successfully")).toBeInTheDocument();
    const caseBlock = screen.getByRole("heading", { name: "Sample 1" }).closest("section")!;
    expect(within(caseBlock).getByText("passed")).toBeInTheDocument();
    // The run's own output panel shows what the program printed. Scoped to the
    // case, because the statement pane also shows "8" as the example output.
    const yourOutput = within(caseBlock).getByText("Your output").nextElementSibling!;
    expect(yourOutput).toHaveTextContent("8");

    // The request said "samples" and carried no stdin.
    const [body] = api.bodiesFor("POST /runs") as Array<Record<string, unknown>>;
    expect(body.mode).toBe("samples");
    expect(body.problem_id).toBe("a-plus-b");
    expect(body.stdin).toBeUndefined();
  });

  it("runs custom input and makes no pass/fail claim about it", async () => {
    const api = mockApi({
      ...problemRoutes(),
      "POST /runs": () => json({ run_id: "run-1", status: "QUEUED" }, 202),
      "GET /runs/run-1": () =>
        json(
          run({
            mode: "CUSTOM",
            cases: [
              runCase({
                label: "Custom input",
                input: "40 2",
                expected_output: null,
                stdout: "42\n",
                passed: null,
              }),
            ],
          }),
        ),
    });
    await openProblem();

    await userEvent.click(screen.getByRole("radio", { name: /Custom input/ }));
    const stdin = screen.getByLabelText("Standard input");
    await userEvent.clear(stdin);
    await userEvent.type(stdin, "40 2");
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    const caseBlock = (await screen.findByRole("heading", { name: "Custom input" })).closest(
      "section",
    )!;
    expect(within(caseBlock).getByText("Your output").nextElementSibling).toHaveTextContent(
      "42",
    );
    // Nothing to compare against, so neither verdict word nor an expectation
    // is shown.
    expect(within(caseBlock).queryByText("passed")).not.toBeInTheDocument();
    expect(within(caseBlock).queryByText("failed")).not.toBeInTheDocument();
    expect(within(caseBlock).queryByText("Expected output")).not.toBeInTheDocument();

    const [body] = api.bodiesFor("POST /runs") as Array<Record<string, unknown>>;
    expect(body.mode).toBe("custom");
    expect(body.stdin).toBe("40 2");
  });

  it("shows compiler errors when the code does not build", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /runs": () => json({ run_id: "run-1", status: "QUEUED" }, 202),
      "GET /runs/run-1": () =>
        json(
          run({
            outcome: "COMPILATION_ERROR",
            compile_output: "main.cpp:1:5: error: expected ';'",
            cases: [],
            message: "Your code did not compile.",
          }),
        ),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Compilation Error")).toBeInTheDocument();
    expect(screen.getByText("Compiler errors")).toBeInTheDocument();
    expect(screen.getByText(/expected ';'/)).toBeInTheDocument();
  });

  it("shows a failing sample with the expected output side by side", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /runs": () => json({ run_id: "run-1", status: "QUEUED" }, 202),
      "GET /runs/run-1": () =>
        json(
          run({
            cases: [runCase({ stdout: "7\n", passed: false })],
          }),
        ),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText("Your output")).toBeInTheDocument();
    expect(screen.getByText("Expected output")).toBeInTheDocument();
  });

  it("reports a timeout as a terminal state rather than hanging", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /runs": () => json({ run_id: "run-1", status: "QUEUED" }, 202),
      "GET /runs/run-1": () =>
        json(
          run({
            outcome: "TIME_LIMIT_EXCEEDED",
            cases: [runCase({ exec_status: "TIME_LIMIT", stdout: "", passed: false })],
            message: "Your program exceeded the time limit.",
          }),
        ),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Time Limit Exceeded")).toBeInTheDocument();
    expect(
      screen.getByText("Your program exceeded the time limit."),
    ).toBeInTheDocument();
  });

  it("surfaces a rate limit as the server's own message", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /runs": () =>
        apiError(429, "RATE_LIMITED", "too many runs; please wait before running again"),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many runs/);
  });

  it("marks truncated output so the user knows it is incomplete", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /runs": () => json({ run_id: "run-1", status: "QUEUED" }, 202),
      "GET /runs/run-1": () =>
        json(run({ cases: [runCase({ stdout_truncated: true })] })),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/truncated at the size limit/)).toBeInTheDocument();
  });
});

describe("submitting", () => {
  it("polls a queued submission until a verdict arrives", async () => {
    let polls = 0;
    const api = mockApi({
      ...problemRoutes(),
      "POST /submissions": () => json({ submission_id: "sub-1", status: "QUEUED" }, 202),
      "GET /submissions/sub-1": () => {
        polls += 1;
        if (polls === 1) {
          return json(submission({ status: "QUEUED", verdict: null, finished_at: null }));
        }
        return json(submission({ status: "ACCEPTED", verdict: "ACCEPTED" }));
      },
    });
    await openProblem();

    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    // Queued first…
    expect(await screen.findByText("Queued")).toBeInTheDocument();
    // …then the verdict, without the user doing anything.
    expect(await screen.findByText("Accepted", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("5 / 5 tests passed")).toBeInTheDocument();
    expect(api.countFor("GET /submissions/sub-1")).toBeGreaterThan(1);
  });

  it("shows a wrong answer with the failing test number and no hidden data", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /submissions": () => json({ submission_id: "sub-1", status: "QUEUED" }, 202),
      "GET /submissions/sub-1": () =>
        json(
          submission({
            status: "WRONG_ANSWER",
            verdict: "WRONG_ANSWER",
            passed_tests: 2,
            total_tests: 5,
            failed_case_position: 3,
            message: "Your output did not match the expected output.",
          }),
        ),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Wrong Answer")).toBeInTheDocument();
    expect(screen.getByText("2 / 5 tests passed")).toBeInTheDocument();
    expect(screen.getByText(/Failed on test 3/)).toBeInTheDocument();
    expect(screen.getByText(/Hidden test data is not shown/)).toBeInTheDocument();
  });

  it("reports a judge failure honestly instead of claiming success", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /submissions": () => json({ submission_id: "sub-1", status: "QUEUED" }, 202),
      "GET /submissions/sub-1": () =>
        json(
          submission({
            status: "INTERNAL_ERROR",
            verdict: "INTERNAL_ERROR",
            passed_tests: 0,
            total_tests: 0,
            message: "The judge could not finish this submission. Please submit again.",
          }),
        ),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Judge Error")).toBeInTheDocument();
    expect(screen.getByText(/could not finish this submission/)).toBeInTheDocument();
  });

  it("links to the full submission once judging finishes", async () => {
    mockApi({
      ...problemRoutes(),
      "POST /submissions": () => json({ submission_id: "sub-1", status: "QUEUED" }, 202),
      "GET /submissions/sub-1": () => json(submission()),
    });
    await openProblem();
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    const link = await screen.findByRole("link", { name: /View full submission/ });
    expect(link).toHaveAttribute("href", "/submissions/sub-1");
  });
});

describe("when not signed in", () => {
  it("asks the visitor to log in instead of offering a broken button", async () => {
    mockApi({
      ...baseRoutes({ anonymous: true }),
      "GET /problems/a-plus-b": () => json(detail()),
    });
    renderSignedIn("/problems/a-plus-b");

    expect(await screen.findByRole("heading", { name: /A Plus B/ })).toBeInTheDocument();
    // The prompt in the workspace, not the one in the site navigation.
    const prompt = screen.getByText(/to run, debug and submit your solution/);
    expect(within(prompt).getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/login",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    });
  });
});
