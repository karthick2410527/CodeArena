import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Markdown, { sourceName } from "../components/Markdown";
import { ApiError } from "../api/client";
import { problemsApi } from "../api/endpoints";
import DifficultyBadge from "../components/DifficultyBadge";
import { EmptyState, ErrorState, Spinner } from "../components/Feedback";
import Workspace from "../components/Workspace";
import SplitPane from "../components/SplitPane";
import { useViewer } from "../auth/AuthContext";
import { UserLink } from "../components/people";
import type { ProblemDetail } from "../api/types";

/**
 * Statement on the left, editor on the right at desktop widths; stacked on a
 * phone, statement first — reading the problem comes before writing code.
 */
export default function ProblemDetailPage() {
  const { slug = "" } = useParams();
  const { ready } = useViewer();
  const query = useQuery({
    queryKey: ["problem", slug],
    queryFn: ({ signal }) => problemsApi.get(slug, signal),
    enabled: ready,
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
      <Link to="/problems" className="text-sm text-muted hover:text-ink">
        ← All problems
      </Link>

      <div className="mt-3">
        <SplitPane left={<ProblemStatement problem={p} />} right={<Workspace problem={p} />} />
      </div>
    </div>
  );
}

function SampleBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-faint">{label}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-surface p-3 font-mono text-sm text-ink">
        {text}
      </pre>
    </div>
  );
}

/** Who wrote it, how many solved it, and where the reader stands. */
export function ProblemFacts({ problem: p }: { problem: ProblemDetail }) {
  return (
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
      {p.status && (
        <div className={p.status === "SOLVED" ? "font-medium text-good" : "font-medium text-warn"}>
          <dt className="sr-only">Your progress</dt>
          <dd>{p.status === "SOLVED" ? "✓ Solved" : "Attempted"}</dd>
        </div>
      )}
      <div className="flex gap-1">
        <dt>Solved by</dt>
        <dd className="tabular text-ink">{p.solved_by}</dd>
      </div>
      <div className="flex gap-1">
        <dt>Acceptance</dt>
        <dd className="tabular text-ink">{p.acceptance_rate === null ? "—" : `${p.acceptance_rate}%`}</dd>
      </div>
      {p.author && (
        <div className="flex gap-1">
          <dt>Author</dt>
          <dd>
            <UserLink username={p.author} />
          </dd>
        </div>
      )}
    </dl>
  );
}

/** The statement, constraints and samples, as the practice page and the contest arena show them. */
export function ProblemStatement({ problem: p, prefix }: { problem: ProblemDetail; prefix?: string }) {
  return (
    <article className="card p-5 sm:p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-ink">
          <span className="mr-2 font-mono text-faint">{prefix ?? `${p.number}.`}</span>
          {p.title}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DifficultyBadge difficulty={p.difficulty} />
          {p.tags.map((t) => (
            <Link
              key={t}
              to={`/problems?tag=${encodeURIComponent(t)}`}
              className="rounded bg-sunken px-2 py-0.5 text-xs text-muted hover:text-ink"
            >
              {t}
            </Link>
          ))}
          <span className="ml-auto font-mono text-xs text-faint">
            {p.time_limit_ms} ms · {p.memory_limit_mb} MB
          </span>
        </div>
        <ProblemFacts problem={p} />
        {p.source_url && (
          <p className="mt-3 text-xs text-faint">
            Originally from{" "}
            <a href={p.source_url} target="_blank" rel="noopener noreferrer" className="font-medium text-muted underline-offset-2 hover:text-ink hover:underline">
              {sourceName(p.source_url)} ↗
            </a>
          </p>
        )}
      </header>

      <div className="md">
        <Markdown>{p.description}</Markdown>
      </div>

      {p.constraints && (
        <section aria-labelledby="constraints-h">
          <h2 id="constraints-h" className="mb-1 mt-6 text-base font-semibold text-ink">
            Constraints
          </h2>
          <div className="md">
            <Markdown>{p.constraints}</Markdown>
          </div>
        </section>
      )}

      <section aria-labelledby="examples-h" className="mt-6">
        <h2 id="examples-h" className="mb-3 text-base font-semibold text-ink">
          Examples
        </h2>
        {p.samples.length === 0 ? (
          <p className="text-sm text-muted">No public examples for this problem.</p>
        ) : (
          <div className="space-y-4">
            {p.samples.map((s, i) => (
              <div key={i} className="rounded-md border border-line bg-paper/60 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
                  Example {i + 1}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SampleBlock label="Input" text={s.input} />
                  <SampleBlock label="Output" text={s.expected_output} />
                </div>
                {s.explanation && (
                  <p className="mt-3 text-sm text-muted">
                    <span className="font-medium text-muted">Explanation: </span>
                    {s.explanation}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {p.editorial && (
        <details className="group mt-6 rounded-xl border border-accent/25 bg-accent/5 p-4">
          <summary className="cursor-pointer list-none text-sm font-medium text-ink">
            <span className="text-accent">Editorial</span>
            <span className="text-muted">
              {" "}
              · from {p.editorial.contest_title}, problem {p.editorial.label}
            </span>
            <span className="ml-2 text-xs text-faint group-open:hidden">(spoiler: click to show)</span>
          </summary>
          <div className="md mt-3">
            <Markdown>{p.editorial.text}</Markdown>
          </div>
          <Link to={`/contests/${p.editorial.contest_slug}/editorial`} className="mt-2 inline-block text-xs text-accent hover:underline">
            The whole contest editorial →
          </Link>
        </details>
      )}

      <p className="mt-6 border-t border-line pt-4 text-xs text-faint">
        Submitting judges your code against hidden test cases as well as these examples.
        Hidden inputs and expected outputs are never shown.
      </p>
    </article>
  );
}
