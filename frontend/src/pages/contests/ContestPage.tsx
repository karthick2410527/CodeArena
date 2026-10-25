import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpenCheck, CheckCircle2, CircleDashed, Radio, Settings2 } from "lucide-react";
import { ApiError } from "../../api/client";
import { contestsApi } from "../../api/endpoints";
import type { ContestDetail, ContestPhase } from "../../api/types";
import { useAuth, useViewer } from "../../auth/AuthContext";
import {
  Countdown,
  FORMAT_HELP,
  FORMAT_LABELS,
  PhaseBadge,
  formatDuration,
  formatElapsed,
  formatWhen,
  livePhase,
  useNow,
} from "../../components/contest";
import { EmptyState, ErrorState, Spinner } from "../../components/Feedback";
import { UserLink } from "../../components/people";
import VerdictBadge from "../../components/VerdictBadge";
import { Notice } from "../../components/ui";
import StandingsTable from "./StandingsTable";

/**
 * Subscribes to the contest's live feed while a contest page is open: each
 * event (a submission queued, a verdict decided) refreshes what it affects.
 */
export function useContestLive(slug: string, enabled: boolean) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource(contestsApi.liveUrl(slug));
    source.addEventListener("hello", () => setConnected(true));
    source.addEventListener("standings", () => {
      void qc.invalidateQueries({ queryKey: ["contest-standings", slug] });
      void qc.invalidateQueries({ queryKey: ["contest-submissions", slug] });
      void qc.invalidateQueries({ queryKey: ["contest", slug] });
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [slug, enabled, qc]);
  return connected;
}

/** What every contest page gets from the shell. */
export interface ContestContext {
  d: ContestDetail;
  phase: ContestPhase;
  now: number;
}

export function useContest() {
  return useOutletContext<ContestContext>();
}

/**
 * The frame around every contest page: a bar that stays at the top with the
 * clock, the problems (coloured by your progress) and the sections, so during
 * a round you are always one click from any problem or the standings.
 */
export default function ContestLayout() {
  const { slug = "" } = useParams();
  const { ready } = useViewer();
  const detail = useQuery({
    queryKey: ["contest", slug],
    queryFn: ({ signal }) => contestsApi.get(slug, signal),
    enabled: ready,
  });
  const now = useNow(detail.data?.server_time);

  if (detail.isPending) return <Spinner label="Loading the contest…" />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return (
        <EmptyState
          title="Contest not found"
          message="It may be a draft, or the link may be wrong."
          action={
            <Link to="/contests" className="btn btn-primary">
              All contests
            </Link>
          }
        />
      );
    }
    return <ErrorState title="Couldn't load the contest" message={detail.error.message} onRetry={() => detail.refetch()} />;
  }
  const d = detail.data;
  const phase = livePhase(d.contest.starts_at, d.contest.ends_at, now);
  return <Shell d={d} phase={phase} now={now} />;
}

function Shell({ d, phase, now }: ContestContext) {
  const c = d.contest;
  const qc = useQueryClient();
  const { status } = useAuth();
  const signedIn = status === "authenticated";
  const live = useContestLive(c.slug, c.published && phase !== "UPCOMING");
  const [error, setError] = useState<string | null>(null);
  const { label } = useParams();

  // Loaded before the start: fetch the problems the moment it begins.
  const [loadedPhase] = useState(phase);
  useEffect(() => {
    if (loadedPhase === "UPCOMING" && phase === "RUNNING") {
      void qc.invalidateQueries({ queryKey: ["contest", c.slug] });
    }
  }, [loadedPhase, phase, qc, c.slug]);

  const register = useMutation({
    mutationFn: () => (c.registered ? contestsApi.unregister(c.slug) : contestsApi.register(c.slug)),
    onSuccess: (next) => {
      qc.setQueryData(["contest", c.slug], next);
      void qc.invalidateQueries({ queryKey: ["contests"] });
      setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Please try again."),
  });

  const start = new Date(c.starts_at).getTime();
  const end = new Date(c.ends_at).getTime();
  const progress = phase === "RUNNING" ? Math.min(100, ((now - start) / (end - start)) * 100) : phase === "ENDED" ? 100 : 0;
  const base = `/contests/${c.slug}`;
  const tab = ({ isActive }: { isActive: boolean }) =>
    `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      isActive ? "bg-sunken text-ink" : "text-muted hover:bg-sunken/60 hover:text-ink"
    }`;

  return (
    <div className="space-y-5">
      <section className="card sticky top-[5.75rem] z-20 overflow-hidden md:top-3" aria-label="Contest">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 sm:px-5">
          <Link to="/contests" className="text-xs text-muted hover:text-ink">
            Contests
          </Link>
          <span className="text-faint" aria-hidden="true">
            /
          </span>
          <h1 className="min-w-0 truncate font-display text-lg font-semibold tracking-tight text-ink">
            <Link to={base} className="hover:text-accent">
              {c.title}
            </Link>
          </h1>
          <PhaseBadge phase={phase} published={c.published} />
          {live && (
            <span className="flex items-center gap-1 text-xs text-good" title="Standings update as verdicts arrive">
              <Radio size={13} aria-hidden="true" /> live
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-base">
              <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
            </span>
            <Action c={c} phase={phase} signedIn={signedIn} busy={register.isPending} onToggle={() => register.mutate()} />
          </div>
        </div>
        <nav className="mt-2 flex flex-wrap items-center gap-1 px-3 pb-2.5 sm:px-4" aria-label="Contest sections">
          <NavLink to={base} end className={tab}>
            Overview
          </NavLink>
          {d.problems_visible && d.problems.length > 0 && (
            <span className="mx-1 flex items-center gap-1" role="group" aria-label="Problems">
              {d.problems.map((p) => (
                <Link
                  key={p.label}
                  to={`${base}/problems/${p.label}`}
                  title={`${p.label}. ${p.title}${p.my_status === "SOLVED" ? " (solved)" : p.my_status === "ATTEMPTED" ? " (attempted)" : ""}`}
                  aria-current={label === p.label ? "page" : undefined}
                  className={`grid h-8 min-w-8 place-items-center rounded-lg border px-2 text-sm font-semibold transition ${
                    label === p.label
                      ? "border-accent bg-accent text-accent-ink"
                      : p.my_status === "SOLVED"
                        ? "border-good/40 bg-good/10 text-good"
                        : p.my_status === "ATTEMPTED"
                          ? "border-bad/30 bg-bad/5 text-bad"
                          : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                  }`}
                >
                  {p.label}
                </Link>
              ))}
            </span>
          )}
          <NavLink to={`${base}/standings`} className={tab}>
            Standings
          </NavLink>
          {signedIn && (
            <NavLink to={`${base}/submissions`} className={tab}>
              My submissions
            </NavLink>
          )}
          {(d.editorial_available || c.my_role) && (
            <NavLink to={`${base}/editorial`} className={tab}>
              Editorial
            </NavLink>
          )}
        </nav>
        <div className="h-1 bg-line/60" aria-hidden="true">
          <div className={`h-full ${phase === "RUNNING" ? "bg-good" : "bg-line-strong"} transition-all`} style={{ width: `${progress}%` }} />
        </div>
      </section>

      {error && <Notice tone="bad">{error}</Notice>}
      <Outlet context={{ d, phase, now } satisfies ContestContext} />
    </div>
  );
}

function Action({
  c,
  phase,
  signedIn,
  busy,
  onToggle,
}: {
  c: ContestDetail["contest"];
  phase: ContestPhase;
  signedIn: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  if (c.my_role) {
    return (
      <Link to={`/contests/${c.slug}/manage`} className="btn btn-outline min-h-[34px] px-3 text-xs">
        <Settings2 size={14} aria-hidden="true" /> Manage
      </Link>
    );
  }
  if (phase === "ENDED") return null;
  if (!signedIn) {
    return (
      <Link to="/login" className="btn btn-primary min-h-[34px] px-3 text-xs">
        Sign in to register
      </Link>
    );
  }
  if (c.registered) {
    return phase === "UPCOMING" ? (
      <button type="button" className="btn btn-outline min-h-[34px] px-3 text-xs" onClick={onToggle} disabled={busy}>
        Registered ✓ · Withdraw
      </button>
    ) : (
      <span className="chip border-good/30 bg-good/10 text-good">Registered ✓</span>
    );
  }
  return (
    <button type="button" className="btn btn-primary min-h-[34px] px-3 text-xs" onClick={onToggle} disabled={busy}>
      {phase === "RUNNING" ? "Register now (late)" : "Register"}
    </button>
  );
}

// ---- sections ----------------------------------------------------------------------

/** Overview: what to do next, the problems, then the rules. */
export function ContestOverview() {
  const { d, phase, now } = useContest();
  const [params] = useSearchParams();
  const { status } = useAuth();
  const c = d.contest;
  // Links from before the sections had their own addresses.
  const legacy = params.get("tab");
  if (legacy === "standings" || legacy === "submissions" || legacy === "editorial") {
    return <Navigate to={`/contests/${c.slug}/${legacy}`} replace />;
  }
  const firstOpen = d.problems.find((p) => p.my_status !== "SOLVED") ?? d.problems[0];
  const competing = phase === "RUNNING" && c.registered;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-5">
        {competing && firstOpen && (
          <Link
            to={`/contests/${c.slug}/problems/${firstOpen.label}`}
            className="card group flex items-center justify-between gap-4 border-accent/30 bg-accent/5 p-5 transition hover:bg-accent/10"
          >
            <span>
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-accent">You are competing</span>
              <span className="mt-1 block text-lg font-semibold text-ink">
                {d.problems.every((p) => p.my_status === "SOLVED")
                  ? "Everything solved: check the standings"
                  : `Continue with ${firstOpen.label}. ${firstOpen.title}`}
              </span>
            </span>
            <ArrowRight size={22} className="shrink-0 text-accent transition group-hover:translate-x-1" aria-hidden="true" />
          </Link>
        )}
        {phase === "RUNNING" && status === "authenticated" && !c.registered && !c.my_role && (
          <Notice tone="warn" title="You are not registered">
            You can read the problems, but only registered contestants can submit and appear in the standings. Register
            at the top to join in.
          </Notice>
        )}
        {phase === "ENDED" && d.editorial_available && (
          <Link to={`/contests/${c.slug}/editorial`} className="card flex items-center gap-3 p-4 text-sm transition hover:bg-sunken/50">
            <BookOpenCheck size={18} className="text-accent" aria-hidden="true" />
            <span className="text-ink">The editorial is out: read how each problem is solved.</span>
            <ArrowRight size={16} className="ml-auto text-faint" aria-hidden="true" />
          </Link>
        )}
        <ProblemList d={d} phase={phase} now={now} />
        {d.description.trim() && (
          <section className="card p-5 sm:p-6" aria-label="About this contest">
            <div className="md">
              <ReactMarkdown>{d.description}</ReactMarkdown>
            </div>
          </section>
        )}
      </div>
      <aside className="card space-y-4 p-5 text-sm" aria-label="Contest facts">
        <Fact label="Starts" value={formatWhen(c.starts_at)} />
        <Fact label="Length" value={formatDuration(c.duration_minutes)} />
        <Fact label="Registered" value={String(c.participants)} />
        <div>
          <p className="text-xs uppercase tracking-[0.1em] text-faint">Authors</p>
          <p className="mt-1">
            {c.authors.map((a, i) => (
              <span key={a}>
                {i > 0 && ", "}
                <UserLink username={a} />
              </span>
            ))}
          </p>
        </div>
        <div className="border-t border-line pt-4">
          <p className="font-medium text-ink">{FORMAT_LABELS[c.format]}</p>
          <p className="mt-1 text-muted">{FORMAT_HELP[c.format]}</p>
          <p className="mt-2 text-muted">
            Compile errors never count. After the end the problems join practice, and further submissions are practice.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  );
}

function ProblemList({ d, phase, now }: ContestContext) {
  const c = d.contest;
  if (!d.problems_visible) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg font-semibold text-ink">The problems appear when the contest starts.</p>
        <p className="mt-2 text-muted">
          <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
        </p>
      </div>
    );
  }
  const showPoints = c.format !== "ICPC";
  return (
    <div className="card overflow-hidden">
      <h2 className="border-b border-line px-5 py-3 font-semibold text-ink">Problems</h2>
      <ul className="divide-y divide-line/70" aria-label="Contest problems">
        {d.problems.map((p) => (
          <li key={p.label}>
            <Link to={`/contests/${c.slug}/problems/${p.label}`} className="flex items-center gap-4 px-5 py-3.5 transition hover:bg-sunken/50">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 font-display font-semibold text-accent">
                {p.label}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{p.title}</span>
                <span className="text-xs text-faint">
                  {p.solved_by} solved{phase === "UPCOMING" ? " · authors' preview" : ""}
                </span>
              </span>
              {showPoints && <span className="font-mono text-sm text-muted">{p.points}</span>}
              {p.my_status === "SOLVED" ? (
                <CheckCircle2 size={18} className="text-good" aria-label="Solved" />
              ) : p.my_status === "ATTEMPTED" ? (
                <CircleDashed size={18} className="text-warn" aria-label="Attempted" />
              ) : (
                <span className="w-[18px]" />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContestStandings() {
  const { d, phase } = useContest();
  const { user } = useAuth();
  const standings = useQuery({
    queryKey: ["contest-standings", d.contest.slug],
    queryFn: ({ signal }) => contestsApi.standings(d.contest.slug, signal),
    enabled: d.problems_visible,
    // The live feed refreshes on every verdict; this is the fallback when it is not connected.
    refetchInterval: phase === "RUNNING" ? 30_000 : false,
  });
  if (!d.problems_visible) {
    return <p className="card p-6 text-center text-muted">Standings appear when the contest starts.</p>;
  }
  if (standings.isPending) return <Spinner label="Loading standings…" />;
  if (standings.isError) {
    return <ErrorState title="Couldn't load standings" message={standings.error.message} onRetry={() => standings.refetch()} />;
  }
  return <StandingsTable view={standings.data} me={user?.username} />;
}

export function ContestSubmissions() {
  const { d } = useContest();
  const slug = d.contest.slug;
  const subs = useQuery({
    queryKey: ["contest-submissions", slug],
    queryFn: ({ signal }) => contestsApi.mySubmissions(slug, signal),
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "QUEUED" || s.status === "RUNNING") ? 1500 : false),
  });
  if (subs.isPending) return <Spinner label="Loading your submissions…" />;
  if (subs.isError) return <ErrorState title="Couldn't load your submissions" message={subs.error.message} />;
  if (subs.data.length === 0) {
    return <p className="card p-6 text-center text-muted">You haven’t submitted anything to this contest yet.</p>;
  }
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-paper/40 text-left text-[0.6875rem] uppercase tracking-[0.08em] text-faint">
          <tr>
            <th className="px-4 py-2.5 font-semibold">When</th>
            <th className="px-4 py-2.5 font-semibold">Problem</th>
            <th className="px-4 py-2.5 font-semibold">Verdict</th>
            <th className="px-4 py-2.5 font-semibold">Tests</th>
            <th className="px-4 py-2.5 font-semibold">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {subs.data.map((s) => (
            <tr key={s.submission_id}>
              <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">
                {s.elapsed_seconds !== null ? formatElapsed(s.elapsed_seconds) : new Date(s.created_at).toLocaleString()}
                {!s.in_contest && <span className="chip ml-2">practice</span>}
              </td>
              <td className="px-4 py-2.5">
                <Link to={`/contests/${slug}/problems/${s.label}`} className="hover:text-accent">
                  <span className="mr-2 font-semibold text-accent">{s.label}</span>
                  <span className="text-ink">{s.problem_title}</span>
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <Link to={`/submissions/${s.submission_id}`}>
                  <VerdictBadge status={s.verdict ?? s.status} size="sm" />
                </Link>
              </td>
              <td className="px-4 py-2.5 tabular text-muted">{s.total_tests > 0 ? `${s.passed_tests}/${s.total_tests}` : "—"}</td>
              <td className="px-4 py-2.5 tabular text-muted">{s.execution_time_ms !== null ? `${s.execution_time_ms} ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The write-ups, after the end (or for the authors, with a link to edit them). */
export function ContestEditorial() {
  const { d } = useContest();
  const c = d.contest;
  const editorial = useQuery({
    queryKey: ["contest-editorial", c.slug],
    queryFn: () => contestsApi.editorial(c.slug),
  });
  if (editorial.isPending) return <Spinner label="Loading the editorial…" />;
  if (editorial.isError) {
    if (editorial.error instanceof ApiError && editorial.error.status === 409) {
      return <p className="card p-6 text-center text-muted">The editorial appears when the contest ends.</p>;
    }
    return <ErrorState title="Couldn't load the editorial" message={editorial.error.message} />;
  }
  const e = editorial.data;
  const empty = !e.intro.trim() && e.problems.every((p) => !p.editorial.trim());
  return (
    <div className="space-y-5">
      {c.my_role && (
        <Notice
          tone={e.is_public ? "good" : "neutral"}
          title={e.is_public ? "Public since the contest ended" : "Only authors can see this until the contest ends"}
        >
          <Link to={`/contests/${c.slug}/manage#editorial`} className="text-accent hover:underline">
            Write or edit the editorial
          </Link>
        </Notice>
      )}
      {empty ? (
        <p className="card p-6 text-center text-muted">The authors haven’t written an editorial yet.</p>
      ) : (
        <>
          {e.intro.trim() && (
            <section className="card p-5 sm:p-6">
              <div className="md">
                <ReactMarkdown>{e.intro}</ReactMarkdown>
              </div>
            </section>
          )}
          {e.problems
            .filter((p) => p.editorial.trim())
            .map((p) => (
              <section key={p.label} className="card p-5 sm:p-6" aria-labelledby={`ed-${p.label}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id={`ed-${p.label}`} className="text-lg font-semibold text-ink">
                    <span className="mr-2 text-accent">{p.label}.</span>
                    {p.title}
                  </h2>
                  <Link to={`/contests/${c.slug}/problems/${p.label}`} className="text-sm text-accent hover:underline">
                    Open the problem
                  </Link>
                </div>
                <div className="md mt-3">
                  <ReactMarkdown>{p.editorial}</ReactMarkdown>
                </div>
              </section>
            ))}
        </>
      )}
    </div>
  );
}
