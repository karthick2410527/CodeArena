import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileCode2, Search, Trophy, UserRound } from "lucide-react";
import { contestsApi, problemsApi, profilesApi } from "../api/endpoints";
import DifficultyBadge from "./DifficultyBadge";
import { PhaseBadge } from "./contest";
import { Avatar } from "./people";

type Hit = { id: string; to: string; group: "People" | "Problems" | "Contests"; node: React.ReactNode };

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Search everything from anywhere: ⌘K / Ctrl+K (or "/") opens it; type to find
 * people, problems and contests; arrows move, Enter opens, Escape closes.
 */
export default function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const term = useDebounced(q.trim(), 180);
  const enabled = open && term.length > 0;

  const people = useQuery({ queryKey: ["search-people", term], queryFn: ({ signal }) => profilesApi.search(term, 5, signal), enabled });
  const problems = useQuery({
    queryKey: ["search-problems", term],
    queryFn: ({ signal }) => problemsApi.list({ page: 1, limit: 5, q: term }, signal),
    enabled,
  });
  const contests = useQuery({ queryKey: ["search-contests", term], queryFn: () => contestsApi.list(undefined, 1, 5, term), enabled });

  const hits: Hit[] = useMemo(() => {
    if (!term) return [];
    return [
      ...(people.data ?? []).map((u) => ({
        id: `u-${u.username}`,
        to: `/u/${encodeURIComponent(u.username)}`,
        group: "People" as const,
        node: (
          <>
            <Avatar username={u.username} url={u.avatar_url} size={26} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-ink">{u.username}</span>
              {u.display_name && <span className="ml-2 text-muted">{u.display_name}</span>}
            </span>
            <span className="text-xs text-faint">{u.solved} solved</span>
          </>
        ),
      })),
      ...(problems.data?.items ?? []).map((p) => ({
        id: `p-${p.slug}`,
        to: `/problems/${p.slug}`,
        group: "Problems" as const,
        node: (
          <>
            <FileCode2 size={16} className="text-faint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-ink">{p.title}</span>
            <DifficultyBadge difficulty={p.difficulty} />
          </>
        ),
      })),
      ...(contests.data?.items ?? []).map((c) => ({
        id: `c-${c.slug}`,
        to: `/contests/${c.slug}`,
        group: "Contests" as const,
        node: (
          <>
            <Trophy size={16} className="text-faint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-ink">{c.title}</span>
            <PhaseBadge phase={c.phase} />
          </>
        ),
      })),
    ];
  }, [term, people.data, problems.data, contests.data]);

  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    if (open) {
      setQ("");
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;
  const loading = enabled && (people.isFetching || problems.isFetching || contests.isFetching);
  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    navigate(h.to);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="panel w-full max-w-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={18} className="shrink-0 text-faint" aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="search-results"
            aria-activedescendant={hits[active] ? `search-${hits[active].id}` : undefined}
            aria-label="Search people, problems and contests"
            className="h-14 w-full bg-transparent text-base text-ink outline-none placeholder:text-faint focus-visible:outline-none"
            placeholder="Search people, problems, contests…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") setActive((a) => Math.min(hits.length - 1, a + 1));
              else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
              else if (e.key === "Enter") go(hits[active]);
              else return;
              e.preventDefault();
            }}
          />
          <kbd className="hidden rounded-md border border-line px-1.5 py-0.5 font-mono text-[0.6875rem] text-faint sm:block">esc</kbd>
        </div>
        <ul id="search-results" role="listbox" aria-label="Results" className="max-h-[60vh] overflow-y-auto p-2">
          {!term && <li className="px-3 py-6 text-center text-sm text-faint">Type a username, a problem or a contest.</li>}
          {term && !loading && hits.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-faint">Nothing matches “{term}”.</li>
          )}
          {hits.map((h, i) => (
            <li key={h.id} role="presentation">
              {(i === 0 || hits[i - 1].group !== h.group) && (
                <p className="px-3 pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-faint first:pt-1">
                  {h.group}
                </p>
              )}
              <div
                id={`search-${h.id}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(h)}
                className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm ${i === active ? "bg-sunken" : ""}`}
              >
                {h.node}
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[0.6875rem] text-faint">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span className="ml-auto flex items-center gap-1">
            <UserRound size={12} aria-hidden="true" /> Looking for someone? Try their username.
          </span>
        </div>
      </div>
    </div>
  );
}

/** Opens the palette on ⌘K / Ctrl+K, or "/" outside a text field. */
export function useSearchShortcut(open: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open]);
}
