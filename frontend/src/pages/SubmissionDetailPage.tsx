import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { submissionsApi } from "../api/endpoints";
import { isTerminal, type TestResults } from "../api/types";
import CodeEditor from "../components/CodeEditor";
import { EmptyState, ErrorState, Spinner } from "../components/Feedback";
import VerdictBadge, { verdictLabel } from "../components/VerdictBadge";
import { formatBytes } from "../components/Workspace";

/**
 * One submission in full: verdict, metrics, the per-test summary and — for its
 * owner only — the source code that was submitted.
 *
 * Someone else's submission returns 404 from the API, so this page shows "not
 * found" rather than "forbidden": it must not confirm that it exists.
 */
export default function SubmissionDetailPage() {
  const { id = "" } = useParams();

  const submission = useQuery({
    queryKey: ["submission", id],
    queryFn: ({ signal }) => submissionsApi.get(id, signal),
    // Keep polling until a verdict is persisted.
    refetchInterval: (query) =>
      query.state.data && !isTerminal(query.state.data.status) ? 1500 : false,
  });

  const results = useQuery({
    queryKey: ["submission-results", id],
    queryFn: ({ signal }) => submissionsApi.testResults(id, signal),
    enabled: Boolean(submission.data && isTerminal(submission.data.status)),
  });

  if (submission.isPending) return <Spinner label="Loading submission…" />;

  if (submission.isError) {
    if (submission.error instanceof ApiError && submission.error.status === 404) {
      return (
        <EmptyState
          title="Submission not found"
          message="It doesn't exist, or it isn't yours."
          action={
            <Link to="/submissions" className="btn btn-primary">
              Your submissions
            </Link>
          }
        />
      );
    }
    return (
      <ErrorState
        title="Couldn't load this submission"
        message={submission.error.message}
        onRetry={() => submission.refetch()}
      />
    );
  }

  const s = submission.data;
  return (
    <div>
      <Link to="/submissions" className="text-sm text-muted hover:text-ink">
        ← Your submissions
      </Link>

      <header className={`card mt-3 overflow-hidden border-l-4 ${TONE_BORDER[tone(s.status)]}`}>
        <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">Submission</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
              <Link to={`/problems/${s.problem_slug}`} className="hover:text-accent">
                {s.problem_title}
              </Link>
            </h1>
            <p className="mt-1 text-sm text-muted">
              by {s.username} · {new Date(s.created_at).toLocaleString()} · {s.language}
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <VerdictBadge status={s.status} />
            <div className="flex gap-2">
              <CopyButton text={s.source_code ?? ""} />
              <Link to={`/problems/${s.problem_slug}`} className="btn btn-outline min-h-[34px] px-3 text-xs">
                Open the problem
              </Link>
            </div>
          </div>
        </div>
      </header>

      {s.message && (
        <p className="mt-4 rounded-md border border-line bg-surface/60 p-3 text-sm text-muted">
          {s.message}
          {s.failed_case_position !== null && (
            <> Failed on test {s.failed_case_position}; hidden test data is not shown.</>
          )}
        </p>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Tests passed"
          value={s.total_tests > 0 ? `${s.passed_tests} / ${s.total_tests}` : "—"}
        />
        <Metric label="Score" value={s.max_score > 0 ? `${s.score} / ${s.max_score}` : "—"} />
        <Metric
          label="Max time"
          value={s.execution_time_ms !== null ? `${s.execution_time_ms} ms` : "—"}
        />
        <Metric
          label="Max memory"
          value={s.memory_bytes !== null ? formatBytes(s.memory_bytes) : "—"}
        />
      </dl>

      {s.compile_output?.trim() && (
        <section className="mt-6">
          <h2 className="mb-2 text-base font-semibold text-ink">
            {s.verdict === "COMPILATION_ERROR" ? "Compiler errors" : "Compiler warnings"}
          </h2>
          <pre
            className={`max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface p-3 font-mono text-xs ${
              s.verdict === "COMPILATION_ERROR" ? "text-bad" : "text-warn"
            }`}
          >
            {s.compile_output}
          </pre>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-ink">Test results</h2>
        {!isTerminal(s.status) ? (
          <p className="text-sm text-muted">Results appear once judging finishes.</p>
        ) : results.isPending ? (
          <Spinner label="Loading results…" />
        ) : results.isError ? (
          <ErrorState
            title="Couldn't load the test results"
            message={results.error.message}
            onRetry={() => results.refetch()}
          />
        ) : results.data.results.length === 0 ? (
          <p className="text-sm text-muted">
            No tests were executed for this submission.
          </p>
        ) : (
          <div className="card overflow-x-auto">
            <TestStrip results={results.data.results} />
            <table className="data-table">
              <caption className="sr-only">
                Per-test verdicts. Inputs and expected outputs are not shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Test</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Time</th>
                  <th scope="col">Memory</th>
                  <th scope="col">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {results.data.results.map((r) => (
                  <tr key={r.position}>
                    <td className="font-mono text-muted">#{r.position}</td>
                    <td className="text-muted">
                      {r.is_sample ? "Sample" : "Hidden"}
                    </td>
                    <td>
                      <VerdictBadge status={r.verdict} size="sm" />
                    </td>
                    <td className="font-mono text-muted">
                      {r.execution_time_ms !== null ? `${r.execution_time_ms} ms` : "—"}
                    </td>
                    <td className="font-mono text-muted">
                      {r.memory_bytes !== null ? formatBytes(r.memory_bytes) : "—"}
                    </td>
                    <td className="font-mono text-muted">{r.points_awarded}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {s.source_code !== undefined && (
        <section className="mt-6">
          <h2 className="mb-2 text-base font-semibold text-ink">Submitted code</h2>
          <CodeEditor
            value={s.source_code}
            onChange={() => {}}
            language={MONACO[s.language] ?? "plaintext"}
            readOnly
            label={`${s.language} (read only)`}
            heightClass="h-[24rem]"
          />
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight text-ink">{value}</dd>
    </div>
  );
}

const MONACO: Record<string, string> = { cpp17: "cpp", java21: "java", node22: "javascript" };

type Tone = "good" | "warn" | "bad" | "neutral";

function tone(status: string): Tone {
  if (status === "ACCEPTED") return "good";
  if (status === "COMPILATION_ERROR") return "warn";
  if (status === "QUEUED" || status === "RUNNING" || status === "INTERNAL_ERROR") return "neutral";
  return "bad";
}

const TONE_BORDER: Record<Tone, string> = {
  good: "border-l-good",
  warn: "border-l-warn",
  bad: "border-l-bad",
  neutral: "border-l-line-strong",
};

const TONE_FILL: Record<Tone, string> = { good: "bg-good", warn: "bg-warn", bad: "bg-bad", neutral: "bg-line-strong" };

/** One block per test, coloured by its verdict, so where it failed is visible at a glance. */
function TestStrip({ results }: { results: TestResults["results"] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-3" aria-hidden="true">
      {results.map((r) => (
        <span
          key={r.position}
          title={`Test ${r.position}: ${verdictLabel(r.verdict)}`}
          className={`h-3 w-5 rounded-[4px] ${TONE_FILL[tone(r.verdict)]} ${r.is_sample ? "opacity-70" : ""}`}
        />
      ))}
      <span className="ml-2 text-xs text-faint">
        {results.filter((r) => r.verdict === "ACCEPTED").length} of {results.length} run passed
      </span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      className="btn btn-ghost min-h-[34px] px-3 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? "Copied" : "Copy code"}
    </button>
  );
}
