import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { submissionsApi } from "../api/endpoints";
import { isTerminal } from "../api/types";
import CodeEditor from "../components/CodeEditor";
import { EmptyState, ErrorState, Spinner } from "../components/Feedback";
import VerdictBadge from "../components/VerdictBadge";
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
      <Link to="/submissions" className="text-sm text-slate-400 hover:text-white">
        ← Your submissions
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">
            <Link to={`/problems/${s.problem_slug}`} className="hover:underline">
              {s.problem_title}
            </Link>
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            by {s.username} · {new Date(s.created_at).toLocaleString()}
          </p>
        </div>
        <VerdictBadge status={s.status} />
      </header>

      {s.message && (
        <p className="mt-4 rounded-md border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-300">
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
          <h2 className="mb-2 text-base font-semibold text-white">
            {s.verdict === "COMPILATION_ERROR" ? "Compiler errors" : "Compiler warnings"}
          </h2>
          <pre
            className={`max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-slate-900 p-3 font-mono text-xs ${
              s.verdict === "COMPILATION_ERROR" ? "text-rose-200" : "text-amber-200"
            }`}
          >
            {s.compile_output}
          </pre>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-white">Test results</h2>
        {!isTerminal(s.status) ? (
          <p className="text-sm text-slate-400">Results appear once judging finishes.</p>
        ) : results.isPending ? (
          <Spinner label="Loading results…" />
        ) : results.isError ? (
          <ErrorState
            title="Couldn't load the test results"
            message={results.error.message}
            onRetry={() => results.refetch()}
          />
        ) : results.data.results.length === 0 ? (
          <p className="text-sm text-slate-400">
            No tests were executed for this submission.
          </p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Per-test verdicts. Inputs and expected outputs are not shown.
              </caption>
              <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2">Test</th>
                  <th scope="col" className="px-4 py-2">Kind</th>
                  <th scope="col" className="px-4 py-2">Verdict</th>
                  <th scope="col" className="px-4 py-2">Time</th>
                  <th scope="col" className="px-4 py-2">Memory</th>
                  <th scope="col" className="px-4 py-2">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {results.data.results.map((r) => (
                  <tr key={r.position}>
                    <td className="px-4 py-2 font-mono text-slate-400">#{r.position}</td>
                    <td className="px-4 py-2 text-slate-400">
                      {r.is_sample ? "Sample" : "Hidden"}
                    </td>
                    <td className="px-4 py-2">
                      <VerdictBadge status={r.verdict} size="sm" />
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-400">
                      {r.execution_time_ms !== null ? `${r.execution_time_ms} ms` : "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-400">
                      {r.memory_bytes !== null ? formatBytes(r.memory_bytes) : "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-400">{r.points_awarded}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {s.source_code !== undefined && (
        <section className="mt-6">
          <h2 className="mb-2 text-base font-semibold text-white">Submitted code</h2>
          <CodeEditor
            value={s.source_code}
            onChange={() => {}}
            language="cpp"
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
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 font-mono text-lg text-slate-100">{value}</dd>
    </div>
  );
}
