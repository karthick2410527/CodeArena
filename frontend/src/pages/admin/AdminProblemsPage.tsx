import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { authoring, type AuthoringScope } from "./authoring";
import { PenSquare, Plus, Search } from "lucide-react";
import { HostTabs } from "../../components/ContestHub";
import PageHeader from "../../components/PageHeader";
import DifficultyBadge from "../../components/DifficultyBadge";
import { EmptyState, ErrorState } from "../../components/Feedback";
import Pagination from "../../components/Pagination";

const PAGE_SIZE = 15;

/** Admin catalogue: every problem, published or not. */
export default function AdminProblemsPage({ scope = "admin" }: { scope?: AuthoringScope }) {
  const { api, base } = authoring(scope);
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
    queryKey: ["admin-problems", scope, filters],
    queryFn: () => api.listProblems(filters),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      {scope === "studio" && <HostTabs />}
      <PageHeader
        eyebrow={scope === "studio" ? "Host" : "Admin"}
        title={scope === "studio" ? "My problems" : "Problems"}
        description={
          scope === "studio"
            ? "Write problems for the contests you host, or import them from Codeforces or AtCoder. They join the practice set when their contest ends."
            : "Create, edit and publish problems, and manage their test cases."
        }
        actions={
          <>
            {scope === "studio" && (
              <Link to="/host" className="btn btn-outline">
                Hosted contests
              </Link>
            )}
            <Link to={`${base}/new`} className="btn btn-primary">
              <Plus size={16} aria-hidden="true" /> New problem
            </Link>
          </>
        }
      />

      <div className="card mb-5 grid gap-3 p-3 sm:grid-cols-[1fr_auto]">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() || undefined });
          }}
        >
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="search"
            className="input pl-10"
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
        <div role="status" aria-label="Loading problems" className="card divide-y divide-line">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse bg-sunken/40" />
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
          icon={<PenSquare size={22} />}
          title={search || published ? "No problems found" : scope === "studio" ? "Write your first problem" : "No problems found"}
          message={
            search || published
              ? "Nothing matches these filters."
              : scope === "studio"
                ? "A statement, a few samples and some hidden tests. Then put it in a contest or publish it."
                : "Nothing matches these filters."
          }
          action={
            <Link to={`${base}/new`} className="btn btn-primary">
              Create one
            </Link>
          }
        />
      ) : (
        <div className={list.isPlaceholderData ? "opacity-60" : undefined}>
          <div className="card overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Title</th>
                  <th scope="col">Difficulty</th>
                  <th scope="col">Tests</th>
                  <th scope="col">Subs</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono text-faint">{p.number}</td>
                    <td>
                      <Link
                        to={`${base}/${p.id}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {p.title}
                      </Link>
                      <div className="font-mono text-xs text-faint">
                        {p.slug}
                        {p.contests.length > 0 && <span className="chip ml-2 font-sans">in {p.contests.length} contest{p.contests.length === 1 ? "" : "s"}</span>}
                      </div>
                    </td>
                    <td>
                      <DifficultyBadge difficulty={p.difficulty} />
                    </td>
                    <td className="font-mono text-xs text-muted">
                      {p.sample_count} sample / {p.hidden_count} hidden
                    </td>
                    <td className="font-mono text-xs text-muted">
                      {p.submission_count}
                    </td>
                    <td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
                          p.published
                            ? "bg-good/15 text-good ring-good/30"
                            : "bg-sunken text-muted ring-line-strong/30"
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
