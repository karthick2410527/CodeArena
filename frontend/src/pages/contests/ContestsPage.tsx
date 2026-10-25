import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BarChart3, CalendarClock, CalendarPlus, History, Medal, Search, Timer, Trophy, Users } from "lucide-react";
import { ApiError } from "../../api/client";
import { contestsApi } from "../../api/endpoints";
import type { ContestFormat, ContestSummary } from "../../api/types";
import { useViewer } from "../../auth/AuthContext";
import { Countdown, FORMAT_HELP, FORMAT_LABELS, PhaseBadge, formatDuration, formatWhen, livePhase, useNow } from "../../components/contest";
import { ErrorState, Spinner } from "../../components/Feedback";
import { ClockTiles, HubHero, HubTabs, SectionHead } from "../../components/ContestHub";
import Pagination from "../../components/Pagination";
import { Avatar, UserLink } from "../../components/people";
import { Notice } from "../../components/ui";

/**
 * Contests, Codeforces style: what is live right now front and centre, then
 * what is coming up beside how to host one, then everything that has ended.
 */
export default function ContestsPage() {
  const { ready, signedIn } = useViewer();
  const now = useNow();
  const running = useQuery({ queryKey: ["contests", "running"], queryFn: () => contestsApi.list("running"), enabled: ready });
  // Your own rounds (registered or hosted) have their own section, so the general lists leave them out.
  const others = signedIn ? "hosted,registered" : undefined;
  const upcoming = useQuery({
    queryKey: ["contests", "upcoming", others ?? "all"],
    queryFn: () => contestsApi.list("upcoming", 1, 20, undefined, others),
    enabled: ready,
  });
  const finished = useQuery({
    queryKey: ["contests", "past", "count", others ?? "all"],
    queryFn: () => contestsApi.list("past", 1, 1, undefined, others),
    enabled: ready,
  });
  const mine = [...(running.data?.items ?? []), ...(upcoming.data?.items ?? [])].filter((c) => c.registered).length;
  const n = (q: { data?: { total: number } }) => q.data?.total ?? "—";

  return (
    <div>
      <HubTabs />
      <HubHero
        eyebrow="Compete"
        title={
          <>
            Race the clock. <span className="text-accent-shine">Climb the board.</span>
          </>
        }
        description="Timed rounds hosted by the community. Register, solve as many problems as you can before time runs out, and watch the standings move live."
        actions={
          signedIn ? (
            <>
              <Link to="/contests/joined" className="btn btn-primary min-h-[44px] px-5">
                <Medal size={16} aria-hidden="true" /> Your results
              </Link>
              <a href="#past-heading" className="btn btn-outline min-h-[44px] px-5">
                Past rounds
              </a>
            </>
          ) : (
            <Link to="/register" className="btn btn-primary min-h-[44px] px-5">
              Create an account to compete <ArrowRight size={16} aria-hidden="true" />
            </Link>
          )
        }
        aside={<NextRound running={running.data?.items ?? []} upcoming={upcoming.data?.items ?? []} now={now} signedIn={signedIn} />}
        stats={[
          { label: "Live now", value: n(running), tone: (running.data?.total ?? 0) > 0 ? "good" : undefined },
          { label: "Upcoming", value: n(upcoming) },
          { label: "Finished", value: n(finished) },
          signedIn ? { label: "You're registered for", value: mine, tone: mine > 0 ? "accent" : undefined } : { label: "Scoring rules", value: 4 },
        ]}
      />

      {running.isError ? (
        <ErrorState title="Couldn't load contests" message={running.error.message} onRetry={() => running.refetch()} />
      ) : (
        running.data &&
        running.data.items.length > 0 && (
          <section aria-label="Live now" className="mb-12 space-y-4">
            <SectionHead title="Live now" live count={running.data.total} />
            {running.data.items.map((c) => (
              <LiveCard key={c.slug} c={c} now={now} signedIn={signedIn} />
            ))}
          </section>
        )
      )}

      {signedIn && <YourRounds now={now} />}

      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label="Upcoming">
          <SectionHead icon={CalendarClock} title={signedIn ? "Upcoming from others" : "Upcoming"} count={upcoming.data?.total} />
          {upcoming.isPending ? (
            <Spinner label="Loading contests…" />
          ) : upcoming.isError ? (
            <ErrorState title="Couldn't load contests" message={upcoming.error.message} onRetry={() => upcoming.refetch()} />
          ) : upcoming.data.items.length === 0 ? (
            <div className="relative overflow-hidden rounded-2xl border border-dashed border-line-strong/70 bg-surface/50 px-6 py-12 text-center">
              <div className="pointer-events-none absolute left-1/2 top-0 h-40 w-72 -translate-x-1/2 rounded-full bg-accent/15 blur-3xl" aria-hidden="true" />
              <div className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-accent/25 bg-accent/10 text-accent shadow-[0_10px_30px_-12px_rgb(var(--c-accent)/0.6)]">
                <CalendarPlus size={24} aria-hidden="true" />
              </div>
              <p className="relative mt-4 font-display text-lg font-semibold text-ink">
                {signedIn ? "Nothing else scheduled yet" : "Nothing scheduled yet"}
              </p>
              <p className="relative mx-auto mt-1 max-w-sm text-sm text-muted">
                New rounds show up here as soon as their hosts publish them. Meanwhile, practise on past rounds.
              </p>
              <div className="relative mt-5 flex flex-wrap justify-center gap-2">
                <a href="#past-heading" className="btn btn-outline">
                  Browse past rounds
                </a>
              </div>
            </div>
          ) : (
            <ul className="space-y-3">
              {upcoming.data.items.map((c) => (
                <li key={c.slug}>
                  <UpcomingRow c={c} now={now} signedIn={signedIn} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="grid gap-4 md:grid-cols-2 xl:grid-cols-1" aria-label="Hosting and formats">
          <HostCard signedIn={signedIn} />
          <FormatsCard />
        </aside>
      </div>

      <PastContests ready={ready} exclude={others} />
    </div>
  );
}

/**
 * What the signed-in viewer registered for, apart from everyone else's rounds.
 * Finished ones are on Joined; the rounds they host are under Host.
 */
function YourRounds({ now }: { now: number }) {
  const joined = useQuery({ queryKey: ["joined-contests"], queryFn: () => contestsApi.joined() });
  const ahead = (c: ContestSummary) => new Date(c.ends_at).getTime() > now;
  const registered = (joined.data ?? []).map((j) => j.contest).filter(ahead);
  return (
    <section aria-labelledby="yours-h" className="reveal mb-12">
      <SectionHead id="yours-h" icon={Medal} title="Your registrations" />
      <div>
        <RoundColumn
          title="Registered"
          icon={Medal}
          all="/contests/joined"
          allLabel="Results and history"
          items={registered}
          loading={joined.isPending}
          now={now}
          empty={<>You haven't registered for anything coming up. Pick a round below.</>}
          action={(c) => (
            <Link to={`/contests/${c.slug}`} className={`btn min-h-[32px] px-3 text-xs ${livePhase(c.starts_at, c.ends_at, now) === "RUNNING" ? "btn-primary" : "btn-outline"}`}>
              {livePhase(c.starts_at, c.ends_at, now) === "RUNNING" ? "Enter" : "Open"}
            </Link>
          )}
        />
      </div>
    </section>
  );
}

function RoundColumn({
  title,
  icon: Icon,
  all,
  allLabel,
  items,
  loading,
  now,
  empty,
  action,
}: {
  title: string;
  icon: typeof Medal;
  all: string;
  allLabel: string;
  items: ContestSummary[];
  loading: boolean;
  now: number;
  empty: React.ReactNode;
  action: (c: ContestSummary) => React.ReactNode;
}) {
  return (
    <div className="card flex flex-col overflow-hidden" aria-label={title} role="region">
      <div className="flex items-center justify-between gap-3 border-b border-line/70 px-5 py-3.5">
        <p className="flex items-center gap-2 font-semibold text-ink">
          <Icon size={16} className="text-accent" aria-hidden="true" /> {title}
          <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium text-muted">{loading ? "…" : items.length}</span>
        </p>
        <Link to={all} className="text-xs font-medium text-accent hover:underline">
          {allLabel} →
        </Link>
      </div>
      {loading ? (
        <p className="px-5 py-6 text-sm text-faint">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line/70">
          {items.slice(0, 4).map((c) => (
            <li key={c.slug} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <PhaseBadge phase={livePhase(c.starts_at, c.ends_at, now)} published={c.published} />
                  <Link to={`/contests/${c.slug}`} className="truncate font-medium text-ink hover:text-accent">
                    {c.title}
                  </Link>
                </div>
                <p className="mt-0.5 text-xs text-faint">
                  <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} /> · {formatDuration(c.duration_minutes)} ·{" "}
                  {c.participants} registered
                </p>
              </div>
              {action(c)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The hero's right side: the round that is live, else the next one, else an invitation to host. */
function NextRound({ running, upcoming, now, signedIn }: { running: ContestSummary[]; upcoming: ContestSummary[]; now: number; signedIn: boolean }) {
  const live = running[0];
  const next = live ?? upcoming[0];
  if (!next) {
    return (
      <div className="rounded-2xl border border-line/70 bg-surface/80 p-5 backdrop-blur">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Next round</p>
        <p className="mt-2 font-display text-lg font-semibold text-ink">The calendar is open</p>
        <p className="mt-1 text-sm text-muted">No round is scheduled. Yours could be the next one people race.</p>
        <div className="mt-4 grid grid-cols-7 gap-1" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className={`h-6 rounded-md ${i === 8 ? "bg-accent/70 shadow-[0_0_0_3px_rgb(var(--c-accent)/0.18)]" : "bg-sunken"}`} />
          ))}
        </div>
        <Link to={signedIn ? "/host" : "/register"} className="btn btn-outline mt-4 w-full">
          {signedIn ? "Host a round" : "Sign up to host"} <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>
    );
  }
  const target = new Date(live ? next.ends_at : next.starts_at).getTime();
  return (
    <div className="rounded-2xl border border-line/70 bg-surface/80 p-5 backdrop-blur">
      <p className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] ${live ? "text-good" : "text-faint"}`}>
        {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" />}
        {live ? "Live · ends in" : "Next round · starts in"}
      </p>
      <Link to={`/contests/${next.slug}`} className="mt-2 block truncate font-display text-lg font-semibold text-ink hover:text-accent">
        {next.title}
      </Link>
      <p className="mb-4 mt-0.5 text-xs text-faint">
        {FORMAT_LABELS[next.format]} · {formatDuration(next.duration_minutes)} · {next.participants} registered
      </p>
      <ClockTiles ms={target - now} label={`${live ? "Ends" : "Starts"} in ${formatDuration(Math.ceil((target - now) / 60000))}`} />
      <Link to={`/contests/${next.slug}`} className="btn btn-primary mt-4 w-full">
        {live ? "Enter the arena" : "View the round"} <ArrowRight size={15} aria-hidden="true" />
      </Link>
    </div>
  );
}

/** Register / withdraw, shared by the live and upcoming cards. */
function useRegistration(c: ContestSummary) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => (c.registered ? contestsApi.unregister(c.slug) : contestsApi.register(c.slug)),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["contests"] });
      void qc.invalidateQueries({ queryKey: ["contest", c.slug] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Please try again."),
  });
  return { mutation, error };
}

/** "01 : 42 : 07" in tiles, for the round that is running. */
function Clock({ ms }: { ms: number }) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const parts: [string, number][] = [
    ["h", Math.floor(t / 3600)],
    ["m", Math.floor((t % 3600) / 60)],
    ["s", t % 60],
  ];
  return (
    <div className="flex items-start gap-1.5" role="timer" aria-label={`${parts[0][1]} hours ${parts[1][1]} minutes left`}>
      {parts.map(([unit, n], i) => (
        <div key={unit} className="flex items-start gap-1.5">
          {i > 0 && <span className="pt-2 font-mono text-xl text-faint">:</span>}
          <span className="flex flex-col items-center">
            <span className="min-w-[3.25rem] rounded-xl border border-line bg-surface px-2 py-1.5 text-center font-mono text-2xl font-semibold text-ink shadow-sm">
              {String(n).padStart(2, "0")}
            </span>
            <span className="mt-1 text-[0.625rem] uppercase tracking-[0.12em] text-faint">{unit}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function LiveCard({ c, now, signedIn }: { c: ContestSummary; now: number; signedIn: boolean }) {
  const { mutation, error } = useRegistration(c);
  const start = new Date(c.starts_at).getTime();
  const end = new Date(c.ends_at).getTime();
  const progress = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  return (
    <article
      className="panel relative overflow-hidden"
      style={{
        background:
          "radial-gradient(700px 240px at 0% 0%, rgb(var(--c-good) / 0.14), transparent 70%), radial-gradient(600px 260px at 100% 100%, rgb(var(--c-accent) / 0.12), transparent 70%), rgb(var(--c-surface))",
      }}
    >
      <div className="flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PhaseBadge phase="RUNNING" />
            <span className="chip" title={FORMAT_HELP[c.format]}>
              {FORMAT_LABELS[c.format]}
            </span>
            {c.registered && <span className="chip border-good/30 bg-good/10 text-good">Registered ✓</span>}
          </div>
          <h3 className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            <Link to={`/contests/${c.slug}`} className="hover:text-accent">
              {c.title}
            </Link>
          </h3>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="flex items-center gap-1.5">
              <Timer size={14} aria-hidden="true" /> {formatDuration(c.duration_minutes)}
            </span>
            <span className="flex items-center gap-1.5">
              <Trophy size={14} aria-hidden="true" /> {c.problem_count} problems
            </span>
            <span className="flex items-center gap-1.5">
              <Users size={14} aria-hidden="true" /> {c.participants} registered
            </span>
          </p>
          <p className="mt-3 flex items-center gap-2 text-sm text-muted">
            <span className="flex -space-x-2">
              {c.authors.slice(0, 3).map((a) => (
                <span key={a} className="rounded-full ring-2 ring-surface">
                  <Avatar username={a} size={24} />
                </span>
              ))}
            </span>
            <span>
              by{" "}
              {c.authors.map((a, i) => (
                <span key={a}>
                  {i > 0 && ", "}
                  <UserLink username={a} />
                </span>
              ))}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-4 lg:items-end">
          <div className="lg:text-right">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-faint">
              <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
            </p>
            <Clock ms={end - now} />
          </div>
          <div className="flex flex-wrap gap-2">
            {c.my_role ? (
              <Link to={`/contests/${c.slug}/manage`} className="btn btn-outline">
                Manage
              </Link>
            ) : !signedIn ? (
              <Link to="/login" className="btn btn-primary">
                Sign in to register
              </Link>
            ) : !c.registered ? (
              <button type="button" className="btn btn-primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
                Register and enter
              </button>
            ) : null}
            <Link to={`/contests/${c.slug}`} className={c.registered ? "btn btn-primary" : "btn btn-outline"}>
              {c.registered ? "Enter the arena" : "Enter"} <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link to={`/contests/${c.slug}/standings`} className="btn btn-ghost">
              <BarChart3 size={16} aria-hidden="true" /> Standings
            </Link>
          </div>
        </div>
      </div>
      <div className="h-1.5 bg-line/50" aria-hidden="true">
        <div className="h-full bg-good transition-all" style={{ width: `${progress}%` }} />
      </div>
      {error && (
        <div className="px-5 pb-4 pt-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
    </article>
  );
}

function UpcomingRow({ c, now, signedIn }: { c: ContestSummary; now: number; signedIn: boolean }) {
  const { mutation, error } = useRegistration(c);
  const d = new Date(c.starts_at);
  return (
    <article className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
      <div className="flex w-16 shrink-0 flex-col items-center overflow-hidden rounded-xl border border-line bg-surface" aria-hidden="true">
        <span className="w-full bg-accent py-0.5 text-center text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-accent-ink">
          {d.toLocaleDateString(undefined, { month: "short" })}
        </span>
        <span className="py-1 text-2xl font-semibold text-ink">{d.getDate()}</span>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-semibold text-ink">
          <Link to={`/contests/${c.slug}`} className="hover:text-accent">
            {c.title}
          </Link>
        </h3>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
          <span>{formatWhen(c.starts_at)}</span>
          <span>{formatDuration(c.duration_minutes)}</span>
          <span>{FORMAT_LABELS[c.format]}</span>
          <span>{c.participants} registered</span>
        </p>
        <p className="mt-1 text-xs text-faint">
          by {c.authors.join(", ")} · <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
        </p>
        {error && (
          <div className="mt-2">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {c.my_role ? (
          <Link to={`/contests/${c.slug}/manage`} className="btn btn-outline">
            Manage
          </Link>
        ) : !signedIn ? (
          <Link to="/login" className="btn btn-outline">
            Sign in to register
          </Link>
        ) : c.registered ? (
          <button type="button" className="btn btn-ghost" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            Registered ✓ · Withdraw
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            Register
          </button>
        )}
      </div>
    </article>
  );
}

function HostCard({ signedIn }: { signedIn: boolean }) {
  const steps: [string, string][] = [
    ["Write problems", "Statements, samples and hidden tests in your studio"],
    ["Set the rules", "Pick a scoring format, a time and co-authors"],
    ["Publish", "People register and race on the clock"],
    ["Release the editorial", "Explain the solutions once it ends"],
  ];
  return (
    <div className="panel relative overflow-hidden p-6">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-accent/20 blur-3xl" aria-hidden="true" />
      <p className="relative eyebrow">For problem setters</p>
      <p className="relative mt-1 font-display text-lg font-semibold text-ink">Host a round</p>
      <ol className="relative mt-4">
        {steps.map(([title, body], i) => (
          <li key={title} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && <span className="absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px bg-line" aria-hidden="true" />}
            <span className="relative grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-[0.6875rem] font-semibold text-accent">
              {i + 1}
            </span>
            <span>
              <span className="block text-sm font-medium text-ink">{title}</span>
              <span className="block text-xs text-muted">{body}</span>
            </span>
          </li>
        ))}
      </ol>
      <Link to={signedIn ? "/host" : "/register"} className="btn btn-outline relative mt-5 w-full">
        {signedIn ? "Go to Host" : "Create an account to host"} <ArrowRight size={15} aria-hidden="true" />
      </Link>
      <p className="relative mt-2 text-center text-xs text-faint">Hosting has its own space, with a Host plan from ₹499 a month.</p>
    </div>
  );
}

const FORMAT_SHORT: Record<ContestFormat, string> = {
  CODEFORCES: "Speed counts: points decay over time",
  ICPC: "Most solved, then least penalty",
  ATCODER: "Points, light time penalty",
  IOI: "Partial credit per test group",
};

function FormatsCard() {
  const formats: ContestFormat[] = ["CODEFORCES", "ICPC", "ATCODER", "IOI"];
  return (
    <div className="card p-6">
      <p className="font-display text-lg font-semibold text-ink">Scoring rules</p>
      <p className="mt-0.5 text-xs text-muted">Every round picks one. Hover a rule for the details.</p>
      <dl className="mt-4 grid grid-cols-2 gap-2">
        {formats.map((f) => (
          <div key={f} title={FORMAT_HELP[f]} className="rounded-xl border border-line/70 bg-paper/50 p-3 transition-colors hover:border-accent/40">
            <dt className="text-sm font-semibold text-ink">{FORMAT_LABELS[f].replace(" rules", "")}</dt>
            <dd className="mt-1 text-xs leading-snug text-muted">{FORMAT_SHORT[f]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Everything that has ended, newest first, searchable by title. */
function PastContests({ ready, exclude }: { ready: boolean; exclude?: string }) {
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
    queryKey: ["contests", "past", page, q, exclude ?? "all"],
    queryFn: () => contestsApi.list("past", page, 10, q || undefined, exclude),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  return (
    <section className="reveal mt-14 scroll-mt-24" aria-labelledby="past-heading">
      <SectionHead
        id="past-heading"
        icon={History}
        title={exclude ? "Past contests from others" : "Past contests"}
        count={past.data?.total}
        right={
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Search past contests</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input type="search" className="input min-h-[36px] pl-9" placeholder="Search past contests…" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        }
      />
      {past.isPending ? (
        <Spinner label="Loading contests…" />
      ) : past.isError ? (
        <ErrorState title="Couldn't load contests" message={past.error.message} onRetry={() => past.refetch()} />
      ) : past.data.items.length === 0 ? (
        <p className="card p-5 text-sm text-muted">{q ? `No past contest matches “${q}”.` : "No contest has finished yet."}</p>
      ) : (
        <div className={past.isPlaceholderData ? "opacity-60" : undefined}>
          <div className="card overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Contest</th>
                  <th scope="col">Date</th>
                  <th scope="col">Length</th>
                  <th scope="col">Rules</th>
                  <th scope="col">Participants</th>
                  <th scope="col">
                    <span className="sr-only">Links</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {past.data.items.map((c) => (
                  <tr key={c.slug}>
                    <td>
                      <Link to={`/contests/${c.slug}`} className="font-medium text-ink hover:text-accent">
                        {c.title}
                      </Link>
                      <div className="text-xs text-faint">by {c.authors.join(", ")}</div>
                    </td>
                    <td className="whitespace-nowrap text-muted">{formatWhen(c.starts_at)}</td>
                    <td className="text-muted">{formatDuration(c.duration_minutes)}</td>
                    <td className="text-muted">{FORMAT_LABELS[c.format].replace(" rules", "")}</td>
                    <td className="text-muted">{c.participants}</td>
                    <td className="whitespace-nowrap text-right">
                      <Link to={`/contests/${c.slug}/standings`} className="text-sm text-accent hover:underline">
                        Standings
                      </Link>
                      <Link to={`/contests/${c.slug}/editorial`} className="ml-4 text-sm text-muted hover:text-ink">
                        Editorial
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={past.data.page} totalPages={past.data.total_pages} onChange={setPage} />
        </div>
      )}
    </section>
  );
}
