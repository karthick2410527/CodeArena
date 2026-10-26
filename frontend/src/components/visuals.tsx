import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, Cpu, Lock, Radio, Send, Server, Trophy, Users, Wifi, X } from "lucide-react";

/*
 * Animated product illustrations: what VoidRun does, shown rather than told.
 * They run only while on screen, use transform and opacity (nothing shifts
 * around them), and hold a finished frame for people who ask for less motion.
 * Every name and number in them is made up.
 */

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useInView(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/**
 * A frame counter that ticks every {@code ms} while the element is visible.
 * With reduced motion it stays on {@code still}.
 */
function useFrames(ref: RefObject<HTMLElement | null>, ms: number, still: number) {
  const inView = useInView(ref);
  const [reduced] = useState(prefersReducedMotion);
  const [frame, setFrame] = useState(reduced ? still : 0);
  useEffect(() => {
    if (reduced || !inView) return;
    const t = window.setInterval(() => setFrame((f) => f + 1), ms);
    return () => window.clearInterval(t);
  }, [reduced, inView, ms]);
  return reduced ? still : frame;
}

/** The window chrome every illustration sits in. */
function Frame({ title, badge, children, className = "" }: { title: string; badge?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-line/80 bg-surface shadow-[0_30px_80px_-40px_rgb(0_0_0/0.35)] ${className}`}>
      <div className="flex items-center gap-2 border-b border-line/70 bg-paper/60 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <i className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          <i className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          <i className="h-2.5 w-2.5 rounded-full bg-line-strong" />
        </span>
        <span className="ml-1 truncate font-mono text-[0.6875rem] text-faint">{title}</span>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function LivePill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-good/10 px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-good">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" /> Live
    </span>
  );
}

// ---- live standings -------------------------------------------------------------

const PEOPLE = ["nova", "quark", "lumen", "pixel", "delta"];
const PROBLEMS = ["A", "B", "C", "D"];
const POINTS = [500, 1000, 1500, 2000];

/** A scripted round: each frame one person gets a verdict. Deterministic, so it reads well and tests stay stable. */
const EVENTS: [number, number, boolean][] = [
  [2, 0, true], [0, 0, true], [4, 0, false], [1, 0, true], [4, 0, true], [3, 0, true],
  [2, 1, true], [0, 1, false], [1, 1, true], [0, 1, true], [3, 1, false], [4, 1, true],
  [1, 2, true], [2, 2, false], [0, 2, true], [2, 2, true], [4, 2, false], [1, 3, true],
];

type Cell = { ok: boolean; tries: number; points: number } | null;

function boardAt(frame: number) {
  const cells: Cell[][] = PEOPLE.map(() => PROBLEMS.map(() => null));
  const n = frame % (EVENTS.length + 4);
  let last: [number, number] | null = null;
  for (let i = 0; i < Math.min(n, EVENTS.length); i++) {
    const [p, q, ok] = EVENTS[i];
    const c = cells[p][q] ?? { ok: false, tries: 0, points: 0 };
    if (c.ok) continue;
    const tries = c.tries + (ok ? 0 : 1);
    cells[p][q] = ok ? { ok: true, tries, points: Math.max(POINTS[q] * 0.3, POINTS[q] - 12 * i - 50 * tries) } : { ok: false, tries, points: 0 };
    last = [p, q];
  }
  const rows = PEOPLE.map((name, p) => ({
    name,
    p,
    score: Math.round(cells[p].reduce((s, c) => s + (c?.ok ? c.points : 0), 0)),
    cells: cells[p],
  })).sort((a, b) => b.score - a.score || a.p - b.p);
  return { rows, last };
}

/** Live standings that re-rank themselves as verdicts land. */
export function LiveBoard({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useFrames(ref, 1300, EVENTS.length);
  const { rows, last } = boardAt(frame);
  const ROW = 44;
  return (
    <div ref={ref} className={className} aria-label="An example of live standings" role="img">
      <Frame title="weekend-round · standings" badge={<LivePill />}>
        <div className="grid grid-cols-[2rem_minmax(0,1fr)_repeat(4,2.75rem)_4rem] items-center gap-1 border-b border-line/70 px-4 py-2 text-[0.625rem] font-semibold uppercase tracking-wider text-faint">
          <span>#</span>
          <span>Who</span>
          {PROBLEMS.map((q) => (
            <span key={q} className="text-center">
              {q}
            </span>
          ))}
          <span className="text-right">Score</span>
        </div>
        <div className="relative" style={{ height: PEOPLE.length * ROW }}>
          {PEOPLE.map((_, p) => {
            const at = rows.findIndex((r) => r.p === p);
            const r = rows[at];
            return (
              <div
                key={p}
                className="absolute inset-x-0 grid grid-cols-[2rem_minmax(0,1fr)_repeat(4,2.75rem)_4rem] items-center gap-1 px-4 transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{ height: ROW, transform: `translateY(${at * ROW}px)` }}
              >
                <span className={`font-mono text-xs ${at === 0 && r.score > 0 ? "font-bold text-accent" : "text-faint"}`}>{at + 1}</span>
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/10 text-[0.625rem] font-bold uppercase text-accent">
                    {r.name[0]}
                  </span>
                  <span className="truncate">{r.name}</span>
                </span>
                {r.cells.map((c, q) => {
                  const fresh = last !== null && last[0] === p && last[1] === q;
                  return (
                    <span key={q} className="flex justify-center">
                      <span
                        className={`grid h-7 w-9 place-items-center rounded-md font-mono text-[0.6875rem] font-semibold transition-all duration-300 ${
                          c?.ok ? "bg-good/15 text-good" : c ? "bg-bad/10 text-bad" : "bg-sunken/70 text-transparent"
                        } ${fresh ? "scale-110 ring-2 ring-offset-1 ring-offset-surface " + (c?.ok ? "ring-good/50" : "ring-bad/40") : ""}`}
                      >
                        {c?.ok ? (c.tries ? `+${c.tries}` : "+") : c ? `−${c.tries}` : "·"}
                      </span>
                    </span>
                  );
                })}
                <span className="text-right font-mono text-sm font-semibold tabular text-ink">{r.score}</span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t border-line/70 px-4 py-2 text-[0.6875rem] text-faint">
          <span className="flex items-center gap-1.5">
            <Radio size={12} className="text-good" aria-hidden="true" /> Updates the moment a verdict lands
          </span>
          <span className="font-mono">Codeforces rules</span>
        </div>
      </Frame>
    </div>
  );
}

// ---- the judge pipeline -----------------------------------------------------------

const VERDICTS: [string, string, boolean][] = [
  ["Accepted", "12 ms · 3.1 MB", true],
  ["Wrong answer", "on test 7", false],
  ["Accepted", "48 ms · 9.8 MB", true],
  ["Time limit", "on test 12", false],
];

/** A submission travelling through the judge: API and outbox, Kafka, a sandbox, a verdict. */
export function JudgePipeline({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useFrames(ref, 700, 4);
  const stage = frame % 6; // 0 code · 1 queue · 2-3 sandbox · 4-5 verdict
  const round = Math.floor(frame / 6);
  const [verdict, detail, ok] = VERDICTS[round % VERDICTS.length];
  const lane = round % 3;
  return (
    <div ref={ref} className={className} role="img" aria-label="How a submission is judged: queued through Kafka, run in a sandbox, verdict returned">
      <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
        <Station n={1} title="Your code" icon={Send} on={stage === 0}>
          <pre className="overflow-hidden rounded-lg bg-paper/70 p-2.5 font-mono text-[0.6875rem] leading-relaxed text-muted">
            <span className="text-accent">int</span> main() {"{"}
            {"\n"}  cin {">>"} n;
            {"\n"}  cout {"<<"} solve(n);
            {"\n"}
            {"}"}
            <span className={`ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-accent ${stage === 0 ? "animate-pulse" : "opacity-0"}`} />
          </pre>
          <p className="mt-2 font-mono text-[0.625rem] text-faint">POST /submissions</p>
        </Station>
        <Wire active={stage === 1} />
        <Station n={2} title="Queued in Kafka" icon={Server} on={stage === 1}>
          <div className="space-y-1.5">
            {["runs", "submissions", "contest · priority"].map((l, i) => (
              <div key={l} className={`relative flex h-6 items-center overflow-hidden rounded-md border px-2 font-mono text-[0.625rem] ${i === 2 ? "border-accent/40 text-accent" : "border-line text-faint"}`}>
                {l}
                {stage === 1 && i === lane && <span className="absolute right-2 h-2 w-2 animate-ping rounded-full bg-accent" />}
                {stage === 1 && i === lane && <span className="absolute right-2 h-2 w-2 rounded-full bg-accent" />}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[0.625rem] text-faint">Written with the submission, so none is lost</p>
        </Station>
        <Wire active={stage === 2} />
        <Station n={3} title="A sandbox per run" icon={Cpu} on={stage === 2 || stage === 3}>
          <div className="grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((i) => {
              const busy = (stage === 2 || stage === 3) && i === round % 3;
              return (
                <div key={i} className={`grid h-12 place-items-center rounded-lg border transition-colors duration-300 ${busy ? "border-accent/50 bg-accent/10" : "border-line bg-paper/60"}`}>
                  <Cpu size={14} className={busy ? "animate-pulse text-accent" : "text-faint"} aria-hidden="true" />
                </div>
              );
            })}
          </div>
          <p className="mt-2 flex flex-wrap gap-x-2 text-[0.625rem] text-faint">
            <span className="flex items-center gap-1"><Wifi size={10} aria-hidden="true" /> no network</span>
            <span className="flex items-center gap-1"><Lock size={10} aria-hidden="true" /> read-only</span>
          </p>
        </Station>
        <Wire active={stage === 4} />
        <Station n={4} title="Verdict" icon={Check} on={stage >= 4}>
          <div className={`rounded-lg border p-2.5 transition-all duration-500 ${stage >= 4 ? (ok ? "border-good/40 bg-good/10" : "border-bad/30 bg-bad/10") : "border-line bg-paper/60 opacity-50"}`}>
            <p className={`flex items-center gap-1.5 text-sm font-semibold ${stage >= 4 ? (ok ? "text-good" : "text-bad") : "text-faint"}`}>
              {stage >= 4 ? ok ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" /> : null}
              {stage >= 4 ? verdict : "Judging…"}
            </p>
            <p className="mt-0.5 font-mono text-[0.625rem] text-faint">{stage >= 4 ? detail : " "}</p>
          </div>
          <div className="mt-2 flex gap-1" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <span
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-colors duration-200 ${
                  stage < 2 ? "bg-line" : stage < 4 ? (i < (stage - 1) * 5 ? "bg-good/60" : "bg-line") : ok || i < 6 ? "bg-good" : i === 6 ? "bg-bad" : "bg-line"
                }`}
              />
            ))}
          </div>
        </Station>
      </div>
    </div>
  );
}

function Station({ n, title, icon: Icon, on, children }: { n: number; title: string; icon: typeof Send; on: boolean; children: ReactNode }) {
  return (
    <div
      className={`rounded-2xl border bg-surface p-4 transition-[border-color,box-shadow] duration-500 ${
        on ? "border-accent/50 shadow-[0_0_0_4px_rgb(var(--c-accent)/0.08),0_20px_40px_-24px_rgb(var(--c-accent)/0.5)]" : "border-line/80"
      }`}
    >
      <p className="mb-3 flex items-center gap-2 text-xs font-semibold text-ink">
        <span className={`grid h-6 w-6 place-items-center rounded-full font-mono text-[0.625rem] transition-colors ${on ? "bg-accent text-accent-ink" : "bg-sunken text-faint"}`}>{n}</span>
        <Icon size={13} className={on ? "text-accent" : "text-faint"} aria-hidden="true" />
        {title}
      </p>
      {children}
    </div>
  );
}

/** The link between two stations, with a packet running along it when active. */
function Wire({ active }: { active: boolean }) {
  return (
    <div className="relative flex items-center justify-center md:w-10" aria-hidden="true">
      <div className="h-6 w-px bg-line md:h-px md:w-full" />
      <span
        className={`absolute h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_12px_rgb(var(--c-accent)/0.8)] transition-opacity ${active ? "opacity-100 animate-[vr-packet-y_700ms_ease-in-out] md:animate-[vr-packet-x_700ms_ease-in-out]" : "opacity-0"}`}
      />
    </div>
  );
}

// ---- the debugger -----------------------------------------------------------------

const CODE = ["int sum(int n) {", "  if (n == 0) return 0;", "  return n + sum(n - 1);", "}", "", "int main() {", "  cout << sum(3);", "}"];

/** [line, call stack (innermost last), variables of the top frame, output] */
const STEPS: [number, string[], [string, string][], string][] = [
  [7, ["main"], [], ""],
  [2, ["main", "sum(3)"], [["n", "3"]], ""],
  [3, ["main", "sum(3)"], [["n", "3"]], ""],
  [2, ["main", "sum(3)", "sum(2)"], [["n", "2"]], ""],
  [3, ["main", "sum(3)", "sum(2)"], [["n", "2"]], ""],
  [2, ["main", "sum(3)", "sum(2)", "sum(1)"], [["n", "1"]], ""],
  [3, ["main", "sum(3)", "sum(2)", "sum(1)"], [["n", "1"]], ""],
  [2, ["main", "sum(3)", "sum(2)", "sum(1)", "sum(0)"], [["n", "0"]], ""],
  [3, ["main", "sum(3)", "sum(2)", "sum(1)"], [["n", "1"], ["return", "1"]], ""],
  [3, ["main", "sum(3)", "sum(2)"], [["n", "2"], ["return", "3"]], ""],
  [3, ["main", "sum(3)"], [["n", "3"], ["return", "6"]], ""],
  [7, ["main"], [], "6"],
];

/** The step-by-step debugger replaying a recursive call, forwards. */
export function ReplayDemo({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useFrames(ref, 900, 7);
  const i = frame % (STEPS.length + 2);
  const [line, stack, vars, out] = STEPS[Math.min(i, STEPS.length - 1)];
  return (
    <div ref={ref} className={className} role="img" aria-label="An example of stepping through a recursive program in the debugger">
      <Frame title="debug replay · main.cpp" badge={<span className="font-mono text-[0.625rem] text-faint">step {Math.min(i, STEPS.length - 1) + 1}/{STEPS.length}</span>}>
        <div className="h-1 bg-line/60">
          <div className="h-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${((Math.min(i, STEPS.length - 1) + 1) / STEPS.length) * 100}%` }} />
        </div>
        <div className="grid gap-0 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <pre className="relative overflow-hidden py-2 font-mono text-[0.75rem] leading-6 text-muted">
            <span
              className="absolute inset-x-0 h-6 border-l-2 border-accent bg-accent/10 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ transform: `translateY(${(line - 1) * 24}px)`, top: 8 }}
              aria-hidden="true"
            />
            {CODE.map((l, n) => (
              <div key={n} className="relative flex">
                <span className="w-8 shrink-0 select-none pr-2 text-right text-faint/70">{n + 1}</span>
                <span className={n + 1 === line ? "text-ink" : ""}>{l || " "}</span>
              </div>
            ))}
          </pre>
          <div className="space-y-3 border-t border-line/70 p-3 sm:border-l sm:border-t-0">
            <div>
              <p className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-faint">Call stack</p>
              <div className="space-y-1">
                {[...stack].reverse().map((f, k) => (
                  <div
                    key={`${f}-${stack.length - k}`}
                    className={`animate-[vr-pop_200ms_ease-out] rounded-md px-2 py-1 font-mono text-[0.6875rem] ${k === 0 ? "bg-accent/10 text-ink" : "text-faint"}`}
                  >
                    {f}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-faint">Variables</p>
              {vars.length === 0 ? (
                <p className="font-mono text-[0.6875rem] text-faint">—</p>
              ) : (
                vars.map(([k, v]) => (
                  <div key={k + v} className="flex animate-[vr-pop_250ms_ease-out] justify-between rounded-md bg-warn/10 px-2 py-1 font-mono text-[0.6875rem]">
                    <span className="text-muted">{k}</span>
                    <span className="font-semibold text-ink">{v}</span>
                  </div>
                ))
              )}
            </div>
            <div>
              <p className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-faint">Output</p>
              <p className="font-mono text-[0.75rem] text-ink">{out || <span className="text-faint">(nothing yet)</span>}</p>
            </div>
          </div>
        </div>
      </Frame>
    </div>
  );
}

// ---- hosting ----------------------------------------------------------------------

const BUILD = [
  ["A", "Two Piles", "Easy"],
  ["B", "Lucky Paths", "Medium"],
  ["C", "Grid Walk", "Hard"],
];

/** A contest being put together: problems drop in, the checklist fills, it goes live, people register. */
export function ContestBuilder({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useFrames(ref, 900, 8);
  const f = frame % 11; // 0-2 problems, 3 tests, 4 publish, 5-9 registrations, 10 rest
  const added = Math.min(f + 1, 3);
  const tested = f >= 3;
  const live = f >= 4;
  const registered = live ? [0, 12, 37, 68, 104, 128, 128][Math.min(f - 4, 6)] : 0;
  const checks: [string, boolean][] = [
    ["Problems added", added === 3],
    ["Hidden tests", tested],
    ["Published", live],
  ];
  return (
    <div ref={ref} className={className} role="img" aria-label="An example of a contest being set up and published">
      <Frame title="host · weekend-round" badge={live ? <LivePill /> : <span className="rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[0.625rem] font-medium text-faint">Draft</span>}>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-display text-lg font-semibold tracking-tight text-ink">Weekend Round #12</p>
              <p className="text-xs text-faint">Codeforces rules · 2 h · Sat 18:00</p>
            </div>
            <div className="text-right">
              <p className="flex items-center justify-end gap-1 font-mono text-lg font-semibold tabular text-ink">
                <Users size={14} className="text-accent" aria-hidden="true" /> {registered}
              </p>
              <p className="text-[0.625rem] text-faint">registered</p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {BUILD.map(([label, title, level], k) => (
              <div
                key={label}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  k < added ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
                } ${tested ? "border-good/30 bg-good/[0.04]" : "border-line bg-paper/50"}`}
              >
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/10 font-display font-semibold text-accent">{label}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{title}</span>
                  <span className="block text-[0.6875rem] text-faint">{level}</span>
                </span>
                <span className={`text-[0.6875rem] font-medium transition-colors ${tested ? "text-good" : "text-warn"}`}>{tested ? "ready" : "needs tests"}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line/70 pt-3">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {checks.map(([label, ok]) => (
                <span key={label} className={`flex items-center gap-1 text-[0.6875rem] transition-colors ${ok ? "text-good" : "text-faint"}`}>
                  <span className={`grid h-3.5 w-3.5 place-items-center rounded-full transition-colors ${ok ? "bg-good text-white" : "border border-line-strong"}`}>
                    {ok && <Check size={9} strokeWidth={3} aria-hidden="true" />}
                  </span>
                  {label}
                </span>
              ))}
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-300 ${
                live ? "bg-good/15 text-good" : f === 3 ? "scale-95 bg-accent text-accent-ink" : "bg-accent text-accent-ink"
              }`}
            >
              {live ? <Trophy size={12} aria-hidden="true" /> : null}
              {live ? "Live" : "Publish"}
            </span>
          </div>
        </div>
      </Frame>
    </div>
  );
}
