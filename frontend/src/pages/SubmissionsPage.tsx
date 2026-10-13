import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { submissionsApi } from "../api/endpoints";
import { TERMINAL_VERDICTS, type SubmissionFilters } from "../api/types";
import { EmptyState, ErrorState } from "../components/Feedback";
import Pagination from "../components/Pagination";
import VerdictBadge, { verdictLabel } from "../components/VerdictBadge";
import { formatBytes } from "../components/Workspace";

const PAGE_SIZE = 15;
/** Lifecycle states are useful filters alongside the terminal verdicts. */
const STATUS_OPTIONS = ["QUEUED", "RUNNING", ...TERMINAL_VERDICTS];

export default function SubmissionsPage() {
  // Filters live in the URL so a filtered history can be bookmarked and shared.
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const verdict = params.get("verdict") ?? undefined;
  const problem = params.get("problem") ?? undefined;

  const update = (changes: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setParams(next);
  };

  const filters: SubmissionFilters = { page, limit: PAGE_SIZE, verdict, problem };
  const list = useQuery({
    queryKey: ["submissions", filters],
    queryFn: ({ signal }) => submissionsApi.list(filters, signal),
    placeholderData: keepPreviousData,
    // A queued submission becomes a verdict without the user doing anything.
    refetchInterval: (query) =>
      query.state.data?.items.some((s) => s.status === "QUEUED" || s.status === "RUNNING")
        ? 2000
        : false,
  });

  const hasFilters = Boolean(verdict || problem);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Your submissions</h1>
        <p className="mt-1 text-sm text-slate-400">
          Every submission you have made, newest first.
        </p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-[1fr_auto]">
        <input
          type="search"
          className="input"
          aria-label="Filter by problem slug"
          placeholder="Filter by problem slug, e.g. a-plus-b"
          defaultValue={problem ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              update({ problem: (e.target as HTMLInputElement).value.trim() || undefined });
            }
          }}
          onBlur={(e) => update({ problem: e.target.value.trim() || undefined })}
        />
        <select
          className="input sm:w-56"
          aria-label="Filter by verdict"
          value={verdict ?? ""}
          onChange={(e) => update({ verdict: e.target.value || undefined })}
        >
          <option value="">All verdicts</option>
          {STATUS_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {verdictLabel(v)}
            </option>
          ))}
        </select>
      </div>

      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <ErrorState
          title="Couldn't load your submissions"
          message={list.error.message}
          onRetry={() => list.refetch()}
        />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title="No submissions yet"
          message={
            hasFilters
              ? "Nothing matches these filters."
              : "Solve a problem and your submissions will appear here."
          }
          action={
            hasFilters ? (
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setParams(new URLSearchParams())}
              >
                Clear filters
              </button>
            ) : (
              <Link to="/problems" className="btn btn-primary">
                Browse problems
              </Link>
            )
          }
        />
      ) : (
        <div className={list.isPlaceholderData ? "opacity-60 transition" : "transition"}>
          {/* A table at desktop width, cards on a phone. */}
          <ul className="card divide-y divide-slate-800 overflow-hidden" aria-label="Submissions">
            {list.data.items.map((s) => (
              <li key={s.submission_id}>
                <Link
                  to={`/submissions/${s.submission_id}`}
                  className="flex flex-col gap-2 px-4 py-3 transition hover:bg-slate-800/50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-100">{s.problem_title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {new Date(s.created_at).toLocaleString()} · {s.language}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {s.total_tests > 0 && (
                      <span className="font-mono text-xs text-slate-500">
                        {s.passed_tests}/{s.total_tests}
                      </span>
                    )}
                    {s.execution_time_ms !== null && (
                      <span className="font-mono text-xs text-slate-500">
                        {s.execution_time_ms} ms
                      </span>
                    )}
                    {s.memory_bytes !== null && (
                      <span className="font-mono text-xs text-slate-500">
                        {formatBytes(s.memory_bytes)}
                      </span>
                    )}
                    <VerdictBadge status={s.status} size="sm" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-right text-xs text-slate-500">
            {list.data.total} submission{list.data.total === 1 ? "" : "s"}
          </div>
          <Pagination
            page={list.data.page}
            totalPages={list.data.total_pages}
            onChange={(p) => update({ page: p > 1 ? String(p) : undefined }, false)}
          />
        </div>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading submissions" className="card divide-y divide-slate-800">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-4 py-4">
          <div className="h-4 w-1/3 animate-pulse rounded bg-slate-800" />
          <div className="h-5 w-24 animate-pulse rounded-full bg-slate-800" />
        </div>
      ))}
    </div>
  );
}
