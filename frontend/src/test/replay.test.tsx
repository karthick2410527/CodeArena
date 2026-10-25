import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Replay, ReplayStep } from "../api/types";
import { apiError, baseRoutes, detail, json, LANGUAGES, mockApi, renderSignedIn } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const SOURCE = [
  "int sq(int x) {", //       1
  "    return x * x;", //     2
  "}", //                     3
  "int main() {", //          4
  "    int a = 3;", //        5
  "    int b = sq(a);", //    6
  "    cout << b;", //        7
  "}", //                     8
].join("\n");

const main = (line: number, vars: ReplayStep["frames"][number]["variables"]) => ({
  index: 0,
  function: "main",
  line,
  variables: vars,
});
const v = (name: string, value: string, changed = false, type: string | null = "int") => ({
  name,
  value,
  type,
  changed,
});

/** main runs a = 3, calls sq(a), stores b, prints it. */
const STEPS: ReplayStep[] = [
  { step: 0, line: 5, depth: 1, stdout_length: 0, frames: [main(5, [])] },
  { step: 1, line: 6, depth: 1, stdout_length: 0, frames: [main(6, [v("a", "3", true)])] },
  {
    step: 2,
    line: 2,
    depth: 2,
    stdout_length: 0,
    frames: [main(6, [v("a", "3")]), { index: 1, function: "sq(int)", line: 2, variables: [v("x", "3", true)] }],
  },
  {
    step: 3,
    line: 3,
    depth: 2,
    stdout_length: 0,
    frames: [main(6, [v("a", "3")]), { index: 1, function: "sq(int)", line: 3, variables: [v("x", "3")] }],
  },
  { step: 4, line: 6, depth: 1, stdout_length: 0, frames: [main(6, [v("a", "3")])] },
  { step: 5, line: 7, depth: 1, stdout_length: 0, frames: [main(7, [v("a", "3"), v("b", "9", true)])] },
];

const replay = (over: Partial<Replay> = {}): Replay => ({
  replay_id: "rep-1",
  status: "FINISHED",
  problem_slug: "a-plus-b",
  language: "cpp17",
  source_code: SOURCE,
  stdin: "",
  step_count: STEPS.length,
  termination: { kind: "EXITED", exit_code: 0, detail: "exited with status 0" },
  compile_output: "",
  stdout: "9",
  timeline: STEPS.map((s) => [s.line, s.depth]),
  created_at: "2026-01-02T03:04:05Z",
  finished_at: "2026-01-02T03:04:07Z",
  message: null,
  ...over,
});

const stepRoutes = {
  "GET /replays/rep-1/steps": (url: URL) => {
    const from = Number(url.searchParams.get("from"));
    const count = Number(url.searchParams.get("count"));
    return json({ from, total: STEPS.length, steps: STEPS.slice(from, from + count) });
  },
};

function renderReplay(r: Replay = replay()) {
  const api = mockApi({ ...baseRoutes(), "GET /replays/rep-1": () => json(r), ...stepRoutes });
  renderSignedIn("/replays/rep-1");
  return api;
}

const currentLine = () => document.querySelector('[aria-current="step"]')?.getAttribute("data-line");
const position = () => screen.getByTestId("position").textContent;
const variable = (name: string) => document.querySelector(`[data-variable="${name}"]`);

describe("starting a debug session from the editor", () => {
  it("records the code against the first sample and opens the viewer", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "GET /problems/a-plus-b": () => json(detail()),
      "POST /replays": () => json({ replay_id: "rep-1", status: "QUEUED" }, 202),
      "GET /replays/rep-1": () => json(replay()),
      ...stepRoutes,
    });
    renderSignedIn("/problems/a-plus-b");

    const debug = await screen.findByRole("button", { name: /debug/i });
    await waitFor(() => expect(debug).toBeEnabled());
    await userEvent.click(debug);

    expect(await screen.findByRole("heading", { name: /step through your run/i })).toBeInTheDocument();
    expect(api.bodiesFor("POST /replays")).toEqual([
      {
        problem_id: "a-plus-b",
        language: "cpp17",
        source_code: LANGUAGES[0].starter_code,
        stdin: "3 5",
      },
    ]);
  });

  it("is only offered for C++", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /languages": () =>
        json([{ id: "java21", display_name: "Java 21", monaco_id: "java", starter_code: "class Main {}\n" }]),
      "GET /problems/a-plus-b": () => json(detail()),
    });
    renderSignedIn("/problems/a-plus-b");

    expect(await screen.findByText(/debug \(step-by-step replay\) is available for c\+\+17/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /debug/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });
});

describe("the replay viewer", () => {
  it("waits for the recording, then shows the first step", async () => {
    // Still recording until the test has seen the waiting message: the page polls
    // again within milliseconds, faster than the test could otherwise look.
    let recorded = false;
    mockApi({
      ...baseRoutes(),
      "GET /replays/rep-1": () =>
        json(recorded ? replay() : replay({ status: "RECORDING", step_count: 0, timeline: [], termination: null })),
      ...stepRoutes,
    });
    renderSignedIn("/replays/rep-1");

    expect(await screen.findByText(/recording your program/i)).toBeInTheDocument();
    recorded = true;
    await waitFor(() => expect(position()).toBe("Step 1 of 6 · line 5"));
    expect(currentLine()).toBe("5");
    expect(screen.getByText(/no variables in scope yet/i)).toBeInTheDocument();
  });

  it("steps forwards and backwards, highlighting what each step changed", async () => {
    renderReplay();
    await waitFor(() => expect(position()).toBe("Step 1 of 6 · line 5"));
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Step" }));
    expect(currentLine()).toBe("6");
    await waitFor(() => expect(variable("a")).toHaveAttribute("data-changed", "true"));

    // Into the call: a second frame, its argument just set.
    await userEvent.click(screen.getByRole("button", { name: "Step" }));
    expect(currentLine()).toBe("2");
    const stack = screen.getByRole("region", { name: "Call stack" });
    await waitFor(() => expect(within(stack).getAllByRole("button")).toHaveLength(2));
    expect(within(stack).getAllByRole("button")[0]).toHaveTextContent("sq(int)");
    expect(variable("x")).toHaveTextContent("3");
    expect(document.querySelector('[data-line="6"]')?.className).toContain("bg-warn");

    // Looking at the caller's variables without moving.
    await userEvent.click(within(stack).getByRole("button", { name: /main/ }));
    expect(variable("a")).toBeInTheDocument();
    expect(variable("x")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(currentLine()).toBe("6");
    expect(position()).toBe("Step 2 of 6 · line 6");
  });

  it("steps over and out of calls, and runs to a breakpoint", async () => {
    renderReplay();
    await waitFor(() => expect(position()).toBe("Step 1 of 6 · line 5"));

    await userEvent.click(screen.getByRole("button", { name: "Step" })); // line 6, about to call sq
    await userEvent.click(screen.getByRole("button", { name: "Step over" }));
    expect(position()).toBe("Step 5 of 6 · line 6"); // back in main with the call done

    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await userEvent.click(screen.getByRole("button", { name: "Breakpoint on line 3" }));
    expect(screen.getByRole("button", { name: "Breakpoint on line 3" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(position()).toBe("Step 4 of 6 · line 3");

    await userEvent.click(screen.getByRole("button", { name: "Step out" }));
    expect(position()).toBe("Step 5 of 6 · line 6");
    await userEvent.click(screen.getByRole("button", { name: "Back to breakpoint" }));
    expect(position()).toBe("Step 4 of 6 · line 3");
  });

  it("moves with the keyboard and shows the final output once the program exits", async () => {
    renderReplay();
    await waitFor(() => expect(position()).toBe("Step 1 of 6 · line 5"));
    const output = screen.getByRole("region", { name: "Output" });
    expect(output).toHaveTextContent(/nothing printed yet/);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(position()).toBe("Step 2 of 6 · line 6");
    fireEvent.keyDown(window, { key: "End" });
    expect(position()).toBe("Step 6 of 6 · line 7");
    await waitFor(() => expect(variable("b")).toHaveTextContent("9"));
    expect(output).toHaveTextContent("9");
    expect(output).toHaveTextContent(/exited with code 0/);
    fireEvent.keyDown(window, { key: "Home" });
    expect(position()).toBe("Step 1 of 6 · line 5");
  });

  it("explains a crash and jumps to where it happened", async () => {
    renderReplay(replay({ termination: { kind: "CRASHED", exit_code: null, detail: "signal SIGSEGV: invalid address" } }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/your program crashed/i);
    expect(alert).toHaveTextContent(/SIGSEGV/);
    await userEvent.click(within(alert).getByRole("button", { name: /jump to the crash/i }));
    expect(position()).toBe("Step 6 of 6 · line 7");
  });

  it("shows the compiler's errors when there is nothing to step through", async () => {
    renderReplay(
      replay({
        step_count: 0,
        timeline: [],
        stdout: "",
        compile_output: "main.cpp:5:14: error: expected ';' before '}' token",
        termination: { kind: "COMPILE_ERROR", exit_code: null, detail: "compilation failed" },
      }),
    );
    expect(await screen.findByText(/your code didn't compile/i)).toBeInTheDocument();
    expect(screen.getByText(/the first on line 5/i)).toBeInTheDocument();
    const errors = screen.getByRole("list", { name: "Compiler errors" });
    expect(within(errors).getByRole("button", { name: /line 5: expected ';'/i })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: /replay controls/i })).not.toBeInTheDocument();
  });

  it("lets you fix a compile error in place and debug again", async () => {
    const broken = replay({
      step_count: 0,
      timeline: [],
      stdout: "",
      stdin: "2 3",
      source_code: "int main() {\n    cout << ab;\n}",
      compile_output: "main.cpp: In function 'int main()':\nmain.cpp:2:13: error: 'ab' was not declared in this scope\n    2 |     cout << ab;\n      |             ^~",
      termination: { kind: "COMPILE_ERROR", exit_code: null, detail: "compilation failed" },
    });
    const api = mockApi({
      ...baseRoutes(),
      "GET /replays/rep-1": () => json(broken),
      "POST /replays": () => json({ replay_id: "rep-2", status: "QUEUED" }, 202),
      "GET /replays/rep-2": () => json(replay({ replay_id: "rep-2" })),
      ...stepRoutes,
    });
    renderSignedIn("/replays/rep-1");
    const editor = await screen.findByLabelText("Your code · C++17");
    expect(editor).toHaveValue("int main() {\n    cout << ab;\n}");
    await userEvent.clear(editor);
    await userEvent.type(editor, "int main() {{}");
    expect(screen.getByText("from the last compile")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /debug again/i }));

    await waitFor(() =>
      expect(api.bodiesFor("POST /replays")).toEqual([
        { problem_id: "a-plus-b", language: "cpp17", source_code: "int main() {}", stdin: "2 3" },
      ]),
    );
    expect(await screen.findByRole("toolbar", { name: /replay controls/i })).toBeInTheDocument();
    expect(localStorage.getItem("voidrun.draft.a-plus-b.cpp17")).toBe("int main() {}");
  });

  it("opens the editor from a finished replay", async () => {
    renderReplay(replay());
    await userEvent.click(await screen.findByRole("button", { name: /edit code and debug again/i }));
    expect(screen.getByLabelText("Your code · C++17")).toHaveValue(SOURCE);
    await userEvent.click(screen.getByRole("button", { name: /back to the replay/i }));
    expect(screen.getByRole("toolbar", { name: /replay controls/i })).toBeInTheDocument();
  });

  it("says so when a replay has expired or is someone else's", async () => {
    mockApi({ ...baseRoutes(), "GET /replays/rep-1": () => apiError(404, "NOT_FOUND", "replay not found") });
    renderSignedIn("/replays/rep-1");
    expect(await screen.findByRole("heading", { name: /replay not found/i })).toBeInTheDocument();
  });
});
