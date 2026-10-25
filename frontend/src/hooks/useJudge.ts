import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { runsApi, submissionsApi } from "../api/endpoints";
import { isTerminal, type Run, type Submission } from "../api/types";

/** How long to keep polling before giving up and saying so. */
const RUN_DEADLINE_MS = 90_000;
const SUBMIT_DEADLINE_MS = 180_000;
/** Gap between polls once the first long-poll returns. */
const POLL_INTERVAL_MS = 700;

export interface AsyncJobState<T> {
  /** True from the moment the request is sent until a terminal state. */
  busy: boolean;
  result: T | null;
  /** A message to show the user; never a raw exception. */
  error: string | null;
}

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    // 429 carries a human-readable reason from the server.
    return err.message;
  }
  return fallback;
}

/**
 * Drives `POST /runs` and then follows the run to a terminal state.
 *
 * The first fetch uses the server's `wait_ms` long-poll so a fast program shows
 * its output in a single round trip; anything slower falls back to polling.
 */
export function useRun() {
  const [state, setState] = useState<AsyncJobState<Run>>({
    busy: false,
    result: null,
    error: null,
  });
  // Guards against a response arriving after the component unmounted, or after
  // the user started a newer run.
  const active = useRef(0);
  useEffect(() => () => {
    active.current += 1;
  }, []);

  const reset = useCallback(() => {
    active.current += 1;
    setState({ busy: false, result: null, error: null });
  }, []);

  const start = useCallback(
    async (args: {
      problemSlug: string;
      language: string;
      source: string;
      mode: "samples" | "custom";
      stdin: string;
    }) => {
      const token = ++active.current;
      setState({ busy: true, result: null, error: null });
      try {
        const created = await runsApi.create({
          problem_id: args.problemSlug,
          language: args.language,
          source_code: args.source,
          mode: args.mode,
          stdin: args.mode === "custom" ? args.stdin : undefined,
        });

        const deadline = Date.now() + RUN_DEADLINE_MS;
        let first = true;
        for (;;) {
          if (active.current !== token) return;
          const run = await runsApi.get(created.run_id, first ? 8000 : undefined);
          first = false;
          if (active.current !== token) return;
          if (run.status === "FINISHED") {
            setState({ busy: false, result: run, error: null });
            return;
          }
          // Show progress while waiting rather than an opaque spinner.
          setState({ busy: true, result: run, error: null });
          if (Date.now() > deadline) {
            setState({
              busy: false,
              result: run,
              error: "This run is taking longer than expected. Check back shortly.",
            });
            return;
          }
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (active.current !== token) return;
        setState({
          busy: false,
          result: null,
          error: message(err, "Could not reach the server. Please try again."),
        });
      }
    },
    [],
  );

  return { ...state, start, reset };
}

/**
 * Drives `POST /submissions` (or, with `create`, another way of submitting,
 * such as a contest's) and polls until a verdict is persisted.
 */
export function useSubmit() {
  const [state, setState] = useState<AsyncJobState<Submission>>({
    busy: false,
    result: null,
    error: null,
  });
  const active = useRef(0);
  useEffect(() => () => {
    active.current += 1;
  }, []);

  const reset = useCallback(() => {
    active.current += 1;
    setState({ busy: false, result: null, error: null });
  }, []);

  const start = useCallback(
    async (args: {
      problemSlug: string;
      language: string;
      source: string;
      create?: (a: { language: string; source: string }) => Promise<{ submission_id: string }>;
    }) => {
      const token = ++active.current;
      setState({ busy: true, result: null, error: null });
      try {
        const created = args.create
          ? await args.create({ language: args.language, source: args.source })
          : await submissionsApi.create({
              problem_id: args.problemSlug,
              language: args.language,
              source_code: args.source,
            });

        const deadline = Date.now() + SUBMIT_DEADLINE_MS;
        for (;;) {
          if (active.current !== token) return;
          const submission = await submissionsApi.get(created.submission_id);
          if (active.current !== token) return;
          if (isTerminal(submission.status)) {
            setState({ busy: false, result: submission, error: null });
            return;
          }
          setState({ busy: true, result: submission, error: null });
          if (Date.now() > deadline) {
            setState({
              busy: false,
              result: submission,
              error:
                "Still judging. Your submission is saved — open it from your history for the verdict.",
            });
            return;
          }
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (active.current !== token) return;
        setState({
          busy: false,
          result: null,
          error: message(err, "Could not reach the server. Please try again."),
        });
      }
    },
    [],
  );

  return { ...state, start, reset };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
