import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpFromLine,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  PencilLine,
  FastForward,
  Rewind,
  SkipBack,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import { ApiError } from "../api/client";
import { replaysApi } from "../api/endpoints";
import type { Replay, ReplayFrame, ReplayStep } from "../api/types";
import { EmptyState, ErrorState, Spinner } from "../components/Feedback";
import FixAndDebug, { parseDiagnostics } from "../components/FixAndDebug";
import { Eyebrow, Notice } from "../components/ui";

/** Steps fetched per request; the next page is prefetched as the cursor nears it. */
const PAGE = 50;

/**
 * Steps through a recorded run. The recording is made once by a worker; every
 * move here only reads it, so stepping backwards is as cheap as forwards and
 * the program never runs again.
 */
export default function ReplayPage() {
  const { id = "" } = useParams();
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [id]);
  const replay = useQuery({
    queryKey: ["replay", id],
    // The server holds each request until the recording is ready, so asking
    // again straight away is a long poll, not a busy loop.
    queryFn: ({ signal }) => replaysApi.get(id, 8000, signal),
    refetchInterval: (q) => (q.state.status === "error" || q.state.data?.status === "FINISHED" ? false : 10),
  });

  if (replay.isPending) return <Spinner label="Loading the replay…" />;
  if (replay.isError) {
    if (replay.error instanceof ApiError && replay.error.status === 404) {
      return (
        <EmptyState
          title="Replay not found"
          message="It may have expired: recordings are kept for a week."
          action={
            <Link to="/problems" className="btn btn-primary">
              Back to problems
            </Link>
          }
        />
      );
    }
    return <ErrorState title="Couldn't load this replay" message={replay.error.message} onRetry={() => replay.refetch()} />;
  }

  const r = replay.data;
  return (
    <div className="space-y-5">
      <Header replay={r} onEdit={r.status === "FINISHED" && r.step_count > 0 && !editing ? () => setEditing(true) : undefined} />
      {editing ? (
        <FixAndDebug replay={r} onCancel={() => setEditing(false)} />
      ) : r.status !== "FINISHED" ? (
        <div role="status" className="card flex items-center gap-4 p-6">
          <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          <div>
            <p className="font-medium text-ink">
              {r.status === "RECORDING" ? "Recording your program…" : "Waiting for a recorder…"}
            </p>
            <p className="mt-1 text-sm text-muted">
              Every line runs under a debugger and its state is saved, so this takes a few seconds. You can then
              move through the run in both directions.
            </p>
          </div>
        </div>
      ) : r.step_count === 0 ? (
        <NothingToStep replay={r} />
      ) : (
        <Viewer replay={r} />
      )}
    </div>
  );
}

function Header({ replay: r, onEdit }: { replay: Replay; onEdit?: () => void }) {
  return (
    <header>
      <Link to={r.problem_slug ? `/problems/${r.problem_slug}` : "/problems"} className="text-sm text-muted hover:text-ink">
        ← {r.problem_slug ? "Back to the problem" : "All problems"}
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Debug replay</Eyebrow>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Step through your run</h1>
          <p className="mt-1 text-sm text-muted">
            C++17
            {r.status === "FINISHED" && r.step_count > 0 && ` · ${r.step_count.toLocaleString()} steps recorded`}
            {r.stdin.trim() ? " · with your input" : " · no input"}
          </p>
        </div>
        {onEdit && (
          <button type="button" className="btn btn-outline" onClick={onEdit}>
            <PencilLine size={16} aria-hidden="true" /> Edit code and debug again
          </button>
        )}
      </div>
    </header>
  );
}

function NothingToStep({ replay: r }: { replay: Replay }) {
  const kind = r.termination?.kind;
  if (kind === "COMPILE_ERROR") {
    const errors = parseDiagnostics(r.compile_output).filter((d) => d.severity === "error");
    const first = errors[0];
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl border border-bad/25 bg-bad/[0.05] p-4 sm:flex-row sm:items-center sm:p-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-bad/10 text-bad" aria-hidden="true">
            <span className="font-mono text-sm font-bold">{errors.length || "!"}</span>
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-ink">Your code didn't compile</p>
            <p className="mt-0.5 text-sm text-muted">
              {first
                ? `${errors.length === 1 ? "One error" : `${errors.length} errors`}, the first on line ${first.line}. Fix it below and press Debug again: no need to go back.`
                : "Fix the errors below and press Debug again: no need to go back."}
            </p>
          </div>
        </div>
        <FixAndDebug replay={r} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {kind === "RECORDER_ERROR" ? (
        <Notice tone="bad" title="Recording failed">
          {r.message ?? "The recorder could not record this run."} You can change the code and try again.
        </Notice>
      ) : (
        <Notice title="Nothing to step through">
          The program finished before reaching a line of your code.
          {r.stdout && <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-ink">{r.stdout}</pre>}
        </Notice>
      )}
      <FixAndDebug replay={r} />
    </div>
  );
}

// ---- stepping ----------------------------------------------------------------

type Timeline = [number, number][];

function findForward(t: Timeline, from: number, ok: (line: number, depth: number) => boolean) {
  for (let i = from + 1; i < t.length; i++) if (ok(t[i][0], t[i][1])) return i;
  return undefined;
}

function findBackward(t: Timeline, from: number, ok: (line: number, depth: number) => boolean) {
  for (let i = from - 1; i >= 0; i--) if (ok(t[i][0], t[i][1])) return i;
  return undefined;
}

function Viewer({ replay: r }: { replay: Replay }) {
  const total = r.step_count;
  const last = total - 1;
  const timeline = r.timeline;
  const [step, setStep] = useState(0);
  const [breakpoints, setBreakpoints] = useState<Set<number>>(() => new Set());
  // null follows the executing frame; a click on the call stack pins another.
  const [pinnedFrame, setPinnedFrame] = useState<number | null>(null);

  const go = useCallback(
    (target: number) => {
      setStep(Math.max(0, Math.min(last, target)));
      setPinnedFrame(null);
    },
    [last],
  );

  const [line, depth] = timeline[step] ?? [0, 0];
  const moves = useMemo(
    () => ({
      start: () => 0,
      back: () => step - 1,
      step: () => step + 1,
      // The next line at this depth or shallower: runs a call without entering it.
      over: () => findForward(timeline, step, (_, d) => d <= depth) ?? last,
      // The first line after the current function returns.
      out: () => findForward(timeline, step, (_, d) => d < depth) ?? last,
      continue: () => findForward(timeline, step, (l) => breakpoints.has(l)) ?? last,
      reverse: () => findBackward(timeline, step, (l) => breakpoints.has(l)) ?? 0,
      end: () => last,
    }),
    [timeline, step, depth, last, breakpoints],
  );

  useEffect(() => {
    const keys: Record<string, keyof typeof moves> = {
      ArrowLeft: "back",
      ArrowRight: "step",
      ArrowDown: "over",
      ArrowUp: "out",
      Home: "start",
      End: "end",
      c: "continue",
      C: "reverse",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      // Leave form controls (the step slider included) their own keys.
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) {
        return;
      }
      const move = keys[e.key];
      if (!move) return;
      e.preventDefault();
      go(moves[move]());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moves, go]);

  const toggleBreakpoint = (n: number) =>
    setBreakpoints((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const current = useStep(r.replay_id, step, total);
  const frames = current?.frames ?? [];
  const selected = frames.find((f) => f.index === pinnedFrame) ?? frames[frames.length - 1];
  const callerLines = useMemo(() => new Set(frames.slice(0, -1).map((f) => f.line)), [frames]);
  const executed = useMemo(() => new Set(timeline.map(([l]) => l)), [timeline]);
  const atEnd = step === last;

  return (
    <div className="space-y-4">
      <Ending replay={r} onJump={() => go(last)} />

      <div className="card z-10 flex flex-wrap items-center gap-x-4 gap-y-3 p-3 md:sticky md:top-3">
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Replay controls">
          <Control icon={SkipBack} label="Start" keys="Home" onClick={() => go(moves.start())} disabled={step === 0} />
          <Control icon={Rewind} label="Back to breakpoint" keys="Shift+C" onClick={() => go(moves.reverse())} disabled={step === 0} />
          <Control icon={ChevronLeft} label="Back" keys="←" onClick={() => go(moves.back())} disabled={step === 0} />
          <Control icon={ChevronRight} label="Step" keys="→" onClick={() => go(moves.step())} disabled={atEnd} primary />
          <Control icon={CornerDownRight} label="Step over" keys="↓" onClick={() => go(moves.over())} disabled={atEnd} />
          <Control icon={ArrowUpFromLine} label="Step out" keys="↑" onClick={() => go(moves.out())} disabled={atEnd || depth <= 1} />
          <Control icon={FastForward} label="Continue" keys="C" onClick={() => go(moves.continue())} disabled={atEnd} />
          <Control icon={SkipForward} label="End" keys="End" onClick={() => go(moves.end())} disabled={atEnd} />
        </div>
        <div className="flex min-w-[12rem] flex-1 items-center gap-3">
          <input
            type="range"
            min={0}
            max={last}
            value={step}
            onChange={(e) => go(Number(e.target.value))}
            aria-label="Step"
            aria-valuetext={`Step ${step + 1} of ${total}, line ${line}`}
            className="w-full accent-[rgb(var(--c-accent))]"
          />
          <p className="shrink-0 font-mono text-xs text-muted" data-testid="position">
            Step {step + 1} of {total} · line {line}
          </p>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Source
          code={r.source_code}
          line={line}
          callerLines={callerLines}
          executed={executed}
          breakpoints={breakpoints}
          onToggle={toggleBreakpoint}
        />
        <div className="space-y-4">
          <CallStack frames={frames} selected={selected} onSelect={setPinnedFrame} loading={!current} />
          <Variables frame={selected} />
          <Output replay={r} step={current} atEnd={atEnd} />
        </div>
      </div>

      <p className="text-xs text-faint">
        Keys: ← → step · ↓ step over · ↑ step out · C continue to a breakpoint (Shift+C back) · Home / End. Click a line
        number to set a breakpoint.
      </p>
    </div>
  );
}

/**
 * The step's frames and variables. Pages of steps are cached forever (a
 * recording never changes) and the neighbouring page is fetched before the
 * cursor reaches it; while a far jump loads, the last step stays on screen.
 */
function stepsQuery(replayId: string, page: number) {
  return {
    queryKey: ["replay-steps", replayId, page],
    queryFn: ({ signal }: { signal: AbortSignal }) => replaysApi.steps(replayId, page * PAGE, PAGE, signal),
    staleTime: Infinity,
  };
}

function useStep(replayId: string, step: number, total: number): ReplayStep | undefined {
  const qc = useQueryClient();
  const page = Math.floor(step / PAGE);
  const query = useQuery({ ...stepsQuery(replayId, page), placeholderData: keepPreviousData });

  useEffect(() => {
    const offset = step % PAGE;
    if (offset >= PAGE - 10 && (page + 1) * PAGE < total) void qc.prefetchQuery(stepsQuery(replayId, page + 1));
    if (offset < 10 && page > 0) void qc.prefetchQuery(stepsQuery(replayId, page - 1));
  }, [qc, replayId, page, step, total]);

  const found = query.data?.steps.find((s) => s.step === step);
  const shown = useRef<ReplayStep | undefined>(undefined);
  if (found) shown.current = found;
  return found ?? shown.current;
}

function Control({
  icon: Icon,
  label,
  keys,
  onClick,
  disabled,
  primary,
}: {
  icon: LucideIcon;
  label: string;
  keys: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`${label} (${keys})`}
      aria-keyshortcuts={keys.replace("←", "ArrowLeft").replace("→", "ArrowRight").replace("↓", "ArrowDown").replace("↑", "ArrowUp")}
      className={`${primary ? "btn btn-primary" : "btn btn-outline"} min-h-[36px] gap-1.5 px-2.5 py-1 text-xs`}
    >
      <Icon size={15} aria-hidden="true" />
      <span className={primary ? "" : "sr-only xl:not-sr-only"}>{label}</span>
    </button>
  );
}

function Ending({ replay: r, onJump }: { replay: Replay; onJump: () => void }) {
  const t = r.termination;
  if (!t) return null;
  if (t.kind === "CRASHED") {
    return (
      <Notice tone="bad" title="Your program crashed">
        {t.detail ? `${t.detail}. ` : ""}The last step is where it stopped, with the call stack as it was.{" "}
        <button type="button" onClick={onJump} className="font-medium text-accent hover:underline">
          Jump to the crash
        </button>
      </Notice>
    );
  }
  if (t.kind === "STEP_LIMIT" || t.kind === "TIME_LIMIT") {
    return (
      <Notice tone="warn" title="Recording stopped early">
        {t.kind === "STEP_LIMIT"
          ? `Only the first ${r.step_count.toLocaleString()} steps were recorded. A smaller input lets the whole run fit.`
          : "The program ran past the recording's time limit; here is everything up to that point."}
      </Notice>
    );
  }
  return null;
}

// ---- panels ------------------------------------------------------------------

function Panel({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  const id = `panel-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section className="card overflow-hidden" aria-labelledby={id}>
      <div className="panel-meta">
        <h2 id={id} className="font-semibold text-muted">
          {title}
        </h2>
        {meta}
      </div>
      {children}
    </section>
  );
}

function Source({
  code,
  line,
  callerLines,
  executed,
  breakpoints,
  onToggle,
}: {
  code: string;
  line: number;
  callerLines: Set<number>;
  executed: Set<number>;
  breakpoints: Set<number>;
  onToggle: (line: number) => void;
}) {
  const lines = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);
  const currentRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [line]);

  return (
    <Panel title="Source" meta={<span>main.cpp</span>}>
      <ol className="max-h-[70vh] overflow-auto py-2 font-mono text-[0.8125rem] leading-6" aria-label="Source code">
        {lines.map((text, i) => {
          const n = i + 1;
          const isCurrent = n === line;
          const hasBreakpoint = breakpoints.has(n);
          return (
            <li
              key={n}
              ref={isCurrent ? currentRef : undefined}
              aria-current={isCurrent ? "step" : undefined}
              data-line={n}
              className={`group flex ${
                isCurrent
                  ? "bg-accent/15 shadow-[inset_3px_0_0_rgb(var(--c-accent))]"
                  : callerLines.has(n)
                    ? "bg-warn/10"
                    : ""
              }`}
            >
              <button
                type="button"
                onClick={() => onToggle(n)}
                aria-label={`Breakpoint on line ${n}`}
                aria-pressed={hasBreakpoint}
                className="relative w-14 shrink-0 select-none pr-3 text-right text-faint hover:text-ink"
              >
                <span
                  aria-hidden="true"
                  className={`absolute left-2.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full ${
                    hasBreakpoint ? "bg-bad" : "group-hover:bg-bad/30"
                  }`}
                />
                {n}
              </button>
              <span aria-hidden="true" className="w-4 shrink-0 text-accent">
                {isCurrent ? "▶" : ""}
              </span>
              <code className={`whitespace-pre pr-4 ${executed.has(n) ? "text-ink" : "text-faint"}`}>{text || " "}</code>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function CallStack({
  frames,
  selected,
  onSelect,
  loading,
}: {
  frames: ReplayFrame[];
  selected: ReplayFrame | undefined;
  onSelect: (index: number) => void;
  loading: boolean;
}) {
  return (
    <Panel title="Call stack" meta={loading ? <span>loading…</span> : <span>{frames.length} deep</span>}>
      <ol className="divide-y divide-line/60">
        {[...frames].reverse().map((f, i) => {
          const isSelected = f === selected;
          return (
            <li key={f.index}>
              <button
                type="button"
                onClick={() => onSelect(f.index)}
                aria-pressed={isSelected}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                  isSelected ? "bg-accent/10 text-ink" : "text-muted hover:bg-sunken/60 hover:text-ink"
                }`}
              >
                <span className="truncate font-mono">{f.function}</span>
                <span className="shrink-0 text-xs text-faint">{i === 0 ? `line ${f.line}` : `called at line ${f.line}`}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/** Splits `v[2].x` into `v`, `[2]`, `x`. */
function pathSegments(path: string): string[] {
  return path.match(/\[[^\]]*\]|[^.[\]]+/g) ?? [path];
}

function Variables({ frame }: { frame: ReplayFrame | undefined }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => {
    if (!frame) return [];
    const vars = frame.variables;
    const out: { name: string; label: string; depth: number; value: string; type: string | null; changed: boolean; parent: boolean; key: string }[] = [];
    let hiddenUnder: string | null = null;
    vars.forEach((v, i) => {
      const key = `${frame.function}:${v.name}`;
      if (hiddenUnder && (v.name.startsWith(`${hiddenUnder}[`) || v.name.startsWith(`${hiddenUnder}.`))) return;
      hiddenUnder = null;
      const segs = pathSegments(v.name);
      const nextName = vars[i + 1]?.name ?? "";
      const parent = nextName.startsWith(`${v.name}[`) || nextName.startsWith(`${v.name}.`);
      out.push({
        name: v.name,
        label: segs[segs.length - 1],
        depth: segs.length - 1,
        value: v.value,
        type: v.type,
        changed: v.changed,
        parent,
        key,
      });
      if (parent && collapsed.has(key)) hiddenUnder = v.name;
    });
    return out;
  }, [frame, collapsed]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Panel title="Variables" meta={frame && <span className="normal-case">{frame.function}</span>}>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-faint">No variables in scope yet.</p>
      ) : (
        <table className="w-full table-fixed text-sm">
          <thead className="sr-only">
            <tr>
              <th>Name</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[0.8125rem]">
            {rows.map((row) => (
              <tr
                key={row.key}
                data-variable={row.name}
                data-changed={row.changed}
                className={`border-b border-line/40 last:border-0 ${row.changed ? "bg-accent/10" : ""}`}
              >
                <td className="w-2/5 truncate py-1.5 pr-2" style={{ paddingLeft: `${1 + row.depth * 0.9}rem` }}>
                  {row.parent ? (
                    <button
                      type="button"
                      onClick={() => toggle(row.key)}
                      aria-expanded={!collapsed.has(row.key)}
                      aria-label={`${collapsed.has(row.key) ? "Expand" : "Collapse"} ${row.name}`}
                      className="mr-1 inline-block w-3 text-faint hover:text-ink"
                    >
                      {collapsed.has(row.key) ? "▸" : "▾"}
                    </button>
                  ) : (
                    <span className="mr-1 inline-block w-3" />
                  )}
                  <span className={row.depth === 0 ? "text-ink" : "text-muted"} title={row.type ?? undefined}>
                    {row.label}
                  </span>
                </td>
                <td className="break-all py-1.5 pr-4 text-ink">
                  {row.value}
                  {row.changed && <span className="ml-2 text-[0.6875rem] font-sans text-accent">changed</span>}
                  {row.type && <span className="ml-2 font-sans text-[0.6875rem] text-faint">{shortType(row.type)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** `std::vector<long long, std::allocator<long long> >` reads better as `std::vector<long long>`. */
function shortType(type: string): string {
  return type.replace(/,\s*std::allocator<[^<>]*(<[^<>]*>)?[^<>]*>\s*/g, "").replace(/\s+>/g, ">");
}

function Output({ replay: r, step, atEnd }: { replay: Replay; step: ReplayStep | undefined; atEnd: boolean }) {
  // A step is the moment before its line runs, so the last line's output only
  // exists once the program has exited.
  const exited = atEnd && r.termination?.kind === "EXITED";
  const text = exited ? r.stdout : r.stdout.slice(0, step?.stdout_length ?? 0);
  return (
    <Panel
      title="Output"
      meta={exited ? <span>exited with code {r.termination?.exit_code ?? 0}</span> : <span>so far</span>}
    >
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-ink">
        {text || <span className="text-faint">(nothing printed yet)</span>}
      </pre>
      {r.stdin.trim() && (
        <details className="border-t border-line/60 px-4 py-2 text-xs">
          <summary className="cursor-pointer text-muted">Input</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-ink">{r.stdin}</pre>
        </details>
      )}
    </Panel>
  );
}
