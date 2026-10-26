import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BadgeCheck, CalendarClock, Check, FileCode2, PenLine, PenSquare, Plus, Radio, Settings2, Sparkles, Trophy, Users } from "lucide-react";
import { billingApi, contestsApi, studioApi } from "../../api/endpoints";
import type { AdminProblem, ContestSummary, Paginated } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { HostTabs } from "../../components/ContestHub";
import { Ring } from "../../components/flair";
import { useHosting } from "../../components/hosting";
import { Countdown, FORMAT_LABELS, formatDuration, formatWhen, livePhase, useNow } from "../../components/contest";
import { ErrorState, Spinner } from "../../components/Feedback";
import { ContestBuilder } from "../../components/visuals";

type Stage = "draft" | "scheduled" | "live" | "finished";

const STAGES: [Stage, string, typeof PenLine, string][] = [
  ["draft", "Draft", PenLine, "Only you and your co-authors see these"],
  ["scheduled", "Scheduled", CalendarClock, "Public; people are registering"],
  ["live", "Live", Radio, "Running right now"],
  ["finished", "Finished", Trophy, "Standings and editorial are out"],
];

function greeting(hour: number) {
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/**
 * Host, as a control room: every contest you run on one board from draft to
 * finished, what each still needs, your plan and your problems.
 */
export default function MyContestsPage() {
  const { user } = useAuth();
  const mine = useQuery({ queryKey: ["my-contests"], queryFn: () => contestsApi.mine() });
  const problems = useQuery({
    queryKey: ["admin-problems", "studio", { page: 1, limit: 6 }],
    queryFn: () => studioApi.listProblems({ page: 1, limit: 6 }),
  });
  const host = useHosting();
  const now = useNow();

  const all = mine.data ?? [];
  const stageOf = (c: ContestSummary): Stage => {
    if (!c.published) return "draft";
    const p = livePhase(c.starts_at, c.ends_at, now);
    return p === "UPCOMING" ? "scheduled" : p === "RUNNING" ? "live" : "finished";
  };
  const board: Record<Stage, ContestSummary[]> = { draft: [], scheduled: [], live: [], finished: [] };
  for (const c of all) board[stageOf(c)].push(c);
  const newcomer = mine.data !== undefined && all.length === 0;
  const name = user?.display_name?.split(" ")[0] ?? user?.username;

  return (
    <div className="mx-auto max-w-6xl">
      <HostTabs />
      <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-1.5">Host</p>
          <h1 className="font-display text-[2.25rem] font-semibold leading-none tracking-tight text-ink sm:text-[2.75rem]">Your contests</h1>
          <p className="mt-2.5 text-[0.9375rem] text-muted">
            {greeting(new Date(now).getHours())}
            {name ? `, ${name}` : ""}.{" "}
            {mine.data
              ? all.length
                ? `${board.live.length ? `${board.live.length} live, ` : ""}${board.scheduled.length} scheduled, ${board.draft.length} in draft.`
                : "Let's set up your first round."
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/studio/problems/new" className="btn btn-outline min-h-[44px] px-5">
            <PenSquare size={16} aria-hidden="true" /> New problem
          </Link>
          <Link to={host.to} className="btn btn-primary min-h-[44px] px-5">
            <Plus size={16} aria-hidden="true" /> {host.canHost ? "New contest" : host.label}
          </Link>
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-6">
          {newcomer && <GettingStarted problemCount={problems.data?.total ?? 0} hostTo={host.to} canHost={host.canHost} />}
          {mine.isPending ? (
            <Spinner label="Loading your contests…" />
          ) : mine.isError ? (
            <ErrorState title="Couldn't load your contests" message={mine.error.message} onRetry={() => mine.refetch()} />
          ) : (
            !newcomer && (
              <section aria-labelledby="board-h">
                <h2 id="board-h" className="sr-only">
                  Contests by stage
                </h2>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Your contests" role="list">
                  {STAGES.map(([stage, label, Icon, hint]) => (
                    <div key={stage} role="listitem" className="flex min-w-0 flex-col rounded-2xl border border-line/70 bg-paper/50 p-3">
                      <div className="mb-3 flex items-center justify-between px-1" title={hint}>
                        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                          <Icon size={15} className={stage === "live" ? "text-good" : "text-accent"} aria-hidden="true" />
                          {label}
                        </p>
                        <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium tabular text-faint ring-1 ring-line/70">{board[stage].length}</span>
                      </div>
                      {board[stage].length === 0 ? (
                        <p className="rounded-xl border border-dashed border-line-strong/60 px-3 py-6 text-center text-xs text-faint">{hint}</p>
                      ) : (
                        <ul className="space-y-2">
                          {board[stage].map((c) => (
                            <BoardCard key={c.slug} c={c} stage={stage} now={now} />
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )
          )}
        </div>

        <div className="space-y-4 lg:sticky lg:top-24">
          <PlanCard />
          <YourProblems data={problems.data} loading={problems.isPending} />
        </div>
      </div>
    </div>
  );
}

/** A contest on the board, with what it needs next. */
function BoardCard({ c, stage, now }: { c: ContestSummary; stage: Stage; now: number }) {
  // A draft is ready when it has problems; publishing is the last step.
  const steps = 1 + (c.problem_count > 0 ? 1 : 0);
  return (
    <li className="group rounded-xl border border-line/80 bg-surface p-3 shadow-sm transition-[border-color,box-shadow] hover:border-accent/40 hover:shadow-panel">
      <div className="flex items-start gap-3">
        {stage === "draft" && <Ring value={steps} max={3} label={`Setup ${steps} of 3`} />}
        <div className="min-w-0 flex-1">
          <Link to={`/contests/${c.slug}/manage`} className="block truncate text-sm font-semibold text-ink hover:text-accent">
            {c.title}
          </Link>
          <p className="mt-0.5 truncate text-xs text-faint">
            {formatWhen(c.starts_at)} · {formatDuration(c.duration_minutes)}
          </p>
        </div>
      </div>
      <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1">
          <FileCode2 size={12} aria-hidden="true" /> {c.problem_count}
        </span>
        <span className="flex items-center gap-1">
          <Users size={12} aria-hidden="true" /> {c.participants}
        </span>
        <span className="truncate">{FORMAT_LABELS[c.format].replace(" rules", "")}</span>
        {c.my_role === "AUTHOR" && <span className="chip px-1.5 py-0 text-[0.625rem]">co-author</span>}
      </p>
      {stage === "draft" && (
        <p className="mt-2 text-xs font-medium text-warn">{c.problem_count === 0 ? "Next: add problems" : "Next: publish it"}</p>
      )}
      {(stage === "scheduled" || stage === "live") && (
        <p className="mt-2 text-xs">
          <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
        </p>
      )}
      <div className="mt-3 flex gap-1.5">
        <Link to={`/contests/${c.slug}/manage`} className="btn btn-outline min-h-[30px] flex-1 px-2 text-xs" aria-label={`Manage ${c.title}`}>
          <Settings2 size={12} aria-hidden="true" /> Manage
        </Link>
        <Link to={stage === "finished" ? `/contests/${c.slug}/standings` : `/contests/${c.slug}`} className="btn btn-ghost min-h-[30px] px-2 text-xs" aria-label={`Open ${c.title}`}>
          <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </div>
    </li>
  );
}

/** Your Host plan, as a membership card. */
function PlanCard() {
  const me = useQuery({ queryKey: ["billing-me"], queryFn: () => billingApi.me(), staleTime: 60_000 });
  if (!me.data) return null;
  const until = me.data.hosting_until ? new Date(me.data.hosting_until) : null;
  const active = until !== null && until.getTime() > Date.now();
  const days = until ? Math.ceil((until.getTime() - Date.now()) / 86_400_000) : 0;
  const ok = active || me.data.can_host;
  const title = active ? "Host plan" : me.data.can_host ? (me.data.required ? "Admin hosting" : "Free hosting") : until ? "Plan ended" : "No Host plan";
  const line = active
    ? `${days} day${days === 1 ? "" : "s"} left · until ${formatWhen(until!.toISOString())}`
    : me.data.can_host
      ? "You can publish contests"
      : "Needed to publish a contest";
  return (
    <div
      className={`relative overflow-hidden rounded-2xl p-5 text-white shadow-[0_20px_40px_-24px_rgb(0_0_0/0.5)] ${ok ? "" : "opacity-95"}`}
      style={{
        background: ok
          ? "linear-gradient(135deg, rgb(var(--c-accent)) 0%, rgb(var(--c-accent-hover)) 60%, rgb(15 23 42) 140%)"
          : "linear-gradient(135deg, rgb(71 85 105) 0%, rgb(30 41 59) 100%)",
      }}
    >
      <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/15 blur-2xl" aria-hidden="true" />
      <div className="relative flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-white/80">
          <BadgeCheck size={14} aria-hidden="true" /> VoidRun Host
        </p>
        <Sparkles size={16} className="text-white/70" aria-hidden="true" />
      </div>
      <p className="relative mt-6 font-display text-xl font-semibold">{title}</p>
      <p className="relative mt-0.5 text-sm text-white/80">{line}</p>
      {active && (
        <div className="relative mt-3 h-1 overflow-hidden rounded-full bg-white/20">
          <div className="h-full rounded-full bg-white" style={{ width: `${Math.min(100, (days / 365) * 100)}%` }} />
        </div>
      )}
      <Link to="/pricing" className="relative mt-4 inline-flex items-center gap-1 text-sm font-semibold text-white hover:underline">
        {active ? "Manage plan" : ok ? "See plans" : "Get a Host plan"} <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </div>
  );
}

/** The three steps, with an illustration, until the first contest exists. */
function GettingStarted({ problemCount, hostTo, canHost }: { problemCount: number; hostTo: string; canHost: boolean }) {
  const steps: [string, string, boolean, string | null, string][] = [
    ["Write or import a problem", "From scratch, or paste a Codeforces or AtCoder link.", problemCount > 0, "/studio/problems/new", problemCount > 0 ? "Add another" : "New problem"],
    ["Set up the contest", "Pick the rules and the time, then add your problems.", false, hostTo, canHost ? "New contest" : "Get a Host plan"],
    ["Publish it", "People register, compete and watch live standings.", false, null, ""],
  ];
  return (
    <section aria-labelledby="start-h" className="overflow-hidden rounded-[1.5rem] border border-line/80 bg-surface shadow-panel">
      <div className="grid gap-6 p-5 sm:p-7 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-center">
        <div>
          <h2 id="start-h" className="font-display text-xl font-semibold tracking-tight text-ink">
            Host your first round in three steps
          </h2>
          <ol className="mt-5 space-y-4">
            {steps.map(([title, hint, done, to, cta], i) => (
              <li key={title} className="flex gap-3">
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-sm font-semibold ${done ? "bg-good/15 text-good" : "bg-accent/10 text-accent"}`}>
                  {done ? <Check size={15} strokeWidth={3} aria-hidden="true" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{title}</p>
                  <p className="text-sm text-muted">{hint}</p>
                </div>
                {to && (
                  <Link to={to} className="shrink-0 self-center text-sm font-medium text-accent hover:underline">
                    {cta} →
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </div>
        <ContestBuilder />
      </div>
    </section>
  );
}

/** Your latest problems beside the board, flagging the ones that can't be judged yet. */
function YourProblems({ data, loading }: { data?: Paginated<AdminProblem>; loading: boolean }) {
  const items = data?.items ?? [];
  return (
    <aside aria-labelledby="your-problems-h" className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
        <h2 id="your-problems-h" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <FileCode2 size={15} className="text-accent" aria-hidden="true" /> Your problems
          {data && <span className="rounded-full bg-sunken px-1.5 text-xs font-medium text-faint">{data.total}</span>}
        </h2>
        <Link to="/studio/problems/new" className="text-xs font-medium text-accent hover:underline">
          + New
        </Link>
      </div>
      {loading ? (
        <p className="px-4 py-5 text-sm text-faint">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted">No problems yet. Write one, or import one from Codeforces or AtCoder.</p>
      ) : (
        <ul className="divide-y divide-line/70">
          {items.map((p) => (
            <li key={p.id}>
              <Link to={`/studio/problems/${p.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-sunken/50">
                <span className={`h-2 w-2 shrink-0 rounded-full ${p.hidden_count === 0 ? "bg-warn" : "bg-good"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{p.title}</span>
                  <span className="block text-xs text-faint">
                    {p.sample_count} sample{p.sample_count === 1 ? "" : "s"}, {p.hidden_count} hidden
                    {p.contests.length > 0 && ` · in ${p.contests.length} contest${p.contests.length === 1 ? "" : "s"}`}
                  </span>
                </span>
                {p.hidden_count === 0 && <span className="shrink-0 text-xs font-medium text-warn">needs tests</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/studio/problems" className="flex items-center justify-center gap-1.5 border-t border-line/70 px-4 py-2.5 text-sm font-medium text-accent hover:bg-sunken/40">
        All problems <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </aside>
  );
}
