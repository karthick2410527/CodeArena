import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BadgeCheck, Check, Circle, ExternalLink, FileCode2, PenSquare, Plus, Settings2, Swords } from "lucide-react";
import { billingApi, contestsApi, studioApi } from "../../api/endpoints";
import type { ContestSummary } from "../../api/types";
import { HostTabs, HubHero, SectionHead } from "../../components/ContestHub";
import { useHosting } from "../../components/hosting";
import { Countdown, FORMAT_LABELS, PhaseBadge, formatDuration, formatWhen, livePhase, useNow } from "../../components/contest";
import { ErrorState, Spinner } from "../../components/Feedback";

/**
 * Host: everything about running rounds, apart from competing in them. The
 * contests you host or co-author (drafts included, with what each still
 * needs), your problems, and your plan.
 */
export default function MyContestsPage() {
  const mine = useQuery({ queryKey: ["my-contests"], queryFn: () => contestsApi.mine() });
  const host = useHosting();
  const now = useNow();
  const all = mine.data ?? [];
  const drafts = all.filter((c) => !c.published);
  const active = all.filter((c) => c.published && livePhase(c.starts_at, c.ends_at, now) !== "ENDED");
  const ended = all.filter((c) => c.published && livePhase(c.starts_at, c.ends_at, now) === "ENDED");

  return (
    <div>
      <HostTabs />
      <HubHero
        eyebrow="Host"
        title={
          <>
            Run your own <span className="text-accent-shine">rounds.</span>
          </>
        }
        description="The contests you host or co-author, drafts included, and the problems you write for them. Each card shows what is left before a round can go live."
        aside={<PlanCard />}
        actions={
          <>
            <Link to={host.to} className="btn btn-primary min-h-[44px] px-5">
              <Plus size={16} aria-hidden="true" /> {host.label}
            </Link>
            <Link to="/studio/problems" className="btn btn-outline min-h-[44px] px-5">
              <PenSquare size={16} aria-hidden="true" /> My problems
            </Link>
          </>
        }
        stats={
          mine.data
            ? [
                { label: "Contests", value: all.length },
                { label: "Drafts", value: drafts.length, tone: drafts.length ? "accent" : undefined },
                { label: "Published", value: active.length + ended.length, hint: active.length ? `${active.length} upcoming or live` : undefined },
                { label: "Registrations", value: all.reduce((n, c) => n + c.participants, 0) },
              ]
            : undefined
        }
      />

      {mine.isPending ? (
        <Spinner label="Loading your contests…" />
      ) : mine.isError ? (
        <ErrorState title="Couldn't load your contests" message={mine.error.message} onRetry={() => mine.refetch()} />
      ) : all.length === 0 ? (
        <div className="relative overflow-hidden rounded-2xl border border-dashed border-line-strong/70 bg-surface/50 px-6 py-14 text-center">
          <div className="pointer-events-none absolute left-1/2 top-0 h-40 w-72 -translate-x-1/2 rounded-full bg-accent/15 blur-3xl" aria-hidden="true" />
          <div className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-accent/25 bg-accent/10 text-accent">
            <Swords size={24} aria-hidden="true" />
          </div>
          <p className="relative mt-4 font-display text-lg font-semibold text-ink">You haven't hosted a contest yet</p>
          <p className="relative mx-auto mt-1 max-w-sm text-sm text-muted">
            Write a couple of problems in your studio, then set up a round and invite co-authors.
          </p>
          <Link to={host.to} className="btn btn-primary relative mt-5">
            {host.label} <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="space-y-12">
          <Group title="Drafts" items={drafts} now={now} />
          <Group title="Upcoming and live" items={active} now={now} />
          <Group title="Finished" items={ended} now={now} />
        </div>
      )}

      <YourProblems />
    </div>
  );
}

function Group({ title, items, now }: { title: string; items: ContestSummary[]; now: number }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="reveal">
      <SectionHead title={title} count={items.length} />
      <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {items.map((c) => (
          <li key={c.slug}>
            <HostedCard c={c} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HostedCard({ c, now }: { c: ContestSummary; now: number }) {
  const phase = livePhase(c.starts_at, c.ends_at, now);
  const steps: [string, boolean][] = [
    ["Details and schedule", true],
    [c.problem_count > 0 ? `${c.problem_count} problem${c.problem_count === 1 ? "" : "s"} added` : "Add problems", c.problem_count > 0],
    [c.published ? "Published" : "Publish it", c.published],
  ];
  const done = steps.filter(([, ok]) => ok).length;
  return (
    <article className="card card-hover flex h-full flex-col overflow-hidden">
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center justify-between gap-2">
          <PhaseBadge phase={phase} published={c.published} />
          <span className="chip">{c.my_role === "OWNER" ? "Owner" : "Co-author"}</span>
        </div>
        <h3 className="mt-3 font-display text-xl font-semibold tracking-tight text-ink">
          <Link to={`/contests/${c.slug}`} className="hover:text-accent">
            {c.title}
          </Link>
        </h3>
        <p className="mt-1 text-xs text-faint">
          {formatWhen(c.starts_at)} · {formatDuration(c.duration_minutes)} · {FORMAT_LABELS[c.format]}
        </p>
        <p className="mt-2 text-sm">
          <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
          <span className="text-faint"> · {c.participants} registered</span>
        </p>

        {!c.published && (
          <div className="mt-4 rounded-xl border border-line/70 bg-paper/50 p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium text-ink">Setup</span>
              <span className="text-faint tabular">
                {done} of {steps.length}
              </span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${(done / steps.length) * 100}%` }} />
            </div>
            <ul className="mt-3 space-y-1.5">
              {steps.map(([label, ok]) => (
                <li key={label} className={`flex items-center gap-2 text-xs ${ok ? "text-muted" : "font-medium text-ink"}`}>
                  {ok ? (
                    <span className="grid h-4 w-4 place-items-center rounded-full bg-good/15 text-good">
                      <Check size={10} strokeWidth={3} aria-hidden="true" />
                    </span>
                  ) : (
                    <Circle size={16} className="text-line-strong" aria-hidden="true" />
                  )}
                  {label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line/70 bg-paper/40 px-5 py-3">
        <Link to={`/contests/${c.slug}/manage`} className="btn btn-primary min-h-[34px] flex-1 px-3 text-xs" aria-label={`Manage ${c.title}`}>
          <Settings2 size={14} aria-hidden="true" /> Manage
        </Link>
        <Link to={`/contests/${c.slug}`} className="btn btn-outline min-h-[34px] px-3 text-xs" aria-label={`Open ${c.title}`}>
          <ExternalLink size={14} aria-hidden="true" /> View
        </Link>
      </div>
    </article>
  );
}

/** The hero's right side: whether you can host right now, and until when. */
function PlanCard() {
  const me = useQuery({ queryKey: ["billing-me"], queryFn: () => billingApi.me(), staleTime: 60_000 });
  if (!me.data) return null;
  const until = me.data.hosting_until ? new Date(me.data.hosting_until) : null;
  const active = until !== null && until.getTime() > Date.now();
  const days = until ? Math.ceil((until.getTime() - Date.now()) / 86_400_000) : 0;
  return (
    <div className="rounded-2xl border border-line/70 bg-surface/80 p-5 backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Host plan</p>
      {active ? (
        <>
          <p className="mt-2 flex items-center gap-2 font-display text-lg font-semibold text-ink">
            <BadgeCheck size={18} className="text-good" aria-hidden="true" /> Active
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {days} day{days === 1 ? "" : "s"} left, until {formatWhen(until!.toISOString())}
          </p>
        </>
      ) : me.data.can_host ? (
        <p className="mt-2 text-sm text-muted">{me.data.required ? "Admins host without a plan." : "Hosting is free on this server."}</p>
      ) : (
        <p className="mt-2 text-sm text-muted">{until ? "Your plan has ended. Renew it to publish again." : "You need a plan to host a contest."}</p>
      )}
      <Link to="/pricing" className="btn btn-outline mt-4 w-full min-h-[36px] text-sm">
        {active ? "Extend or see payments" : me.data.can_host ? "See plans" : "Get a Host plan"}
      </Link>
    </div>
  );
}

/** A glance at the problems you've written, most recent first. */
function YourProblems() {
  const problems = useQuery({
    queryKey: ["admin-problems", "studio", { page: 1, limit: 6 }],
    queryFn: () => studioApi.listProblems({ page: 1, limit: 6 }),
  });
  const items = problems.data?.items ?? [];
  return (
    <section aria-labelledby="your-problems-h" className="reveal mt-12">
      <SectionHead
        id="your-problems-h"
        icon={FileCode2}
        title="Your problems"
        count={problems.data?.total}
        right={
          <div className="flex gap-2">
            <Link to="/studio/problems" className="btn btn-ghost min-h-[34px] px-3 text-xs">
              All problems
            </Link>
            <Link to="/studio/problems/new" className="btn btn-outline min-h-[34px] px-3 text-xs">
              <Plus size={14} aria-hidden="true" /> New problem
            </Link>
          </div>
        }
      />
      {problems.isPending ? (
        <Spinner label="Loading your problems…" />
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line-strong/70 bg-surface/50 p-6 text-sm text-muted">
          No problems yet. Write one, or import one from Codeforces or AtCoder, then add it to a contest.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((p) => (
            <li key={p.id}>
              <Link to={`/studio/problems/${p.id}`} className="card card-hover block p-4">
                <p className="truncate font-semibold text-ink">{p.title}</p>
                <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-faint">
                  <span>{p.difficulty[0] + p.difficulty.slice(1).toLowerCase()}</span>
                  <span>·</span>
                  <span>
                    {p.sample_count} sample{p.sample_count === 1 ? "" : "s"}, {p.hidden_count} hidden
                  </span>
                  {p.contests.length > 0 && (
                    <>
                      <span>·</span>
                      <span>
                        in {p.contests.length} contest{p.contests.length === 1 ? "" : "s"}
                      </span>
                    </>
                  )}
                </p>
                {p.hidden_count === 0 && <p className="mt-2 text-xs font-medium text-warn">needs hidden tests</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
