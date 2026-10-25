import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, Trophy, Target } from "lucide-react";
import { profilesApi } from "../api/endpoints";
import { ErrorState } from "../components/Feedback";
import { Avatar } from "../components/people";
import PageHeader from "../components/PageHeader";

/** Find other people by username or name; each card opens their profile. */
export default function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setParams(text.trim() ? { q: text.trim() } : {}, { replace: true }), 250);
    return () => clearTimeout(t);
  }, [text, setParams]);
  const results = useQuery({
    queryKey: ["people", q],
    queryFn: ({ signal }) => profilesApi.search(q, 24, signal),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Community"
        title="People"
        description="Look someone up to see what they solved and how their contests went."
      />
      <label className="relative block max-w-xl">
        <span className="sr-only">Search people</span>
        <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
        <input
          type="search"
          className="input h-12 pl-11 text-base"
          placeholder="Username or name…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </label>
      {!q ? (
        <p className="text-sm text-faint">Start typing to search. Tip: press ⌘K anywhere to search everything.</p>
      ) : results.isError ? (
        <ErrorState title="Couldn't search" message={results.error.message} onRetry={() => results.refetch()} />
      ) : results.data && results.data.length === 0 ? (
        <p className="card p-6 text-center text-muted">Nobody matches “{q}”.</p>
      ) : (
        <ul className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${results.isPlaceholderData ? "opacity-60" : ""}`} aria-label="People">
          {(results.data ?? []).map((u) => (
            <li key={u.username}>
              <Link to={`/u/${encodeURIComponent(u.username)}`} className="card flex items-center gap-4 p-4 transition-colors hover:border-accent/40 hover:shadow-panel">
                <Avatar username={u.username} url={u.avatar_url} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ink">{u.display_name ?? u.username}</span>
                  <span className="block truncate text-xs text-muted">@{u.username}</span>
                  <span className="mt-1.5 flex gap-3 text-xs text-faint">
                    <span className="flex items-center gap-1">
                      <Target size={12} aria-hidden="true" /> {u.solved} solved
                    </span>
                    <span className="flex items-center gap-1">
                      <Trophy size={12} aria-hidden="true" /> {u.contests} contests
                    </span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
