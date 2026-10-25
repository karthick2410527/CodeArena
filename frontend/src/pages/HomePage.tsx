// Landing page, under the app's top bar: a moving hero with a product
// preview, what is live right now, and the product's pillars, each rising
// into view on scroll. Every claim here is true of the app.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bug,
  CalendarClock,
  Code2,
  PenSquare,
  Radio,
  Search,
  Swords,
  Trophy,
  Users,
} from "lucide-react";
import { contestsApi, problemsApi } from "../api/endpoints";
import type { ContestSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Countdown, FORMAT_LABELS, PhaseBadge, formatDuration, useNow } from "../components/contest";

/** A framed editor with a verdict panel beside it. Static: it shows the shape of the product. */
function ProductPreview() {
  const rows: [string, string, string][] = [
    ["#1", "sample", "3 ms"],
    ["#2", "sample", "2 ms"],
    ["#3", "hidden", "41 ms"],
    ["#4", "hidden", "38 ms"],
  ];
  return (
    <div className="relative mx-auto mt-16 max-w-5xl text-left" aria-hidden="true">
      <div className="glow absolute inset-x-10 -top-10 h-72" />
      <div className="mock relative">
        <div className="mock-bar">
          <i />
          <i />
          <i />
          <span className="ml-3 rounded-md bg-surface px-3 py-0.5 font-mono text-[0.6875rem] text-faint">voidrun · round #1 · A</span>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[0.6875rem] text-good">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" /> 00:41:12
          </span>
        </div>
        <div className="grid gap-5 p-5 sm:p-7 md:grid-cols-[minmax(0,1fr)_260px]">
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="panel-meta">
              <span>
                <span className="text-accent">C++17</span> · main.cpp
              </span>
              <span>1 s · 256 MB</span>
            </div>
            <pre className="overflow-x-auto bg-surface px-5 py-4 font-mono text-[0.8125rem] leading-6 text-ink">
              <span className="text-faint">#include</span> {"<bits/stdc++.h>"}
              {"\n"}
              <span className="text-accent">using namespace</span> std;
              {"\n\n"}
              <span className="text-accent">int</span> main() {"{"}
              {"\n"}    <span className="text-accent">long long</span> a, b;
              {"\n"}    cin {">>"} a {">>"} b;
              {"\n"}    cout {"<<"} a + b {"<<"} <span className="text-good">"\n"</span>;
              {"\n"}
              {"}"}
            </pre>
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-good/40 bg-good/10 px-4 py-3">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-good">Verdict</p>
              <p className="mt-1 font-display text-xl font-semibold text-good">Accepted</p>
              <p className="mt-0.5 text-sm text-muted">4 / 4 tests · 41 ms</p>
            </div>
            <div className="divide-y divide-line rounded-xl border border-line bg-surface">
              {rows.map(([n, kind, t]) => (
                <div key={n} className="flex items-center justify-between px-4 py-2 font-mono text-xs">
                  <span className="text-ink">{n}</span>
                  <span className="text-faint">{kind}</span>
                  <span className="text-good">passed</span>
                  <span className="tabular text-muted">{t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Running and upcoming contests, straight from the API. Hidden when there are none. */
function HappeningNow() {
  const now = useNow();
  const running = useQuery({ queryKey: ["contests", "running"], queryFn: () => contestsApi.list("running", 1, 3) });
  const upcoming = useQuery({ queryKey: ["contests", "upcoming"], queryFn: () => contestsApi.list("upcoming", 1, 3) });
  const items: ContestSummary[] = [...(running.data?.items ?? []), ...(upcoming.data?.items ?? [])].slice(0, 3);
  if (items.length === 0) return null;
  return (
    <section className="reveal mx-auto max-w-6xl px-4 pb-20 sm:px-6" aria-labelledby="now-h">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Happening now</p>
          <h2 id="now-h" className="mt-2 text-3xl font-semibold text-ink">
            Rounds you can join
          </h2>
        </div>
        <Link to="/contests" className="text-sm font-medium text-accent hover:underline">
          All contests →
        </Link>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {items.map((c) => (
          <Link key={c.slug} to={`/contests/${c.slug}`} className="card group p-5 transition-colors hover:border-accent/40 hover:shadow-panel">
            <div className="flex items-center justify-between gap-2">
              <PhaseBadge phase={c.phase} />
              <span className="text-xs">
                <Countdown startsAt={c.starts_at} endsAt={c.ends_at} now={now} />
              </span>
            </div>
            <h3 className="mt-3 text-lg font-semibold text-ink group-hover:text-accent">{c.title}</h3>
            <p className="mt-1 text-sm text-muted">
              {formatDuration(c.duration_minutes)} · {FORMAT_LABELS[c.format]} · {c.participants} registered
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

const STRIP = [
  "C++17",
  "Java 21",
  "Node.js 22",
  "Codeforces rules",
  "ICPC rules",
  "AtCoder rules",
  "IOI rules",
  "Live standings",
  "Step-by-step replay",
  "Hidden tests",
  "Editorials",
  "Sandboxed judge",
];

/** A slow strip of what the judge speaks, between the hero and the rest. */
function Marquee() {
  return (
    <div className="marquee border-y border-line/60 bg-surface/30 py-4" aria-label="Languages and formats">
      <div>
        {[0, 1].map((copy) => (
          <ul key={copy} className="flex shrink-0 items-center gap-10 pr-10" aria-hidden={copy === 1 || undefined}>
            {STRIP.map((t) => (
              <li key={t} className="flex items-center gap-3 whitespace-nowrap font-display text-lg font-medium text-faint">
                <span className="h-1.5 w-1.5 rounded-full bg-accent/60" aria-hidden="true" />
                {t}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

function Pillar({
  icon: Icon,
  title,
  body,
  className = "",
  children,
}: {
  icon: typeof Code2;
  title: string;
  body: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`bento flex flex-col ${className}`}>
      <span className="icon-tile">
        <Icon size={18} />
      </span>
      <h3 className="mt-4 text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-muted">{body}</p>
      {children && <div className="mt-5 flex-1">{children}</div>}
    </div>
  );
}

/** A miniature live scoreboard, for the contests pillar. */
function MiniStandings() {
  const rows: [number, string, string, string][] = [
    [1, "zoe", "1396", "bg-good/25"],
    [2, "ada", "940", "bg-good/10"],
    [3, "lin", "480", "bg-good/10"],
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface text-sm" aria-hidden="true">
      {rows.map(([rank, name, score, cell]) => (
        <div key={name} className="flex items-center gap-3 border-b border-line/60 px-4 py-2 last:border-0">
          <span className="w-4 font-mono text-faint">{rank}</span>
          <span className="flex-1 font-medium text-ink">{name}</span>
          <span className={`rounded-md px-2 py-0.5 font-mono text-xs text-good ${cell}`}>A</span>
          <span className="w-12 text-right font-semibold text-ink">{score}</span>
        </div>
      ))}
    </div>
  );
}

/** A miniature step-through, for the replay pillar. */
function MiniReplay() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface font-mono text-xs" aria-hidden="true">
      {["for (int i = 0; i < n; i++)", "  sum += a[i];", "cout << sum;"].map((l, i) => (
        <div key={l} className={`flex gap-3 px-4 py-1.5 ${i === 1 ? "bg-accent/15 shadow-[inset_3px_0_0_rgb(var(--c-accent))]" : ""}`}>
          <span className="w-4 text-faint">{i + 7}</span>
          <span className="text-ink">{l}</span>
        </div>
      ))}
      <div className="flex justify-between border-t border-line px-4 py-2 text-muted">
        <span>
          i = <span className="text-ink">3</span> · sum = <span className="text-accent">12</span>
        </span>
        <span>step 14 / 40</span>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { status } = useAuth();
  const total = useQuery({ queryKey: ["problems-total"], queryFn: () => problemsApi.list({ page: 1, limit: 1 }) });
  const live = useQuery({ queryKey: ["contests", "running"], queryFn: () => contestsApi.list("running", 1, 3) });
  const liveCount = live.data?.total ?? 0;
  return (
    <div>
      <div>
        <section className="relative overflow-hidden">
          <div className="aurora" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="hero-grid absolute inset-0" />
          <div className="stagger relative mx-auto max-w-6xl px-4 pb-16 pt-32 text-center sm:px-6 sm:pt-40">
            <Link to={liveCount > 0 ? "/contests" : "/problems"} className="badge hover:text-ink">
              {liveCount > 0 ? (
                <>
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" />
                  {liveCount} contest{liveCount === 1 ? " is" : "s are"} live now
                </>
              ) : (
                <>
                  <span className="badge-dot" />
                  Practice · compete · replay
                </>
              )}
              <ArrowRight size={13} />
            </Link>
            <h1 className="text-shine mx-auto mt-6 max-w-4xl text-[2.75rem] font-semibold leading-[1.02] sm:text-7xl">
              Solve it. Race it. <span className="text-accent-shine">Replay every step.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-muted">
              An online judge for C++, Java and JavaScript with live community contests and a debugger that lets you
              scrub through your program line by line.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link to="/problems" className="btn-primary min-h-[52px] px-6 text-base">
                Start solving <ArrowRight size={16} />
              </Link>
              <Link to="/contests" className="btn-outline min-h-[52px] px-6 text-base">
                <Trophy size={16} /> See contests
              </Link>
            </div>
            <dl className="mx-auto mt-10 flex max-w-xl flex-wrap justify-center gap-x-10 gap-y-3 text-sm text-muted">
              <div>
                <dt className="sr-only">Problems</dt>
                <dd>
                  <span className="text-lg font-semibold text-ink">{total.data?.total ?? "—"}</span> problems
                </dd>
              </div>
              <div>
                <dt className="sr-only">Languages</dt>
                <dd>
                  <span className="text-lg font-semibold text-ink">3</span> languages
                </dd>
              </div>
              <div>
                <dt className="sr-only">Scoring rules</dt>
                <dd>
                  <span className="text-lg font-semibold text-ink">4</span> contest formats
                </dd>
              </div>
            </dl>
            <ProductPreview />
          </div>
        </section>

        <Marquee />

        <HappeningNow />

        <section id="features" className="reveal mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <p className="eyebrow text-center">Features</p>
          <h2 className="mt-2 text-center text-3xl font-semibold text-ink">From first submission to hosting a round</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-6">
            <Pillar
              icon={Swords}
              title="Live contests, live standings"
              body="Register, race the clock, and watch the scoreboard move as verdicts land: Codeforces, ICPC, AtCoder or IOI rules."
              className="md:col-span-3"
            >
              <MiniStandings />
            </Pillar>
            <Pillar
              icon={Bug}
              title="Debug by replaying"
              body="Record a C++ run once, then step forwards and backwards through it with the call stack and every variable."
              className="md:col-span-3"
            >
              <MiniReplay />
            </Pillar>
            <Pillar
              icon={Code2}
              title="A real judge"
              body="C++17, Java 21 and Node.js in locked-down sandboxes, judged against hidden tests with per-test verdicts."
              className="md:col-span-2"
            />
            <Pillar
              icon={PenSquare}
              title="Write and host"
              body="Author problems, invite co-authors, publish a round, and release an editorial when it ends."
              className="md:col-span-2"
            />
            <Pillar
              icon={Users}
              title="Profiles and people"
              body="A year of activity, your contest finishes, and ⌘K search to find anyone, any problem, any round."
              className="md:col-span-2"
            />
          </div>
        </section>

        <section className="reveal mx-auto max-w-6xl px-4 pb-24 sm:px-6" aria-labelledby="how-h">
          <h2 id="how-h" className="sr-only">
            How it works
          </h2>
          <ol className="grid gap-4 md:grid-cols-3">
            {[
              [Search, "Pick a problem", "Filter by difficulty, tag or what you have not solved yet."],
              [Radio, "Run, debug, submit", "Check the samples, replay a run when it misbehaves, then submit for a verdict."],
              [CalendarClock, "Join a round", "Compete on a clock, then read the editorial and upsolve."],
            ].map(([Icon, title, body], i) => {
              const I = Icon as typeof Search;
              return (
                <li key={title as string} className="flex gap-4 rounded-2xl border border-line/70 p-5">
                  <span className="font-display text-3xl font-semibold text-accent/40">{i + 1}</span>
                  <span>
                    <span className="flex items-center gap-2 font-semibold text-ink">
                      <I size={16} className="text-accent" aria-hidden="true" /> {title as string}
                    </span>
                    <span className="mt-1 block text-sm text-muted">{body as string}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="reveal mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div
            className="panel overflow-hidden px-6 py-12 text-center sm:px-12"
            style={{ background: "radial-gradient(700px 260px at 50% 0%, rgb(var(--c-accent) / 0.18), transparent 70%), rgb(var(--c-surface))" }}
          >
            <h2 className="text-3xl font-semibold text-ink">Your next accepted is one submit away.</h2>
            <p className="mx-auto mt-3 max-w-lg text-muted">Free, in the browser, nothing to install.</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link to={status === "authenticated" ? "/problems" : "/register"} className="btn-primary min-h-[48px] px-6">
                {status === "authenticated" ? "Open the problems" : "Create your account"} <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
