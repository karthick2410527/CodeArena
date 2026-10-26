import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  Flame,
  Link2,
  Pencil,
  PenLine,
  Sparkles,
  Target,
  Trophy,
} from "lucide-react";
import { ApiError } from "../api/client";
import { profilesApi } from "../api/endpoints";
import type { ActivityDay, ContestHistoryEntry, Profile } from "../api/types";
import DifficultyBadge from "../components/DifficultyBadge";
import { EmptyState, ErrorState, Spinner } from "../components/Feedback";
import { FORMAT_LABELS, formatWhen } from "../components/contest";
import { Avatar } from "../components/people";
import { EditProfileDialog } from "../components/EditProfile";
import { useAuth } from "../auth/AuthContext";

/** Anyone's public profile, at /u/:username. */
export default function UserProfilePage() {
  const { username = "" } = useParams();
  return <ProfileView username={username} />;
}

/** Levels earned by solving: a goal to climb towards, not a rating. */
const LEVELS: [number, string][] = [
  [100, "Master"],
  [50, "Expert"],
  [25, "Specialist"],
  [10, "Solver"],
  [1, "Explorer"],
  [0, "Newcomer"],
];

export function level(solved: number): { name: string; next: number | null } {
  const i = LEVELS.findIndex(([min]) => solved >= min);
  return { name: LEVELS[i][1], next: i > 0 ? LEVELS[i - 1][0] : null };
}

/** The public profile: who, how far they've come, when they practise, and how their contests went. */
export function ProfileView({
  username,
  account,
}: {
  username: string;
  account?: ReactNode;
}) {
  const profile = useQuery({
    queryKey: ["profile", username.toLowerCase()],
    queryFn: ({ signal }) => profilesApi.get(username, signal),
  });
  // Account settings (on your own profile) stay reachable even if the profile
  // itself cannot load, and keep one place in the tree, so they never remount.
  if (profile.isPending || profile.isError) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        {profile.isPending ? (
          <Spinner label="Loading the profile…" />
        ) : profile.error instanceof ApiError &&
          profile.error.status === 404 ? (
          <EmptyState
            title="No such user"
            message={`Nobody is called ${username}.`}
          />
        ) : (
          <ErrorState
            title="Couldn't load the profile"
            message={profile.error?.message}
            onRetry={() => profile.refetch()}
          />
        )}
        {account}
        {null}
      </div>
    );
  }
  const p = profile.data;
  const ranked = p.contests.filter((c) => c.rank !== null);
  const best = ranked.reduce<ContestHistoryEntry | null>(
    (b, c) => (!b || (c.rank ?? 1e9) < (b.rank ?? 1e9) ? c : b),
    null,
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-6">
        <Hero p={p} />
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi
            icon={Target}
            label="Problems solved"
            value={p.solved.total}
            note={`${p.submissions} submissions`}
          />
          <Kpi
            icon={Check}
            label="Acceptance"
            value={`${p.acceptance_rate}%`}
            note={`${p.accepted} accepted`}
          />
          <Kpi
            icon={Flame}
            label="Current streak"
            value={`${p.current_streak} d`}
            note={`longest ${p.longest_streak} d`}
          />
          <Kpi
            icon={Trophy}
            label="Best finish"
            value={best ? `#${best.rank}` : "—"}
            note={
              best
                ? `of ${best.participants} · ${best.title}`
                : `${p.contests.length} contests`
            }
          />
        </dl>
      </div>

      {account}

      <div className="space-y-6">
        <section className="reveal card p-5 sm:p-6" aria-labelledby="activity-h">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="activity-h" className="text-base font-semibold text-ink">
              Activity
            </h2>
            <ActivitySummary days={p.activity} longest={p.longest_streak} />
          </div>
          <Heatmap days={p.activity} />
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <section className="reveal card p-5 sm:p-6" aria-labelledby="solved-h">
            <h2 id="solved-h" className="text-base font-semibold text-ink">
              Solved by difficulty
            </h2>
            <Difficulty p={p} />
          </section>
          <section className="reveal card p-5 sm:p-6" aria-labelledby="perf-h">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="perf-h" className="text-base font-semibold text-ink">
                Contest finishes
              </h2>
              <span className="text-xs text-faint">
                higher is better · top % of the field
              </span>
            </div>
            <FinishChart contests={ranked} />
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="reveal card overflow-hidden" aria-labelledby="recent-h">
            <h2
              id="recent-h"
              className="border-b border-line px-5 py-3.5 text-base font-semibold text-ink"
            >
              Recently solved
            </h2>
            {p.recent.length === 0 ? (
              <p className="px-5 py-6 text-sm text-faint">
                Nothing solved yet.
              </p>
            ) : (
              <ul className="divide-y divide-line/70">
                {p.recent.map((r) => (
                  <li
                    key={r.slug}
                    className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                  >
                    <Link
                      to={`/problems/${r.slug}`}
                      className="min-w-0 truncate font-medium text-ink hover:text-accent"
                    >
                      {r.title}
                    </Link>
                    <span className="flex shrink-0 items-center gap-3">
                      <DifficultyBadge difficulty={r.difficulty} />
                      <span className="w-20 text-right text-xs text-faint">
                        {new Date(r.solved_at).toLocaleDateString()}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section
            className="card overflow-hidden"
            aria-labelledby="contests-h"
          >
            <h2
              id="contests-h"
              className="flex items-center justify-between border-b border-line px-5 py-3.5 text-base font-semibold text-ink"
            >
              Contests
              {(p.contests_hosted > 0 || p.problems_authored > 0) && (
                <span className="flex items-center gap-1.5 text-xs font-normal text-muted">
                  <PenLine size={13} aria-hidden="true" /> hosted{" "}
                  {p.contests_hosted} · wrote {p.problems_authored} problems
                </span>
              )}
            </h2>
            {p.contests.length === 0 ? (
              <p className="px-5 py-6 text-sm text-faint">
                No contests yet.{" "}
                <Link to="/contests" className="text-accent hover:underline">
                  Find one to join
                </Link>
              </p>
            ) : (
              <ul className="divide-y divide-line/70">
                {p.contests.map((c) => (
                  <li
                    key={c.slug}
                    className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                  >
                    <span className="min-w-0">
                      <Link
                        to={`/contests/${c.slug}`}
                        className="block truncate font-medium text-ink hover:text-accent"
                      >
                        {c.title}
                      </Link>
                      <span className="text-xs text-faint">
                        {formatWhen(c.starts_at)} · {FORMAT_LABELS[c.format]}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      {c.rank === null ? (
                        <span className="text-xs text-faint">
                          {c.phase === "UPCOMING" ? "registered" : "—"}
                        </span>
                      ) : (
                        <>
                          <span className="text-base font-semibold text-ink">
                            #{c.rank}
                          </span>
                          <span className="text-xs text-faint">
                            {" "}
                            / {c.participants}
                          </span>
                          <span className="block text-xs text-muted">
                            {c.solved} solved
                          </span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---- hero ----------------------------------------------------------------------------

function Hero({ p }: { p: Profile }) {
  const lv = level(p.solved.total);
  const [copied, setCopied] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [editing, setEditing] = useState(false);
  const mine = user?.username.toLowerCase() === p.username.toLowerCase();
  const share = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/u/${encodeURIComponent(p.username)}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable: nothing to do */
    }
  };
  return (
    <header className="panel overflow-hidden">
      <div
        className="relative h-28 sm:h-36"
        style={{
          background:
            "radial-gradient(600px 220px at 15% 0%, rgb(var(--c-accent) / 0.45), transparent 70%), radial-gradient(500px 200px at 90% 120%, rgb(var(--c-accent) / 0.25), transparent 70%), rgb(var(--c-sunken))",
        }}
        aria-hidden="true"
      >
        <div className="hero-grid absolute inset-0 opacity-70" />
      </div>
      <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end sm:justify-between sm:px-8 sm:pb-6">
        <div className="relative z-10 -mt-12 flex items-end gap-4 sm:-mt-14">
          <span className="rounded-full bg-surface p-1.5 shadow-panel">
            <Avatar username={p.username} url={p.avatar_url} size={96} />
          </span>
          <div className="pb-1">
            <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              {p.display_name ?? p.username}
            </h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span>@{p.username}</span>
              <span className="flex items-center gap-1 text-faint">
                <CalendarDays size={13} aria-hidden="true" /> Joined{" "}
                {new Date(p.joined_at).toLocaleDateString(undefined, {
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-medium text-accent"
            title={
              lv.next !== null
                ? `${lv.next - p.solved.total} more to the next level`
                : "Top level"
            }
          >
            <Sparkles size={14} aria-hidden="true" /> {lv.name}
          </span>
          {p.role === "ADMIN" && <span className="chip">admin</span>}
          {mine && user && (
            <button type="button" className="btn btn-outline min-h-[34px] px-3 text-xs" onClick={() => setEditing(true)}>
              <Pencil size={14} aria-hidden="true" /> Edit profile
            </button>
          )}
          <button
            type="button"
            className="btn btn-outline min-h-[34px] px-3 text-xs"
            onClick={share}
          >
            <Link2 size={14} aria-hidden="true" />{" "}
            {copied ? "Link copied" : "Share profile"}
          </button>
        </div>
      </div>
      {editing && user && (
        <EditProfileDialog
          user={user}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            if (next.username !== p.username && pathname.startsWith("/u/")) {
              navigate(`/u/${encodeURIComponent(next.username)}`, { replace: true });
            }
          }}
        />
      )}
      {lv.next !== null && (
        <div className="px-5 pb-5 sm:px-8">
          <div className="flex justify-between text-xs text-faint">
            <span>
              {p.solved.total} solved · {lv.next - p.solved.total} to the next
              level
            </span>
            <span>{lv.next}</span>
          </div>
          <div className="progress-track mt-1.5">
            <div
              className="progress-fill"
              style={{
                width: `${Math.min(100, (p.solved.total / lv.next) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}
    </header>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Trophy;
  label: string;
  value: ReactNode;
  note: string;
}) {
  return (
    <div className="card p-5">
      <dt className="flex items-center gap-2 text-sm text-muted">
        <span className="icon-tile h-8 w-8 rounded-lg">
          <Icon size={15} aria-hidden="true" />
        </span>
        {label}
      </dt>
      {/* A plain sans face for the headline figure: display faces read as decoration here. */}
      <dd className="mt-3 text-3xl font-semibold tracking-tight text-ink">
        {value}
      </dd>
      <dd className="mt-1 truncate text-xs text-faint">{note}</dd>
    </div>
  );
}

// ---- activity ----------------------------------------------------------------------

function ActivitySummary({
  days,
  longest,
}: {
  days: ActivityDay[];
  longest: number;
}) {
  const total = days.reduce((n, d) => n + d.submissions, 0);
  const active = days.filter((d) => d.submissions > 0).length;
  return (
    <p className="text-sm text-muted">
      <span className="font-medium text-ink">{total}</span> submissions in the
      last year · <span className="font-medium text-ink">{active}</span> active
      days · longest streak{" "}
      <span className="font-medium text-ink">{longest} d</span>
    </p>
  );
}

const SHADES = [
  "bg-sunken",
  "bg-accent/25",
  "bg-accent/45",
  "bg-accent/70",
  "bg-accent",
];
const level4 = (n: number) =>
  n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4;

/**
 * A year of days: a column per week, Sunday at the top, one hue from faint to
 * full for more submissions. It always fits the card (cells scale with the
 * width), and hovering a day says exactly what happened on it.
 */
function Heatmap({ days }: { days: ActivityDay[] }) {
  const [hover, setHover] = useState<{
    date: string;
    n: number;
    ok: number;
    col: number;
    row: number;
  } | null>(null);
  const { weeks, months } = useMemo(() => {
    const byDate = new Map(days.map((d) => [d.date, d]));
    const now = new Date();
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    // 53 whole weeks, Sunday first, ending with the current week.
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - end.getUTCDay() - 52 * 7);
    const weeks: { date: string; n: number; ok: number; future: boolean }[][] =
      [];
    const months: { col: number; label: string }[] = [];
    for (let w = 0; w < 53; w++) {
      const week: (typeof weeks)[number] = [];
      for (let dow = 0; dow < 7; dow++) {
        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + w * 7 + dow);
        const key = d.toISOString().slice(0, 10);
        const day = byDate.get(key);
        week.push({
          date: key,
          n: day?.submissions ?? 0,
          ok: day?.accepted ?? 0,
          future: d > end,
        });
        // Label a month at the week holding its 1st, unless that would crowd the previous label.
        if (
          d.getUTCDate() === 1 &&
          (months.length === 0 || w - months[months.length - 1].col >= 3)
        ) {
          months.push({
            col: w,
            label: d.toLocaleDateString(undefined, {
              month: "short",
              timeZone: "UTC",
            }),
          });
        }
      }
      weeks.push(week);
    }
    return { weeks, months };
  }, [days]);
  const activeDays = days.filter((d) => d.submissions > 0);

  return (
    <div className="mt-5">
      <div className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2">
        <div />
        <div
          className="relative mb-1.5 h-4 text-[0.6875rem] text-faint"
          aria-hidden="true"
        >
          {months.map((m) => (
            <span
              key={`${m.col}-${m.label}`}
              className="absolute"
              style={{ left: `${(m.col / weeks.length) * 100}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div
          className="grid grid-rows-7 gap-[3px] text-[0.625rem] leading-none text-faint"
          aria-hidden="true"
        >
          {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => (
            <span key={i} className="flex items-center">
              {d}
            </span>
          ))}
        </div>
        <div
          className="relative grid gap-[3px]"
          style={{
            gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))`,
          }}
          role="img"
          aria-label={`Submissions per day over the last year: ${activeDays.length} active days`}
          onMouseLeave={() => setHover(null)}
        >
          {weeks.map((w, col) => (
            <div key={col} className="grid grid-rows-7 gap-[3px]">
              {w.map((d, row) => (
                <span
                  key={d.date}
                  onMouseEnter={() => !d.future && setHover({ ...d, col, row })}
                  className={`aspect-square w-full rounded-[3px] ${d.future ? "opacity-0" : SHADES[level4(d.n)]} ${
                    hover?.date === d.date ? "ring-2 ring-ink/40" : ""
                  }`}
                />
              ))}
            </div>
          ))}
          {hover && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-panel"
              style={{
                left: `${((hover.col + 0.5) / weeks.length) * 100}%`,
                top: `${(hover.row / 7) * 100}%`,
                marginTop: -6,
              }}
            >
              <span className="font-semibold text-ink">
                {hover.n} submission{hover.n === 1 ? "" : "s"}
              </span>
              {hover.n > 0 && (
                <span className="text-muted"> · {hover.ok} accepted</span>
              )}
              <span className="block text-faint">
                {new Date(`${hover.date}T00:00:00Z`).toLocaleDateString(
                  undefined,
                  {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    timeZone: "UTC",
                  },
                )}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[0.6875rem] text-faint">
        Less
        {SHADES.map((s) => (
          <span
            key={s}
            className={`h-2.5 w-2.5 rounded-[3px] ${s}`}
            aria-hidden="true"
          />
        ))}
        More
      </div>
      {/* The same data without the chart. */}
      <ul className="sr-only">
        {activeDays.map((d) => (
          <li key={d.date}>
            {d.date}: {d.submissions} submissions, {d.accepted} accepted
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- difficulty -----------------------------------------------------------------------

/** One bar split by difficulty (ordinal, so one hue from light to dark), with the counts written out. */
function Difficulty({ p }: { p: Profile }) {
  const parts: [string, number, string][] = [
    ["Easy", p.solved.easy, "bg-accent/[0.35]"],
    ["Medium", p.solved.medium, "bg-accent/[0.65]"],
    ["Hard", p.solved.hard, "bg-accent"],
  ];
  const total = Math.max(1, p.solved.total);
  return (
    <div className="mt-4">
      <p className="text-3xl font-semibold tracking-tight text-ink">
        {p.solved.total}
        <span className="ml-2 text-sm font-normal text-muted">
          problems solved
        </span>
      </p>
      <div
        className="mt-4 flex h-3 gap-[2px] overflow-hidden rounded-full bg-sunken"
        aria-hidden="true"
      >
        {parts
          .filter(([, n]) => n > 0)
          .map(([label, n, color]) => (
            <span
              key={label}
              className={color}
              style={{ width: `${(n / total) * 100}%` }}
              title={`${label}: ${n}`}
            />
          ))}
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        {parts.map(([label, n, color]) => (
          <div
            key={label}
            className="rounded-xl border border-line/70 bg-paper/50 p-3"
          >
            <dt className="flex items-center gap-2 text-xs text-muted">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`}
                aria-hidden="true"
              />
              {label}
            </dt>
            <dd className="mt-1 text-xl font-semibold text-ink">{n}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---- contest finishes ------------------------------------------------------------------

/**
 * Each finished contest as "top X%" of its field, oldest to newest: a single
 * series, so no legend; hover a point for the contest. The list below the
 * chart carries the same numbers.
 */
function FinishChart({ contests }: { contests: ContestHistoryEntry[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the card's real width, so text and marks keep their size instead of scaling with a viewBox.
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const points = useMemo(
    () =>
      [...contests]
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
        .map((c) => ({
          c,
          // 100 = first place, 0 = last.
          score:
            c.participants <= 1
              ? 100
              : 100 - ((c.rank! - 1) / (c.participants - 1)) * 100,
          top: Math.max(
            1,
            Math.round((c.rank! / Math.max(1, c.participants)) * 100),
          ),
        })),
    [contests],
  );
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [points.length]);
  if (points.length === 0) {
    return (
      <p className="mt-6 rounded-xl border border-dashed border-line p-6 text-center text-sm text-faint">
        Finish a contest to start this chart.{" "}
        <Link to="/contests" className="text-accent hover:underline">
          See what’s on
        </Link>
      </p>
    );
  }
  const W = width;
  const H = 180;
  const pad = { l: 34, r: 14, t: 14, b: 22 };
  const x = (i: number) =>
    pad.l +
    (points.length === 1
      ? (W - pad.l - pad.r) / 2
      : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
  const line = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const h = hover === null ? null : points[hover];

  return (
    <div className="relative mt-4" ref={box}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block max-w-full"
        role="img"
        aria-label={`Contest finishes: ${points.map((p) => `top ${p.top}% in ${p.c.title}`).join(", ")}`}
      >
        <defs>
          <linearGradient id="finish-fill" x1="0" x2="0" y1="0" y2="1">
            <stop
              offset="0%"
              stopColor="rgb(var(--c-accent))"
              stopOpacity="0.22"
            />
            <stop
              offset="100%"
              stopColor="rgb(var(--c-accent))"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              stroke="rgb(var(--c-line))"
              strokeWidth="1"
            />
            <text
              x={pad.l - 8}
              y={y(v) + 3.5}
              textAnchor="end"
              fontSize="11"
              fill="rgb(var(--c-faint))"
            >
              {v === 100 ? "1st" : v === 50 ? "mid" : "last"}
            </text>
          </g>
        ))}
        {points.length > 1 && <path d={area} fill="url(#finish-fill)" />}
        {points.length > 1 && (
          <path
            d={line}
            fill="none"
            stroke="rgb(var(--c-accent))"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        )}
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={pad.t}
            y2={H - pad.b}
            stroke="rgb(var(--c-line-strong))"
            strokeWidth="1"
          />
        )}
        {points.map((p, i) => (
          <g key={p.c.slug}>
            <circle
              cx={x(i)}
              cy={y(p.score)}
              r={hover === i ? 6 : 4.5}
              fill="rgb(var(--c-accent))"
              stroke="rgb(var(--c-surface))"
              strokeWidth="2"
            />
            {/* A hit target much larger than the mark. */}
            <rect
              x={x(i) - (W - pad.l - pad.r) / Math.max(2, points.length) / 2}
              y={pad.t}
              width={(W - pad.l - pad.r) / Math.max(2, points.length)}
              height={H - pad.t - pad.b}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          </g>
        ))}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-panel"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            top: `${(y(h.score) / H) * 100}%`,
            transform: "translate(-50%, calc(-100% - 10px))",
          }}
        >
          <span className="block font-semibold text-ink">{h.c.title}</span>
          <span className="text-muted">
            #{h.c.rank} of {h.c.participants} · top {h.top}%
          </span>
        </div>
      )}
    </div>
  );
}
