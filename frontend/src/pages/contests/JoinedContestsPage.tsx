import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BarChart3, BookOpen, CalendarClock, Medal } from "lucide-react";
import { contestsApi } from "../../api/endpoints";
import type { JoinedContest } from "../../api/types";
import { ClockTiles, HubHero, HubTabs, SectionHead } from "../../components/ContestHub";
import { Countdown, FORMAT_LABELS, PhaseBadge, formatDuration, formatWhen, livePhase, useNow } from "../../components/contest";
import { ErrorState, Spinner } from "../../components/Feedback";

/**
 * Contests the signed-in user registered for: what is live or coming up
 * first, then their results. Hosting has its own page (Create → Hosted contests).
 */
export default function JoinedContestsPage() {
  const joined = useQuery({ queryKey: ["joined-contests"], queryFn: () => contestsApi.joined() });
  const now = useNow();

  if (joined.isPending) return <Spinner label="Loading your contests…" />;
  if (joined.isError) {
    return <ErrorState title="Couldn't load your contests" message={joined.error.message} onRetry={() => joined.refetch()} />;
  }

  const all = joined.data;
  const phase = (j: JoinedContest) => livePhase(j.contest.starts_at, j.contest.ends_at, now);
  const ahead = all.filter((j) => phase(j) !== "ENDED").sort((a, b) => a.contest.starts_at.localeCompare(b.contest.starts_at));
  const past = all.filter((j) => phase(j) === "ENDED");
  const placed = past.filter((j): j is JoinedContest & { rank: number } => j.rank !== null);
  const best = placed.reduce<(JoinedContest & { rank: number }) | null>((b, j) => (!b || j.rank < b.rank ? j : b), null);
  const podiums = placed.filter((j) => j.rank <= 3).length;

  return (
    <div>
      <HubTabs />
      <HubHero
        eyebrow="Your rounds"
        title="Joined contests"
        description="Every round you registered for: countdowns for what is next, and your place in everything that has ended."
        actions={
          <Link to="/contests" className="btn btn-primary min-h-[44px] px-5">
            Find a contest <ArrowRight size={16} aria-hidden="true" />
          </Link>
        }
        aside={<NextUp next={ahead[0]} best={best} now={now} />}
        stats={[
          { label: "Registered", value: all.length },
          { label: "Coming up", value: ahead.length, tone: ahead.length ? "accent" : undefined },
          { label: "Best place", value: best ? `#${best.rank}` : "—", tone: best ? "good" : undefined, hint: best ? best.contest.title : undefined },
          { label: "Problems solved", value: past.reduce((n, j) => n + j.solved, 0), hint: podiums ? `${podiums} podium finish${podiums === 1 ? "" : "es"}` : undefined },
        ]}
      />

      <section aria-labelledby="ahead-h" className="reveal mb-12">
        <SectionHead id="ahead-h" icon={CalendarClock} title="Live and upcoming" count={ahead.length} />
        {ahead.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-2xl border border-dashed border-line-strong/70 bg-surface/50 p-6 sm:flex-row sm:items-center">
            <span className="icon-tile h-12 w-12 shrink-0 rounded-2xl">
              <CalendarClock size={22} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <p className="font-semibold text-ink">Nothing on your calendar</p>
              <p className="mt-0.5 text-sm text-muted">Register for an upcoming round and its countdown shows up here.</p>
            </div>
            <Link to="/contests" className="btn btn-outline">
              Register for the next round <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2" aria-label="Live and upcoming">
            {ahead.map((j) => (
              <li key={j.contest.slug}>
                <Link to={`/contests/${j.contest.slug}`} className="card card-hover flex h-full flex-col gap-3 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <PhaseBadge phase={phase(j)} />
                    <span className="text-xs text-faint">{FORMAT_LABELS[j.contest.format]}</span>
                  </div>
                  <p className="font-display text-xl font-semibold tracking-tight text-ink">{j.contest.title}</p>
                  <p className="text-sm">
                    <Countdown startsAt={j.contest.starts_at} endsAt={j.contest.ends_at} now={now} />
                  </p>
                  <p className="mt-auto border-t border-line/70 pt-3 text-xs text-faint">
                    {formatWhen(j.contest.starts_at)} · {formatDuration(j.contest.duration_minutes)} · {j.contest.participants} registered
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="past-h" className="reveal">
        <SectionHead id="past-h" icon={Medal} title="Results" count={past.length} />
        {past.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-strong/70 bg-surface/50 p-6 text-sm text-muted">
            Your results appear here once a contest you joined ends.
          </div>
        ) : (
          <ul className="space-y-3" aria-label="Results">
            {past.map((j) => (
              <ResultRow key={j.contest.slug} j={j} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The hero's right side: the next round's countdown, else your best finish. */
function NextUp({ next, best, now }: { next?: JoinedContest; best: (JoinedContest & { rank: number }) | null; now: number }) {
  if (next) {
    const live = livePhase(next.contest.starts_at, next.contest.ends_at, now) === "RUNNING";
    const target = new Date(live ? next.contest.ends_at : next.contest.starts_at).getTime();
    return (
      <div className="rounded-2xl border border-line/70 bg-surface/80 p-5 backdrop-blur">
        <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${live ? "text-good" : "text-faint"}`}>
          {live ? "Live · ends in" : "Your next round"}
        </p>
        <p className="mb-4 mt-2 truncate font-display text-lg font-semibold text-ink">{next.contest.title}</p>
        <ClockTiles ms={target - now} label={live ? "Time left" : "Time to the start"} />
        <Link to={`/contests/${next.contest.slug}`} className="btn btn-primary mt-4 w-full">
          {live ? "Enter the arena" : "Open the round"} <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>
    );
  }
  if (best) {
    return (
      <div className="flex items-center gap-4 rounded-2xl border border-line/70 bg-surface/80 p-5 backdrop-blur">
        <RankMedal rank={best.rank} size="lg" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Best finish</p>
          <p className="mt-1 truncate font-display text-lg font-semibold text-ink">{best.contest.title}</p>
          <p className="text-sm text-muted">
            #{best.rank} of {best.ranked} · {best.solved} solved{standing(best)}
          </p>
        </div>
      </div>
    );
  }
  return null;
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
