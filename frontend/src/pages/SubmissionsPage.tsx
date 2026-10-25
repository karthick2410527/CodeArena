import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { authApi, submissionsApi } from "../api/endpoints";
import { TERMINAL_VERDICTS, type SubmissionFilters } from "../api/types";
import { EmptyState, ErrorState } from "../components/Feedback";
import Pagination from "../components/Pagination";
import PageHeader, { HeaderStat } from "../components/PageHeader";
import VerdictBadge, { verdictLabel } from "../components/VerdictBadge";
import { formatBytes } from "../components/Workspace";

const PAGE_SIZE = 15;
/** The verdicts people filter by most, one click each; the select has them all. */
const QUICK: [string, string][] = [
  ["", "All"],
  ["ACCEPTED", "Accepted"],
  ["WRONG_ANSWER", "Wrong"],
  ["TIME_LIMIT_EXCEEDED", "Too slow"],
  ["RUNTIME_ERROR", "Crashed"],
  ["COMPILATION_ERROR", "Didn't compile"],
];

/** The row's left edge, coloured by outcome. */
function EDGE(status: string) {
  if (status === "ACCEPTED") return "border-l-good";
  if (status === "QUEUED" || status === "RUNNING" || status === "INTERNAL_ERROR") return "border-l-line";
  if (status === "COMPILATION_ERROR") return "border-l-warn";
  return "border-l-bad";
}
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

  const stats = useQuery({ queryKey: ["stats"], queryFn: () => authApi.stats() });
  const hasFilters = Boolean(verdict || problem);

  return (
    <div>
      <PageHeader
        eyebrow="Practice"
        title="Your submissions"
        description="Every submission you have made, newest first. Pending ones update by themselves."
        actions={
          <Link to="/problems" className="btn btn-outline">
            Find a problem
          </Link>
        }
      >
        {stats.data && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <HeaderStat label="Submissions" value={stats.data.total_submissions} />
            <HeaderStat label="Accepted" value={stats.data.accepted_submissions} tone="good" />
            <HeaderStat label="Acceptance" value={`${stats.data.acceptance_rate}%`} />
            <HeaderStat label="Problems solved" value={stats.data.problems_solved} />
          </div>
        )}
      </PageHeader>

      <div className="card mb-5 flex flex-wrap items-center gap-3 p-3">
        <label className="relative block min-w-[14rem] flex-1">
          <span className="sr-only">Filter by problem slug</span>
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="search"
            className="input pl-10"
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
        </label>
        <div className="segmented" role="group" aria-label="Quick verdict filter">
          {QUICK.map(([v, label]) => (
            <button key={label} type="button" aria-pressed={(verdict ?? "") === v} onClick={() => update({ verdict: v || undefined })}>
              {label}
            </button>
          ))}
        </div>
        <select
          className="input w-auto min-w-[11rem]"
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
          {/* Columns at desktop width, stacked on a phone. */}
          <div className="card overflow-hidden">
            <div
              className="hidden grid-cols-[minmax(0,1fr)_8rem_6rem_5rem_10rem] gap-3 border-b border-line bg-paper/50 px-5 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-faint lg:grid xl:grid-cols-[minmax(0,1fr)_8rem_6rem_5rem_5.5rem_10rem]"
              aria-hidden="true"
            >
              <span>Problem</span>
              <span>Verdict</span>
              <span>Tests</span>
              <span>Time</span>
              <span className="hidden xl:block">Memory</span>
              <span className="text-right">When</span>
            </div>
            <ul className="divide-y divide-line/70" aria-label="Submissions">
              {list.data.items.map((s) => (
                <li key={s.submission_id}>
                  <Link
                    to={`/submissions/${s.submission_id}`}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-l-[3px] px-5 py-3 transition hover:bg-sunken/40 lg:grid-cols-[minmax(0,1fr)_8rem_6rem_5rem_10rem] xl:grid-cols-[minmax(0,1fr)_8rem_6rem_5rem_5.5rem_10rem] ${EDGE(s.status)}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{s.problem_title}</span>
                      <span className="mt-0.5 block font-mono text-[0.6875rem] text-faint">{s.language}</span>
                    </span>
                    <span>
                      <VerdictBadge status={s.status} size="sm" />
                    </span>
                    <span className="flex items-center gap-2 font-mono text-xs text-muted">
                      {s.total_tests > 0 ? (
                        <>
                          <span className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-line/70 sm:block" aria-hidden="true">
                            <span
                              className={`block h-full rounded-full ${s.passed_tests === s.total_tests ? "bg-good" : "bg-bad/70"}`}
                              style={{ width: `${(s.passed_tests / s.total_tests) * 100}%` }}
                            />
                          </span>
                          {s.passed_tests}/{s.total_tests}
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                    <span className="font-mono text-xs text-muted">{s.execution_time_ms !== null ? `${s.execution_time_ms} ms` : "—"}</span>
                    <span className="hidden font-mono text-xs text-muted xl:block">{s.memory_bytes !== null ? formatBytes(s.memory_bytes) : "—"}</span>
                    <span className="text-xs text-faint lg:text-right">{new Date(s.created_at).toLocaleString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-3 text-right text-xs text-faint">
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
    <div role="status" aria-label="Loading submissions" className="card divide-y divide-line">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-4 py-4">
          <div className="h-4 w-1/3 animate-pulse rounded bg-sunken" />
          <div className="h-5 w-24 animate-pulse rounded-full bg-sunken" />
        </div>
      ))}
    </div>
  );
}
