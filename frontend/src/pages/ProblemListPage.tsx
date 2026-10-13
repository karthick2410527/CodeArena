import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { problemsApi } from "../api/endpoints";
import type { Difficulty, ProblemFilters } from "../api/types";
import DifficultyBadge from "../components/DifficultyBadge";
import { EmptyState, ErrorState } from "../components/Feedback";
import Pagination from "../components/Pagination";

const PAGE_SIZE = 8;
const DIFFICULTIES: Difficulty[] = ["EASY", "MEDIUM", "HARD"];

function parseDifficulty(v: string | null): Difficulty | undefined {
  return DIFFICULTIES.find((d) => d === v);
}

export default function ProblemListPage() {
  // Filters live in the URL so they survive reloads and can be shared.
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const difficulty = parseDifficulty(params.get("difficulty"));
  const tag = params.get("tag") ?? undefined;
  const q = params.get("q") ?? undefined;

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

  const filters: ProblemFilters = { page, limit: PAGE_SIZE, difficulty, tag, q };
  const list = useQuery({
    queryKey: ["problems", filters],
    queryFn: ({ signal }) => problemsApi.list(filters, signal),
    placeholderData: keepPreviousData,
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => problemsApi.tags(), staleTime: 5 * 60_000 });

  const hasFilters = Boolean(difficulty || tag || q);
  const clearFilters = () => {
    setSearchText("");
    setParams(new URLSearchParams());
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Problems</h1>
        <p className="mt-1 text-sm text-slate-400">Pick a problem and sharpen your skills.</p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input
          type="search"
          className="input"
          placeholder="Search problems by title…"
          aria-label="Search problems"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <select
          className="input sm:w-40"
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
        <select
          className="input sm:w-44"
          aria-label="Filter by tag"
          value={tag ?? ""}
          onChange={(e) => update({ tag: e.target.value || undefined })}
        >
          <option value="">All tags</option>
          {(tags.data ?? []).map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.count})
            </option>
          ))}
        </select>
      </div>

      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <ErrorState
          title="Couldn't load problems"
          message={list.error.message}
          onRetry={() => list.refetch()}
        />
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
          <ul className="card divide-y divide-slate-800 overflow-hidden" aria-label="Problem list">
            {list.data.items.map((p) => (
              <li key={p.slug}>
                <Link
                  to={`/problems/${p.slug}`}
                  className="flex flex-col gap-2 px-4 py-3 transition hover:bg-slate-800/50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="w-8 shrink-0 text-right font-mono text-sm text-slate-500">{p.number}</span>
                    <span className="truncate font-medium text-slate-100">{p.title}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-11 sm:pl-0">
                    {p.tags.map((t) => (
                      <span key={t} className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                        {t}
                      </span>
                    ))}
                    <DifficultyBadge difficulty={p.difficulty} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-right text-xs text-slate-500">{list.data.total} problems</div>
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
    <div role="status" aria-label="Loading problems" className="card divide-y divide-slate-800">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-4 py-4">
          <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-slate-800" />
        </div>
      ))}
    </div>
  );
}
