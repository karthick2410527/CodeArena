// Landing page, under the app's top bar: a moving hero with a product
// preview, what is live right now, and the product's pillars, each rising
// into view on scroll. Every claim here is true of the app.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CalendarClock,
  Code2,
  PenSquare,
  Radio,
  Search,
  Trophy,
  Users,
} from "lucide-react";
import { contestsApi, problemsApi } from "../api/endpoints";
import { ContestBuilder, JudgePipeline, LiveBoard, ReplayDemo } from "../components/visuals";
import { useAuth } from "../auth/AuthContext";

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

/**
 * The product, shown working: each row pairs a short pitch with an animated
 * illustration of that part of VoidRun (made-up data).
 */
function ProductTour() {
  return (
    <div className="space-y-24 pb-24 pt-20 sm:space-y-32 sm:pt-28">
      <section className="reveal mx-auto max-w-6xl px-4 sm:px-6" aria-labelledby="tour-judge-h">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Under the hood</p>
          <h2 id="tour-judge-h" className="mt-2 text-3xl font-semibold text-ink sm:text-4xl">
            What happens when you press Submit
          </h2>
          <p className="mt-3 text-muted">
            Your code is queued through Kafka, compiled and run in a fresh, locked-down sandbox against every hidden test,
            and the verdict comes back in moments. Contest submissions skip ahead of practice traffic.
          </p>
        </div>
        <JudgePipeline className="mt-10" />
      </section>

      <TourRow
        id="tour-live-h"
        eyebrow="Compete"
        title="Standings that move as verdicts land"
        body="Register for a round under Codeforces, ICPC, AtCoder or IOI rules. Every accepted solution re-ranks the board for everyone watching, live."
        points={["Four scoring rules", "Live updates, no refresh", "Editorials when it ends"]}
        visual={<LiveBoard />}
        cta={["/contests", "See contests"]}
      />
      <TourRow
        id="tour-debug-h"
        eyebrow="Debug"
        title="Step backwards through your own program"
        body="Press Debug and your C++ run is recorded once. Then move through it in both directions: the current line, the call stack and every variable at every step."
        points={["Forwards and backwards", "Call stack and variables", "Fix a compile error in place"]}
        visual={<ReplayDemo />}
        cta={["/problems", "Try it on a problem"]}
        flip
      />
      <TourRow
        id="tour-host-h"
        eyebrow="Host"
        title="Run a round of your own"
        body="Write problems or import them from Codeforces and AtCoder, pick the rules, invite co-authors and publish. People register and race on your clock."
        points={["Four-step setup", "Co-authors and editorials", "Its own judging queue"]}
        visual={<ContestBuilder />}
        cta={["/host", "Go to Host"]}
      />
    </div>
  );
}

function TourRow({
  id,
  eyebrow,
  title,
  body,
  points,
  visual,
  cta,
  flip = false,
}: {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  visual: React.ReactNode;
  cta: [string, string];
  flip?: boolean;
}) {
  return (
    <section className="reveal mx-auto grid max-w-6xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16" aria-labelledby={id}>
      <div className={flip ? "lg:order-2" : ""}>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id} className="mt-2 text-3xl font-semibold leading-tight text-ink sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 text-lg text-muted">{body}</p>
        <ul className="mt-6 space-y-2.5">
          {points.map((p) => (
            <li key={p} className="flex items-center gap-2.5 text-sm font-medium text-ink">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-accent/10 text-accent">
                <Check size={12} strokeWidth={3} aria-hidden="true" />
              </span>
              {p}
            </li>
          ))}
        </ul>
        <Link to={cta[0]} className="btn btn-outline mt-8">
          {cta[1]} <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>
      <div className={`relative ${flip ? "lg:order-1" : ""}`}>
        <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-accent/[0.06] blur-2xl" aria-hidden="true" />
        <div className="relative">{visual}</div>
      </div>
    </section>
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

        <ProductTour />

        <section id="features" className="reveal mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <p className="eyebrow text-center">And more</p>
          <h2 className="mt-2 text-center text-3xl font-semibold text-ink">Everything around the code</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-6">
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
