import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { ApiError } from "../api/client";
import { problemsApi } from "../api/endpoints";
import DifficultyBadge from "../components/DifficultyBadge";
import { EmptyState, ErrorState, Spinner } from "../components/Feedback";
import Workspace from "../components/Workspace";

/**
 * Statement on the left, editor on the right at desktop widths; stacked on a
 * phone, statement first — reading the problem comes before writing code.
 */
export default function ProblemDetailPage() {
  const { slug = "" } = useParams();
  const query = useQuery({
    queryKey: ["problem", slug],
    queryFn: ({ signal }) => problemsApi.get(slug, signal),
  });

  if (query.isPending) return <Spinner label="Loading problem…" />;

  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <EmptyState
          title="Problem not found"
          message="This problem doesn't exist or is no longer available."
          action={
            <Link to="/problems" className="btn btn-primary">
              Back to problems
            </Link>
          }
        />
      );
    }
    return (
      <ErrorState
        title="Couldn't load this problem"
        message={query.error.message}
        onRetry={() => query.refetch()}
      />
    );
  }

  const p = query.data;
  return (
    <div>
      <Link to="/problems" className="text-sm text-slate-400 hover:text-white">
        ← All problems
      </Link>

      <div className="mt-3 grid items-start gap-6 xl:grid-cols-2">
        <article className="card p-5 sm:p-6">
          <header className="mb-4">
            <h1 className="text-2xl font-bold text-white">
              <span className="mr-2 font-mono text-slate-500">{p.number}.</span>
              {p.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DifficultyBadge difficulty={p.difficulty} />
              {p.tags.map((t) => (
                <Link
                  key={t}
                  to={`/problems?tag=${encodeURIComponent(t)}`}
                  className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200"
                >
                  {t}
                </Link>
              ))}
              <span className="ml-auto font-mono text-xs text-slate-500">
                {p.time_limit_ms} ms · {p.memory_limit_mb} MB
              </span>
            </div>
          </header>

          <div className="md">
            <ReactMarkdown>{p.description}</ReactMarkdown>
          </div>

          {p.constraints && (
            <section aria-labelledby="constraints-h">
              <h2 id="constraints-h" className="mb-1 mt-6 text-base font-semibold text-white">
                Constraints
              </h2>
              <div className="md">
                <ReactMarkdown>{p.constraints}</ReactMarkdown>
              </div>
            </section>
          )}

          <section aria-labelledby="examples-h" className="mt-6">
            <h2 id="examples-h" className="mb-3 text-base font-semibold text-white">
              Examples
            </h2>
            {p.samples.length === 0 ? (
              <p className="text-sm text-slate-400">No public examples for this problem.</p>
            ) : (
              <div className="space-y-4">
                {p.samples.map((s, i) => (
                  <div key={i} className="rounded-md border border-slate-800 bg-slate-950/60 p-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Example {i + 1}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <SampleBlock label="Input" text={s.input} />
                      <SampleBlock label="Output" text={s.expected_output} />
                    </div>
                    {s.explanation && (
                      <p className="mt-3 text-sm text-slate-400">
                        <span className="font-medium text-slate-300">Explanation: </span>
                        {s.explanation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <p className="mt-6 border-t border-slate-800 pt-4 text-xs text-slate-500">
            Submitting judges your code against hidden test cases as well as these examples.
            Hidden inputs and expected outputs are never shown.
          </p>
        </article>

        <div className="xl:sticky xl:top-20">
          <Workspace problem={p} />
        </div>
      </div>
    </div>
  );
}

function SampleBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-slate-500">{label}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-slate-900 p-3 font-mono text-sm text-slate-100">
        {text}
      </pre>
    </div>
  );
}
