import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, BookOpen, CalendarClock, Check, History, Medal, Search, Settings2, Ticket, Trophy, Users } from "lucide-react";
import { ApiError } from "../../api/client";
import { contestsApi } from "../../api/endpoints";
import type { ContestFormat, ContestSummary, JoinedContest } from "../../api/types";
import { useViewer } from "../../auth/AuthContext";
import { AvatarStack, RollingClock, Spotlight } from "../../components/flair";
import { Countdown, FORMAT_HELP, FORMAT_LABELS, PhaseBadge, formatDuration, formatWhen, livePhase, useNow } from "../../components/contest";
import { ErrorState, Spinner } from "../../components/Feedback";
import Pagination from "../../components/Pagination";

type Tab = "upcoming" | "past" | "mine";

/**
 * Contests, like an events app: the round to act on as a ticket, what is
 * coming up on a timeline, what has ended, and yours.
 */
export default function ContestsPage() {
  const { ready, signedIn } = useViewer();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "past" ? "past" : params.get("tab") === "mine" && signedIn ? "mine" : "upcoming";
  const go = (t: Tab) => setParams(t === "upcoming" ? {} : { tab: t }, { replace: true });

  const running = useQuery({ queryKey: ["contests", "running"], queryFn: () => contestsApi.list("running"), enabled: ready });
  const upcoming = useQuery({ queryKey: ["contests", "upcoming", "all"], queryFn: () => contestsApi.list("upcoming"), enabled: ready });
  const joined = useQuery({ queryKey: ["joined-contests"], queryFn: () => contestsApi.joined(), enabled: ready && signedIn });

  const live = running.data?.items ?? [];
  const soon = upcoming.data?.items ?? [];
  const mineAhead = (joined.data ?? []).filter((j) => new Date(j.contest.ends_at).getTime() > now);
  // The round to act on: one that is live, else your next, else the next anyone can join.
  const featured = live[0] ?? mineAhead[0]?.contest ?? soon[0];

  const tabs: [Tab, string, number | undefined][] = [
    ["upcoming", "Upcoming", running.data && upcoming.data ? live.length + soon.length : undefined],
    ["past", "Past", undefined],
    ...(signedIn ? ([["mine", "My contests", joined.data?.length]] as [Tab, string, number | undefined][]) : []),
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-1.5">Compete</p>
          <h1 className="font-display text-[2.25rem] font-semibold leading-none tracking-tight text-ink sm:text-[2.75rem]">Contests</h1>
          <p className="mt-2.5 max-w-xl text-[0.9375rem] text-muted">
            Timed rounds hosted by the community. Register before the start, then solve as many problems as you can before
            the clock runs out.
          </p>
        </div>
        {running.data && upcoming.data && (
          <p className="flex shrink-0 items-center gap-3 rounded-full border border-line/80 bg-surface/80 px-4 py-2 text-sm text-muted shadow-sm">
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${live.length ? "animate-pulse bg-good" : "bg-line-strong"}`} aria-hidden="true" />
              <span className="font-semibold text-ink tabular">{live.length}</span> live
            </span>
            <span className="h-4 w-px bg-line" aria-hidden="true" />
            <span>
              <span className="font-semibold text-ink tabular">{soon.length}</span> coming up
            </span>
          </p>
        )}
      </header>

      {featured && <FeaturedTicket c={featured} now={now} signedIn={signedIn} />}

      <div role="tablist" aria-label="Contest lists" className="mb-6 flex gap-6 border-b border-line">
        {tabs.map(([t, label, count]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls="contest-list"
            onClick={() => go(t)}
            className={`relative -mb-px flex items-center gap-2 pb-3 pt-1 text-sm font-medium transition-colors ${tab === t ? "text-ink" : "text-muted hover:text-ink"}`}
          >
            {label}
            {count !== undefined && (
              <span className={`rounded-full px-1.5 text-xs tabular ${tab === t ? "bg-accent/10 text-accent" : "bg-sunken text-faint"}`}>{count}</span>
            )}
            <span
              className={`absolute inset-x-0 -bottom-px h-0.5 origin-center rounded-full bg-accent transition-transform duration-300 ${tab === t ? "scale-x-100" : "scale-x-0"}`}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>

      <div id="contest-list" role="tabpanel" key={tab} className="animate-step">
        {tab === "upcoming" &&
          (running.isError || upcoming.isError ? (
            <ErrorState title="Couldn't load contests" message={(running.error ?? upcoming.error)?.message ?? ""} onRetry={() => (running.refetch(), upcoming.refetch())} />
          ) : running.isPending || upcoming.isPending ? (
            <Spinner label="Loading contests…" />
          ) : (
            <div className="space-y-10">
              {live.length > 0 && (
                <section aria-label="Live now">
                  <ListTitle live>Live now</ListTitle>
                  <ul className="space-y-3">
                    {live.map((c) => (
                      <LiveRow key={c.slug} c={c} now={now} signedIn={signedIn} />
                    ))}
                  </ul>
                </section>
              )}
              <section aria-label="Upcoming">
                <ListTitle>Starting soon</ListTitle>
                {soon.length === 0 ? (
                  <Empty icon={CalendarClock} title="Nothing scheduled yet">
                    New rounds appear here the moment their hosts publish them. Meanwhile, try a past round.
                  </Empty>
                ) : (
                  <Timeline items={soon} now={now} signedIn={signedIn} />
                )}
              </section>
            </div>
          ))}
        {tab === "past" && <PastList ready={ready} now={now} signedIn={signedIn} />}
        {tab === "mine" && <MineList joined={joined.data} loading={joined.isPending} now={now} signedIn={signedIn} />}
      </div>

      <ScoringExplainer />
    </div>
  );
}

function ListTitle({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <h2 className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-faint">
      {live && (
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
        </span>
      )}
      {children}
    </h2>
  );
}

function Empty({ icon: Icon, title, children }: { icon: typeof Trophy; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-dashed border-line-strong/70 bg-surface/50 p-5">
      <span className="icon-tile shrink-0">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div>
        <p className="font-semibold text-ink">{title}</p>
        <p className="text-sm text-muted">{children}</p>
      </div>
    </div>
  );
}

/** Register / withdraw, shared by every row and the ticket. */
function useRegistration(c: ContestSummary) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => (c.registered ? contestsApi.unregister(c.slug) : contestsApi.register(c.slug)),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["contests"] });
      void qc.invalidateQueries({ queryKey: ["joined-contests"] });
      void qc.invalidateQueries({ queryKey: ["contest", c.slug] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Please try again."),
  });
  return { mutation, error };
}

/** The one thing you can do with a contest right now, as a button. */
function Action({ c, now, signedIn, size = "sm" }: { c: ContestSummary; now: number; signedIn: boolean; size?: "sm" | "lg" }) {
  const { mutation, error } = useRegistration(c);
  const phase = livePhase(c.starts_at, c.ends_at, now);
  const cls = size === "lg" ? "min-h-[46px] w-full px-5 text-base" : "min-h-[36px] px-4 text-sm";
  let button: React.ReactNode;
  if (c.my_role) {
    button = (
      <Link to={`/contests/${c.slug}/manage`} className={`btn btn-outline ${cls}`}>
        <Settings2 size={15} aria-hidden="true" /> Manage
      </Link>
    );
  } else if (phase === "ENDED") {
    button = (
      <Link to={`/contests/${c.slug}/standings`} className={`btn btn-outline ${cls}`}>
        <BarChart3 size={15} aria-hidden="true" /> Standings
      </Link>
    );
  } else if (!signedIn) {
    button = (
      <Link to="/login" className={`btn btn-primary ${cls}`}>
        Sign in to register
      </Link>
    );
  } else if (phase === "RUNNING") {
    button = c.registered ? (
      <Link to={`/contests/${c.slug}`} className={`btn btn-primary ${cls}`}>
        Enter the arena
      </Link>
    ) : (
      <button type="button" className={`btn btn-primary ${cls}`} onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        Register and enter
      </button>
    );
  } else {
    button = c.registered ? (
      <span className={`flex items-center gap-1 ${size === "lg" ? "w-full justify-between" : ""}`}>
        <span className={`inline-flex items-center gap-1.5 rounded-xl bg-good/10 font-medium text-good ${size === "lg" ? "px-4 py-3" : "px-3 py-2 text-sm"}`}>
          <Check size={15} strokeWidth={3} aria-hidden="true" /> Registered
        </span>
        <button type="button" className="btn btn-ghost min-h-[32px] px-2 text-xs" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          Withdraw
        </button>
      </span>
    ) : (
      <button type="button" className={`btn btn-primary ${cls}`} onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        Register
      </button>
    );
  }
  return (
    <div className={`flex flex-col gap-1 ${size === "lg" ? "items-stretch" : "items-end"}`}>
      {button}
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}

/** "ICPC rules · 2 h · 7 registered", each part on its own so it wraps cleanly. */
function Meta({ c }: { c: ContestSummary }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted">
      <span title={FORMAT_HELP[c.format]}>{FORMAT_LABELS[c.format]}</span>
      <span aria-hidden="true">·</span>
      <span>{formatDuration(c.duration_minutes)}</span>
      <span aria-hidden="true">·</span>
      <span className="flex items-center gap-1">
        <Users size={13} aria-hidden="true" /> {c.participants} registered
      </span>
    </p>
  );
}

/** The round to act on now, as an event ticket: details on the left, the tear-off stub with the clock on the right. */
function FeaturedTicket({ c, now, signedIn }: { c: ContestSummary; now: number; signedIn: boolean }) {
  const phase = livePhase(c.starts_at, c.ends_at, now);
  const target = new Date(phase === "RUNNING" ? c.ends_at : c.starts_at).getTime();
  const label = phase === "RUNNING" ? "Live now" : c.registered ? "Your next round" : "Next up";
  const start = new Date(c.starts_at);
  const elapsed = phase === "RUNNING" ? (now - start.getTime()) / (new Date(c.ends_at).getTime() - start.getTime()) : 0;
  return (
    <Spotlight
      aria-label={`${label}: ${c.title}`}
      className="mb-10 grid overflow-hidden rounded-[1.75rem] border border-line/80 bg-surface shadow-[0_30px_70px_-40px_rgb(0_0_0/0.35)] md:grid-cols-[minmax(0,1fr)_19rem]"
    >
      <div className="dots relative p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <p className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${phase === "RUNNING" ? "bg-good/10 text-good" : "bg-accent/10 text-accent"}`}>
            {phase === "RUNNING" ? (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" />
            ) : (
              <Ticket size={13} aria-hidden="true" />
            )}
            {label}
          </p>
          <span className="hidden font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-faint sm:inline">Admit one</span>
        </div>
        <h2 className="mt-5 font-display text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
          <Link to={`/contests/${c.slug}`} className="hover:text-accent">
            {c.title}
          </Link>
        </h2>
        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-dashed border-line-strong/60 pt-5">
          <TicketField label="Date" value={start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} />
          <TicketField label="Time" value={start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} />
          <TicketField label="Length" value={formatDuration(c.duration_minutes)} />
          <TicketField label="Rules" value={FORMAT_LABELS[c.format].replace(" rules", "")} />
          <TicketField label="Registered" value={String(c.participants)} />
          <div>
            <p className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-faint">Hosts</p>
            <div className="mt-1.5 flex items-center gap-2">
              <AvatarStack names={c.authors} />
              <span className="truncate text-sm text-muted">
                {c.authors.slice(0, 2).map((a, i) => (
                  <span key={a}>
                    {i > 0 && ", "}
                    <Link to={`/u/${encodeURIComponent(a)}`} className="hover:text-accent">
                      {a}
                    </Link>
                  </span>
                ))}
              </span>
            </div>
          </div>
        </div>
        {phase === "RUNNING" && (
          <div className="mt-5">
            <div className="h-1.5 overflow-hidden rounded-full bg-line/70">
              <div className="h-full rounded-full bg-good transition-[width] duration-1000" style={{ width: `${Math.min(100, elapsed * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-faint">{Math.round(elapsed * 100)}% of the round has run</p>
          </div>
        )}
      </div>

      {/* The stub: a perforated edge, then the clock and the one button. */}
      <div className="relative flex flex-col justify-between gap-6 border-t border-dashed border-line-strong/70 bg-paper/50 p-6 sm:p-8 md:border-l md:border-t-0">
        <span className="absolute -left-3 -top-3 hidden h-6 w-6 rounded-full bg-paper md:block" aria-hidden="true" />
        <span className="absolute -bottom-3 -left-3 hidden h-6 w-6 rounded-full bg-paper md:block" aria-hidden="true" />
        <div>
          <p className="mb-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-faint">{phase === "RUNNING" ? "Ends in" : "Starts in"}</p>
          <RollingClock ms={target - now} label={`${phase === "RUNNING" ? "Ends" : "Starts"} in`} tone={phase === "RUNNING" ? "good" : "accent"} />
        </div>
        <div>
          <Action c={c} now={now} signedIn={signedIn} size="lg" />
          <p className="mt-3 flex justify-center gap-[3px]" aria-hidden="true">
            {c.slug
              .split("")
              .slice(0, 28)
              .map((ch, i) => (
                <span key={i} className="h-5 bg-ink/70" style={{ width: (ch.charCodeAt(0) % 3) + 1 }} />
              ))}
          </p>
        </div>
      </div>
    </Spotlight>
  );
}

function TicketField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-faint">{label}</p>
      <p className="mt-1 truncate font-medium text-ink">{value}</p>
    </div>
  );
}

/** A round in progress: a radar pulse and how much of it has run. */
function LiveRow({ c, now, signedIn }: { c: ContestSummary; now: number; signedIn: boolean }) {
  const start = new Date(c.starts_at).getTime();
  const end = new Date(c.ends_at).getTime();
  const done = Math.min(1, Math.max(0, (now - start) / (end - start)));
  return (
    <li className="card overflow-hidden border-good/30">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <span className="relative grid h-12 w-12 shrink-0 place-items-center" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-good/20" />
          <span className="relative grid h-10 w-10 place-items-center rounded-full bg-good/15 text-good">
            <Trophy size={18} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/contests/${c.slug}`} className="truncate font-semibold text-ink hover:text-accent">
              {c.title}
            </Link>
            <PhaseBadge phase="RUNNING" />
          </div>
          <Meta c={c} />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
          <span className="text-sm">
            <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
          </span>
          <Action c={c} now={now} signedIn={signedIn} />
        </div>
      </div>
      <div className="h-1 bg-good/10" aria-hidden="true">
        <div className="h-full bg-good transition-[width] duration-1000" style={{ width: `${done * 100}%` }} />
      </div>
    </li>
  );
}

/** "Today", "Tomorrow", else "Sat 2 Nov". */
function dayLabel(d: Date, now: number) {
  const day = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000);
  const diff = day(d.getTime()) - day(now);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

/** Upcoming rounds on a timeline, grouped by day, each pinned to its start time. */
function Timeline({ items, now, signedIn }: { items: ContestSummary[]; now: number; signedIn: boolean }) {
  const groups: [string, ContestSummary[]][] = [];
  for (const c of items) {
    const label = dayLabel(new Date(c.starts_at), now);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(c);
    else groups.push([label, [c]]);
  }
  return (
    <div className="space-y-6">
      {groups.map(([label, list]) => (
        <div key={label}>
          <p className="mb-3 text-sm font-semibold text-ink">{label}</p>
          <ol className="relative space-y-3 border-l border-dashed border-line-strong/70 pl-6 sm:ml-16">
            {list.map((c) => {
              const d = new Date(c.starts_at);
              return (
                <li key={c.slug} className="relative">
                  <span className="absolute -left-[1.85rem] top-6 h-3 w-3 rounded-full border-2 border-accent bg-surface" aria-hidden="true" />
                  <span className="absolute -left-[5.5rem] top-5 hidden w-14 text-right font-mono text-sm font-semibold text-ink sm:block">
                    {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <div className="card flex flex-col gap-3 p-4 transition-colors hover:border-accent/40 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <Link to={`/contests/${c.slug}`} className="truncate font-semibold text-ink hover:text-accent">
                        {c.title}
                      </Link>
                      <Meta c={c} />
                      <p className="mt-1 text-xs text-faint">by {c.authors.join(", ")}</p>
                    </div>
                    <div className="flex shrink-0 items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-2">
                      <span className="text-sm">
                        <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
                      </span>
                      <Action c={c} now={now} signedIn={signedIn} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}

/** A finished (or any) round as one compact row. */
function ContestRow({ c, now, signedIn }: { c: ContestSummary; now: number; signedIn: boolean }) {
  const phase = livePhase(c.starts_at, c.ends_at, now);
  const d = new Date(c.starts_at);
  return (
    <li className="card flex flex-col gap-4 p-4 transition-colors hover:border-line-strong sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-xl border border-line" aria-hidden="true">
          <span className={`w-full py-0.5 text-center text-[0.625rem] font-semibold uppercase tracking-[0.12em] ${phase === "ENDED" ? "bg-sunken text-faint" : "bg-accent text-accent-ink"}`}>
            {d.toLocaleDateString(undefined, { month: "short" })}
          </span>
          <span className="py-1 font-display text-xl font-semibold text-ink">{d.getDate()}</span>
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/contests/${c.slug}`} className="truncate font-semibold text-ink hover:text-accent">
              {c.title}
            </Link>
            {phase !== "UPCOMING" && <PhaseBadge phase={phase} />}
          </div>
          <Meta c={c} />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
        {phase === "ENDED" ? (
          <Link to={`/contests/${c.slug}/editorial`} className="btn btn-ghost min-h-[36px] px-3 text-sm">
            <BookOpen size={14} aria-hidden="true" /> Editorial
          </Link>
        ) : (
          <span className="text-sm">
            <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
          </span>
        )}
        <Action c={c} now={now} signedIn={signedIn} />
      </div>
    </li>
  );
}

/** Everything that has ended, newest first, searchable by title. */
function PastList({ ready, now, signedIn }: { ready: boolean; now: number; signedIn: boolean }) {
  const [page, setPage] = useState(1);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [text]);
  const past = useQuery({
    queryKey: ["contests", "past", page, q],
    queryFn: () => contestsApi.list("past", page, 10, q || undefined),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  return (
    <section aria-labelledby="past-heading">
      <h2 id="past-heading" className="sr-only">
        Past contests
      </h2>
      <label className="relative mb-4 block sm:w-80">
        <span className="sr-only">Search past contests</span>
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input type="search" className="input pl-9" placeholder="Search past contests…" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {past.isPending ? (
        <Spinner label="Loading contests…" />
      ) : past.isError ? (
        <ErrorState title="Couldn't load contests" message={past.error.message} onRetry={() => past.refetch()} />
      ) : past.data.items.length === 0 ? (
        <Empty icon={History} title={q ? "No match" : "No finished contests yet"}>
          {q ? `No past contest matches “${q}”.` : "Rounds show up here once they end, with their standings and editorial."}
        </Empty>
      ) : (
        <div className={past.isPlaceholderData ? "opacity-60" : undefined}>
          <ul className="space-y-2">
            {past.data.items.map((c) => (
              <ContestRow key={c.slug} c={c} now={now} signedIn={signedIn} />
            ))}
          </ul>
          <Pagination page={past.data.page} totalPages={past.data.total_pages} onChange={setPage} />
        </div>
      )}
    </section>
  );
}

/** Your rounds: the ones you're registered for, then your results. */
function MineList({ joined, loading, now, signedIn }: { joined?: JoinedContest[]; loading: boolean; now: number; signedIn: boolean }) {
  if (loading || !joined) return <Spinner label="Loading your contests…" />;
  const ahead = joined.filter((j) => new Date(j.contest.ends_at).getTime() > now).sort((a, b) => a.contest.starts_at.localeCompare(b.contest.starts_at));
  const past = joined.filter((j) => new Date(j.contest.ends_at).getTime() <= now);
  const placed = past.filter((j) => j.rank !== null);
  const best = placed.length ? Math.min(...placed.map((j) => j.rank!)) : null;
  return (
    <div className="space-y-10">
      {past.length > 0 && (
        <dl className="grid grid-cols-3 gap-3">
          <Stat label="Rounds entered" value={String(past.length)} />
          <Stat label="Best place" value={best ? `#${best}` : "—"} />
          <Stat label="Problems solved" value={String(past.reduce((n, j) => n + j.solved, 0))} />
        </dl>
      )}
      <section aria-labelledby="mine-ahead-h">
        <ListTitle>
          <span id="mine-ahead-h">Registered</span>
        </ListTitle>
        {ahead.length === 0 ? (
          <Empty icon={CalendarClock} title="Nothing coming up">
            Register for a round under Upcoming and it shows up here with a countdown.
          </Empty>
        ) : (
          <ul className="space-y-2" aria-label="Registered">
            {ahead.map((j) => (
              <ContestRow key={j.contest.slug} c={j.contest} now={now} signedIn={signedIn} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="mine-results-h">
        <ListTitle>
          <span id="mine-results-h">Results</span>
        </ListTitle>
        {past.length === 0 ? (
          <Empty icon={Medal} title="No results yet">
            Your place in every round you enter is kept here once it ends.
          </Empty>
        ) : (
          <ul className="space-y-2" aria-label="Results">
            {past.map((j) => (
              <ResultRow key={j.contest.slug} j={j} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 font-display text-2xl font-semibold tabular text-ink">{value}</dd>
    </div>
  );
}

/** One worked example per rule: the same solve, scored four ways. */
const EXAMPLES: Record<ContestFormat, { short: string; result: string; how: string }> = {
  CODEFORCES: { short: "Speed matters", result: "426 points", how: "500 − 2 per minute × 12 − 50 for the wrong try" },
  ICPC: { short: "Most solved wins", result: "1 solved · 32 min penalty", how: "12 minutes to the solve + 20 for the wrong try" },
  ATCODER: { short: "Points, then time", result: "500 points · 0:17", how: "the solve at 0:12 + 5 minutes for the wrong try" },
  IOI: { short: "Partial credit", result: "70 of 100", how: "your best submission passed 7 of the 10 tests" },
};

/** Pick a rule, see the same solve scored under it. */
function ScoringExplainer() {
  const formats: ContestFormat[] = ["CODEFORCES", "ICPC", "ATCODER", "IOI"];
  const [f, setF] = useState<ContestFormat>("CODEFORCES");
  const e = EXAMPLES[f];
  return (
    <section aria-labelledby="scoring-h" className="mt-14 overflow-hidden rounded-[1.5rem] border border-line/80 bg-surface">
      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="p-6 sm:p-7">
          <h2 id="scoring-h" className="flex items-center gap-2 font-display text-xl font-semibold tracking-tight text-ink">
            <Trophy size={18} className="text-accent" aria-hidden="true" /> How scoring works
          </h2>
          <p className="mt-1 text-sm text-muted">Each round picks one rule. Pick one to see how it would score the same solve.</p>
          <div className="mt-5 flex flex-wrap gap-2" role="radiogroup" aria-label="Scoring rule">
            {formats.map((x) => (
              <button
                key={x}
                type="button"
                role="radio"
                aria-checked={f === x}
                onClick={() => setF(x)}
                className={`pill-choice ${f === x ? "pill-choice-on" : ""}`}
              >
                {FORMAT_LABELS[x].replace(" rules", "")}
              </button>
            ))}
          </div>
          <p className="mt-5 text-sm leading-relaxed text-muted">{FORMAT_HELP[f]}</p>
        </div>
        <div className="dots border-t border-line/70 bg-paper/50 p-6 sm:p-7 md:border-l md:border-t-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-faint">Example</p>
          <p className="mt-2 text-sm text-ink">
            You solve <span className="font-semibold">problem A</span> (worth 500) at <span className="font-mono">0:12</span>, after{" "}
            <span className="font-semibold">one wrong try</span>.
          </p>
          <div key={f} className="animate-step mt-5 rounded-2xl border border-accent/30 bg-surface p-5 shadow-[0_20px_40px_-28px_rgb(var(--c-accent)/0.6)]">
            <p className="text-xs font-medium text-accent">{e.short}</p>
            <p className="mt-1 font-display text-3xl font-semibold tracking-tight text-ink">{e.result}</p>
            <p className="mt-2 font-mono text-xs text-faint">{e.how}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function percentile(j: { rank: number; ranked: number }) {
  return Math.max(1, Math.round((j.rank / Math.max(1, j.ranked)) * 100));
}

/** " · winner" or " · top 5%"; nothing when "top 100%" would only restate the place. */
function standing(j: { rank: number; ranked: number }) {
  if (j.rank === 1) return " · winner";
  const p = percentile(j);
  return p <= 50 ? ` · top ${p}%` : "";
}

const MEDAL: Record<number, string> = {
  1: "from-amber-300 to-amber-500 text-amber-950 ring-amber-400/40",
  2: "from-slate-200 to-slate-400 text-slate-900 ring-slate-400/40",
  3: "from-orange-300 to-orange-600 text-orange-950 ring-orange-500/40",
};

function RankMedal({ rank, size = "md" }: { rank: number | null; size?: "md" | "lg" }) {
  const dim = size === "lg" ? "h-16 w-16 text-xl" : "h-12 w-12 text-base";
  if (rank === null) {
    return (
      <span className={`grid ${dim} shrink-0 place-items-center rounded-2xl border border-dashed border-line-strong text-faint`} aria-hidden="true">
        —
      </span>
    );
  }
  const medal = MEDAL[rank];
  return (
    <span
      className={`grid ${dim} shrink-0 place-items-center rounded-2xl font-display font-semibold tabular ${
        medal ? `bg-gradient-to-br ring-4 ${medal}` : "border border-line bg-sunken text-ink"
      }`}
      aria-hidden="true"
    >
      #{rank}
    </span>
  );
}

function ResultRow({ j }: { j: JoinedContest }) {
  const c = j.contest;
  return (
    <li className="card card-hover flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <RankMedal rank={j.rank} />
        <div className="min-w-0 flex-1">
          <Link to={`/contests/${c.slug}/standings`} className="block truncate font-display text-lg font-semibold tracking-tight text-ink hover:text-accent">
            {c.title}
          </Link>
          <p className="mt-0.5 text-xs text-faint">
            {formatWhen(c.starts_at)} · {FORMAT_LABELS[c.format]} · {formatDuration(c.duration_minutes)}
          </p>
          {j.rank !== null ? (
            <div className="mt-2 flex items-center gap-3">
              <div className="h-1.5 w-40 max-w-full overflow-hidden rounded-full bg-line/70">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(4, ((j.ranked - j.rank + 1) / Math.max(1, j.ranked)) * 100)}%` }} />
              </div>
              <span className="text-xs text-muted">
                <span className="font-semibold text-ink">#{j.rank}</span> of {j.ranked}
                {standing({ rank: j.rank, ranked: j.ranked })}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-xs text-faint">No entry: you registered but did not submit.</p>
          )}
        </div>
      </div>
      <dl className="flex shrink-0 gap-6 sm:px-4">
        <div>
          <dt className="text-xs text-faint">Solved</dt>
          <dd className="font-display text-xl font-semibold tabular text-ink">{j.solved}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Score</dt>
          <dd className="font-display text-xl font-semibold tabular text-ink">{j.score}</dd>
        </div>
      </dl>
      <div className="flex shrink-0 gap-2">
        <Link to={`/contests/${c.slug}/standings`} className="btn btn-outline min-h-[36px] px-3 text-xs" aria-label={`Standings of ${c.title}`}>
          <BarChart3 size={14} aria-hidden="true" /> Standings
        </Link>
        <Link to={`/contests/${c.slug}/editorial`} className="btn btn-ghost min-h-[36px] px-3 text-xs" aria-label={`Editorial of ${c.title}`}>
          <BookOpen size={14} aria-hidden="true" /> Editorial
        </Link>
      </div>
    </li>
  );
}
