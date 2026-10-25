import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { contestsApi } from "../api/endpoints";
import { useViewer } from "../auth/AuthContext";
import { formatClock, useNow } from "./contest";

/**
 * "Your contest is live": shown on every page except the contest itself (and the contests list) while
 * a contest you registered for (or author) is running, so it is always one
 * click back to the arena.
 */
export default function LiveContestBanner() {
  const { ready, signedIn } = useViewer();
  const { pathname } = useLocation();
  const now = useNow();
  const running = useQuery({
    queryKey: ["contests", "running"],
    queryFn: () => contestsApi.list("running"),
    enabled: ready && signedIn,
    refetchInterval: 60_000,
  });
  const mine = (running.data?.items ?? []).filter(
    (c) => (c.registered || c.my_role) && new Date(c.ends_at).getTime() > now && !pathname.startsWith(`/contests/${c.slug}`),
  );
  // The contests page already features what is live.
  if (mine.length === 0 || pathname === "/contests") return null;
  const c = mine[0];
  return (
    <Link
      to={`/contests/${c.slug}`}
      className="group mb-5 flex items-center gap-3 rounded-2xl border border-good/30 bg-good/10 px-4 py-2.5 text-sm transition hover:bg-good/15"
    >
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-good" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold text-ink">{c.title}</span>
        <span className="text-muted"> is live · </span>
        <span className="font-mono text-ink">{formatClock(new Date(c.ends_at).getTime() - now)}</span>
        <span className="text-muted"> left</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 font-medium text-good">
        {c.my_role ? "Open" : "Enter the arena"} <ArrowRight size={15} className="transition group-hover:translate-x-0.5" aria-hidden="true" />
      </span>
    </Link>
  );
}
