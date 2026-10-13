import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { adminApi } from "../../api/endpoints";
import DifficultyBadge from "../../components/DifficultyBadge";
import { EmptyState, ErrorState } from "../../components/Feedback";
import Pagination from "../../components/Pagination";

const PAGE_SIZE = 15;

/** Admin catalogue: every problem, published or not. */
export default function AdminProblemsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const published = params.get("published");
  const q = params.get("q") ?? undefined;
  const [search, setSearch] = useState(q ?? "");

  const update = (changes: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setParams(next);
  };

  const filters = {
    page,
    limit: PAGE_SIZE,
    published: published === null ? undefined : published === "true",
    q,
  };
  const list = useQuery({
    queryKey: ["admin-problems", filters],
    queryFn: () => adminApi.listProblems(filters),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Problems</h1>
          <p className="mt-1 text-sm text-slate-400">
            Create, edit and publish problems, and manage their test cases.
          </p>
        </div>
        <Link to="/admin/problems/new" className="btn btn-primary">
          New problem
        </Link>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-[1fr_auto]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() || undefined });
          }}
        >
          <input
            type="search"
            className="input"
            aria-label="Search problems by title or slug"
            placeholder="Search by title or slug…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <select
          className="input sm:w-44"
          aria-label="Filter by publication state"
          value={published ?? ""}
          onChange={(e) => update({ published: e.target.value || undefined })}
        >
          <option value="">All problems</option>
          <option value="true">Published</option>
          <option value="false">Unpublished</option>
        </select>
      </div>

      {list.isPending ? (
        <div role="status" aria-label="Loading problems" className="card divide-y divide-slate-800">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse bg-slate-800/40" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState
          title="Couldn't load problems"
          message={list.error.message}
          onRetry={() => list.refetch()}
        />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title="No problems found"
          message="Nothing matches these filters."
          action={
            <Link to="/admin/problems/new" className="btn btn-primary">
              Create one
            </Link>
          }
        />
      ) : (
        <div className={list.isPlaceholderData ? "opacity-60" : undefined}>
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2">#</th>
                  <th scope="col" className="px-4 py-2">Title</th>
                  <th scope="col" className="px-4 py-2">Difficulty</th>
                  <th scope="col" className="px-4 py-2">Tests</th>
                  <th scope="col" className="px-4 py-2">Subs</th>
                  <th scope="col" className="px-4 py-2">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {list.data.items.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/40">
                    <td className="px-4 py-2 font-mono text-slate-500">{p.number}</td>
                    <td className="px-4 py-2">
                      <Link
                        to={`/admin/problems/${p.id}`}
                        className="font-medium text-slate-100 hover:underline"
                      >
                        {p.title}
                      </Link>
                      <div className="font-mono text-xs text-slate-500">{p.slug}</div>
                    </td>
                    <td className="px-4 py-2">
                      <DifficultyBadge difficulty={p.difficulty} />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">
                      {p.sample_count} sample / {p.hidden_count} hidden
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">
                      {p.submission_count}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
                          p.published
                            ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                            : "bg-slate-500/15 text-slate-300 ring-slate-500/30"
                        }`}
                      >
                        {p.published ? "Published" : "Draft"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
