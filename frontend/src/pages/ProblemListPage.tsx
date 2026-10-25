import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Search, Users, X } from "lucide-react";
import { authApi, problemsApi } from "../api/endpoints";
import type { Difficulty, ProblemFilters, ProblemSummary, UserStats } from "../api/types";
import { useViewer } from "../auth/AuthContext";
import DifficultyBadge from "../components/DifficultyBadge";
import { EmptyState, ErrorState } from "../components/Feedback";
import Pagination from "../components/Pagination";
import { Eyebrow } from "../components/ui";

const PAGE_SIZE = 20;
const DIFFICULTIES: Difficulty[] = ["EASY", "MEDIUM", "HARD"];
const STATUSES = ["solved", "attempted", "unsolved"] as const;
const SORTS = [
  ["number", "Number"],
  ["difficulty", "Difficulty"],
  ["solved", "Most solved"],
  ["newest", "Newest"],
] as const;

function pick<T extends string>(options: readonly T[], v: string | null): T | undefined {
  return options.find((o) => o === v);
}

/**
 * The practice set as a dashboard: your progress at the top, then every
 * problem with your status, how many people solved it and how often
 * submissions are accepted. Filters live in the URL so a view can be shared.
 */
export default function ProblemListPage() {
  const { ready, signedIn } = useViewer();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const difficulty = pick(DIFFICULTIES, params.get("difficulty"));
  const tag = params.get("tag") ?? undefined;
  const q = params.get("q") ?? undefined;
  const status = signedIn ? pick(STATUSES, params.get("status")) : undefined;
  const sort = pick(SORTS.map(([k]) => k), params.get("sort"));

  const [searchText, setSearchText] = useState(q ?? "");

  const update = (changes: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setParams(next);
  };

  // Debounce typing in the search box before it hits the API.
  useEffect(() => {
    if ((searchText.trim() || undefined) === q) return;
    const t = setTimeout(() => update({ q: searchText.trim() || undefined }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const filters: ProblemFilters = { page, limit: PAGE_SIZE, difficulty, tag, q, status, sort };
  const list = useQuery({
    queryKey: ["problems", filters, signedIn],
    queryFn: ({ signal }) => problemsApi.list(filters, signal),
    placeholderData: keepPreviousData,
    enabled: ready,
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => problemsApi.tags(), staleTime: 5 * 60_000 });
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => authApi.stats(), enabled: signedIn });

  const hasFilters = Boolean(difficulty || tag || q || status);
  const clearFilters = () => {
    setSearchText("");
    setParams(new URLSearchParams());
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Eyebrow>Practice</Eyebrow>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">Problems</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Pick a problem, run it against the samples, submit for a verdict. Community problems join this list
            when their contest ends.
          </p>
        </div>
        {signedIn && stats.data && <Progress stats={stats.data} />}
      </header>

      <section className="card space-y-3 p-3 sm:p-4" aria-label="Filters">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <label className="relative block">
            <span className="sr-only">Search problems</span>
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              type="search"
              className="input pl-10"
              placeholder="Search problems by title…"
              aria-label="Search problems"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </label>
          <select
            className="input md:w-40"
            aria-label="Filter by difficulty"
            value={difficulty ?? ""}
            onChange={(e) => update({ difficulty: e.target.value || undefined })}
          >
            <option value="">All difficulties</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d[0] + d.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          {signedIn && (
            <select
              className="input md:w-40"
              aria-label="Filter by your progress"
              value={status ?? ""}
              onChange={(e) => update({ status: e.target.value || undefined })}
            >
              <option value="">Any progress</option>
              <option value="solved">Solved</option>
              <option value="attempted">Attempted</option>
              <option value="unsolved">Not solved</option>
            </select>
          )}
          <select
            className="input md:w-40"
            aria-label="Sort problems"
            value={sort ?? "number"}
            onChange={(e) => update({ sort: e.target.value === "number" ? undefined : e.target.value })}
          >
            {SORTS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {(tags.data?.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag">
            {tags.data!.map((t) => {
              const on = tag === t.name;
              return (
                <button
                  key={t.name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ tag: on ? undefined : t.name })}
                  className={`chip transition ${
                    on ? "border-accent/40 bg-accent/10 text-accent" : "hover:border-line-strong hover:text-ink"
                  }`}
                >
                  {t.name}
                  <span className="text-faint">{t.count}</span>
                </button>
              );
            })}
            {hasFilters && (
              <button type="button" className="btn-ghost ml-auto min-h-[28px] px-2 text-xs" onClick={clearFilters}>
                <X size={13} /> Clear
              </button>
            )}
          </div>
        )}
      </section>

      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <ErrorState title="Couldn't load problems" message={list.error.message} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title="No problems found"
          message={hasFilters ? "Nothing matches your filters." : "There are no problems yet."}
          action={
            hasFilters ? (
              <button type="button" className="btn btn-outline" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className={list.isPlaceholderData ? "opacity-60 transition" : "transition"}>
          <div className="card overflow-hidden">
            <div
              className="hidden grid-cols-[2rem_3rem_minmax(0,1fr)_7rem_6rem_6rem] gap-3 border-b border-line/70 bg-paper/40 px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-faint md:grid"
              aria-hidden="true"
            >
              <span />
              <span>#</span>
              <span>Title</span>
              <span>Difficulty</span>
              <span className="text-right">Solved by</span>
              <span className="text-right">Accepted</span>
            </div>
            <ul className="divide-y divide-line/70" aria-label="Problem list">
              {list.data.items.map((p) => (
                <ProblemRow key={p.slug} p={p} />
              ))}
            </ul>
          </div>
          <div className="mt-3 text-right text-xs text-faint">{list.data.total} problems</div>
          <Pagination
            page={list.data.page}
            totalPages={list.data.total_pages}
            onChange={(n) => update({ page: n > 1 ? String(n) : undefined }, false)}
          />
        </div>
      )}
    </div>
  );
}

function ProblemRow({ p }: { p: ProblemSummary }) {
  return (
    <li>
      <Link
        to={`/problems/${p.slug}`}
        className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 transition hover:bg-sunken/50 md:grid-cols-[2rem_3rem_minmax(0,1fr)_7rem_6rem_6rem]"
      >
        <StatusIcon status={p.status} />
        <span className="hidden font-mono text-sm text-faint md:block">{p.number}</span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-ink">{p.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {p.tags.map((t) => (
              <span key={t} className="rounded-md bg-sunken px-1.5 py-0.5 text-[0.6875rem] text-muted">
                {t}
              </span>
            ))}
            {p.author && <span className="text-[0.6875rem] text-faint">by {p.author}</span>}
          </span>
        </span>
        <span>
          <DifficultyBadge difficulty={p.difficulty} />
        </span>
        <span className="col-start-2 flex items-center gap-1 text-xs text-muted md:col-start-auto md:justify-end">
          <Users size={13} aria-hidden="true" />
          <span className="tabular">{p.solved_by}</span>
          <span className="sr-only">solved</span>
        </span>
        <span className="hidden text-right text-xs tabular text-muted md:block">
          {p.acceptance_rate === null ? "—" : `${p.acceptance_rate}%`}
        </span>
      </Link>
    </li>
  );
}

function StatusIcon({ status }: { status: ProblemSummary["status"] }) {
  if (status === "SOLVED") {
    return (
      <span title="Solved" className="text-good">
        <CheckCircle2 size={17} aria-hidden="true" />
        <span className="sr-only">Solved</span>
      </span>
    );
  }
  if (status === "ATTEMPTED") {
    return (
      <span title="Attempted" className="text-warn">
        <CircleDashed size={17} aria-hidden="true" />
        <span className="sr-only">Attempted</span>
      </span>
    );
  }
  return <span aria-hidden="true" />;
}

/** "Solved 4 of 10" with a bar per difficulty. */
function Progress({ stats: s }: { stats: UserStats }) {
  const rows: [string, number, number, string][] = [
    ["Easy", s.solved_easy, s.available_easy, "bg-good"],
    ["Medium", s.solved_medium, s.available_medium, "bg-warn"],
    ["Hard", s.solved_hard, s.available_hard, "bg-bad"],
  ];
  return (
    <section className="card w-full p-4 lg:w-[26rem]" aria-label="Your progress">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-muted">
          Solved <span className="font-display text-2xl font-semibold text-ink">{s.problems_solved}</span>
          <span className="text-faint"> / {s.problems_available}</span>
        </p>
        <p className="text-xs text-faint">{s.acceptance_rate}% accepted</p>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        {rows.map(([label, done, total, color]) => (
          <div key={label}>
            <div className="mb-1 flex justify-between text-[0.6875rem] text-muted">
              <span>{label}</span>
              <span className="tabular">
                {done}/{total}
              </span>
            </div>
            <div className="progress-track">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading problems" className="card divide-y divide-line">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-4 py-4">
          <div className="h-4 w-1/2 animate-pulse rounded bg-sunken" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-sunken" />
        </div>
      ))}
    </div>
  );
}
