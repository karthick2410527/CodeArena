import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BadgeCheck,
  BarChart3,
  BookOpen,
  CalendarClock,
  Check,
  ChevronRight,
  DownloadCloud,
  ExternalLink,
  Eye,
  FolderOpen,
  ListChecks,
  Lock,
  PenSquare,
  Plus,
  Rocket,
  Settings2,
  Timer,
  Trash2,
  Trophy,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { billingApi, contestsApi, studioApi } from "../../api/endpoints";
import { ApiError } from "../../api/client";
import type { ContestDetail, ContestFormat, ContestInput } from "../../api/types";
import { useAuth, useViewer } from "../../auth/AuthContext";
import { FORMAT_HELP, FORMAT_LABELS, PhaseBadge, formatDuration, formatWhen, livePhase, useNow } from "../../components/contest";
import { Ring, RollingClock } from "../../components/flair";
import Markdown, { sourceName } from "../../components/Markdown";
import { ErrorState, Spinner } from "../../components/Feedback";
import CreateContestWizard from "./CreateContestWizard";
import { DURATIONS, FORMATS, defaultStart, message, toLocalInput } from "./contestForm";
import { Avatar, UserLink } from "../../components/people";
import { Notice } from "../../components/ui";

/** Create a contest (/contests/new) or manage one you author (/contests/:slug/manage). */
export default function ContestEditPage() {
  const { slug } = useParams();
  const { ready } = useViewer();
  const detail = useQuery({
    queryKey: ["contest", slug],
    queryFn: ({ signal }) => contestsApi.get(slug!, signal),
    enabled: Boolean(slug) && ready,
  });
  if (!slug) return <CreateContestWizard />;
  if (detail.isPending) return <Spinner label="Loading the contest…" />;
  if (detail.isError) return <ErrorState title="Couldn't load the contest" message={detail.error.message} />;
  if (!detail.data.contest.my_role) {
    return <ErrorState title="Not yours to manage" message="Only the contest's authors can change it." />;
  }
  return <Manage d={detail.data} />;
}

type Tab = "overview" | "details" | "problems" | "editorial" | "authors";

const TABS: [Tab, string, LucideIcon][] = [
  ["overview", "Overview", Rocket],
  ["details", "Details", Settings2],
  ["problems", "Problems", ListChecks],
  ["editorial", "Editorial", BookOpen],
  ["authors", "Authors", Users],
];

/** Your problems (studio), shared by the panels that need their ids, test counts and sources. */
function useMyProblems() {
  const mine = useQuery({
    queryKey: ["admin-problems", "studio", { page: 1, limit: 50 }],
    queryFn: () => studioApi.listProblems({ page: 1, limit: 50 }),
  });
  const bySlug = useMemo(() => new Map((mine.data?.items ?? []).map((p) => [p.slug, p])), [mine.data]);
  const byId = useMemo(() => new Map((mine.data?.items ?? []).map((p) => [p.id, p])), [mine.data]);
  return { mine, bySlug, byId };
}

function Manage({ d }: { d: ContestDetail }) {
  const c = d.contest;
  const now = useNow(d.server_time);
  const phase = livePhase(c.starts_at, c.ends_at, now);
  const locked = c.published && phase !== "UPCOMING";
  const target = new Date(phase === "UPCOMING" ? c.starts_at : c.ends_at).getTime();
  const [params, setParams] = useSearchParams();
  // Back from writing a problem for this contest (?add=…): the Problems tab adds it.
  const tab: Tab = params.get("add") ? "problems" : (TABS.find(([t]) => t === params.get("tab"))?.[0] ?? "overview");
  const go = (t: Tab) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", t);
        return next;
      },
      { replace: true },
    );
  const counts: Partial<Record<Tab, number>> = { problems: c.problem_count, authors: c.authors.length };
  const facts: [LucideIcon, string][] = [
    [CalendarClock, formatWhen(c.starts_at)],
    [Timer, formatDuration(c.duration_minutes)],
    [Trophy, FORMAT_LABELS[c.format]],
    [Users, `${c.participants} registered`],
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <nav aria-label="Breadcrumb" className="mb-5 flex min-w-0 items-center gap-1.5 text-sm text-muted">
        <Link to="/host" className="inline-flex items-center gap-1.5 hover:text-ink">
          <ArrowLeft size={14} aria-hidden="true" /> Host
        </Link>
        <ChevronRight size={14} className="text-faint" aria-hidden="true" />
        <span className="truncate text-ink">{c.title}</span>
      </nav>

      <header className="relative mb-8 overflow-hidden rounded-[1.75rem] border border-line/80 bg-surface p-6 shadow-panel sm:p-8">
        <div className="dots pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
        <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-accent/15 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PhaseBadge phase={phase} published={c.published} />
              <span className="text-xs text-faint">{c.my_role === "OWNER" ? "You own this contest" : "You co-author this contest"}</span>
            </div>
            <h1 className="mt-3 truncate font-display text-[2.25rem] font-semibold leading-none tracking-tight text-ink sm:text-[2.75rem]">
              {c.title}
            </h1>
            <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
              {facts.map(([Icon, text]) => (
                <li key={text} className="flex items-center gap-1.5">
                  <Icon size={15} className="text-accent" aria-hidden="true" /> {text}
                </li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-2">
              {!c.published && (
                <button type="button" className="btn btn-primary min-h-[42px] px-5" onClick={() => go("overview")}>
                  <Rocket size={15} aria-hidden="true" /> Get it ready to publish
                </button>
              )}
              <Link to={`/contests/${c.slug}`} className="btn btn-outline min-h-[42px] px-4">
                <ExternalLink size={15} aria-hidden="true" /> View contest page
              </Link>
              {phase !== "UPCOMING" && (
                <Link to={`/contests/${c.slug}/standings`} className="btn btn-ghost min-h-[42px] px-4">
                  <BarChart3 size={15} aria-hidden="true" /> Standings
                </Link>
              )}
            </div>
          </div>
          {phase !== "ENDED" && (
            <div className="shrink-0">
              <p className={`mb-2.5 text-xs font-semibold uppercase tracking-[0.14em] ${phase === "RUNNING" ? "text-good" : "text-faint"}`}>
                {phase === "RUNNING" ? "Live · ends in" : "Starts in"}
              </p>
              <RollingClock ms={target - now} label={phase === "RUNNING" ? "Time left" : "Time to the start"} tone={phase === "RUNNING" ? "good" : "accent"} />
            </div>
          )}
        </div>
      </header>

      {locked && (
        <div className="mb-6">
          <Notice tone="warn">
            The contest has started: its schedule, format and problems are fixed. You can still edit the title and
            description.
          </Notice>
        </div>
      )}

      <div role="tablist" aria-label="Contest settings" className="mb-6 flex gap-6 overflow-x-auto border-b border-line">
        {TABS.map(([t, label, Icon]) => {
          const on = t === tab;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              id={`tab-${t}`}
              aria-selected={on}
              aria-controls="manage-panel"
              onClick={() => go(t)}
              className={`relative -mb-px flex shrink-0 items-center gap-2 pb-3 pt-1 text-sm font-medium transition-colors ${on ? "text-ink" : "text-muted hover:text-ink"}`}
            >
              <Icon size={15} className={on ? "text-accent" : ""} aria-hidden="true" />
              {label}
              {counts[t] !== undefined && (
                <span className={`rounded-full px-1.5 text-xs tabular ${on ? "bg-accent/10 text-accent" : "bg-sunken text-faint"}`}>{counts[t]}</span>
              )}
              <span
                className={`absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent transition-transform duration-300 ${on ? "scale-x-100" : "scale-x-0"}`}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="manage-panel" aria-labelledby={`tab-${tab}`} key={tab} className="animate-step min-w-0 space-y-6">
        {tab === "overview" && <Overview d={d} phase={phase} onGo={go} />}
        {tab === "details" && (
          <>
            <ContestForm existing={d} locked={locked} />
            {c.my_role === "OWNER" && !locked && <DangerZone slug={c.slug} />}
          </>
        )}
        {tab === "problems" && <ProblemsPanel d={d} locked={locked} />}
        {tab === "editorial" && <EditorialPanel d={d} />}
        {tab === "authors" && <AuthorsPanel d={d} />}
      </div>
    </div>
  );
}

/** What is left before the round can go public, as a checklist beside the publish box. */
function Overview({ d, phase, onGo }: { d: ContestDetail; phase: string; onGo: (t: Tab) => void }) {
  const c = d.contest;
  const { bySlug, mine } = useMyProblems();
  const untested = d.problems.filter((p) => (bySlug.get(p.slug)?.hidden_count ?? 1) === 0);
  // [label, hint, done (null: not yet decidable), tab, optional]
  const checks: [string, string, boolean | null, Tab, boolean?][] = [
    ["Details and schedule", `${FORMAT_LABELS[c.format]}, ${formatDuration(c.duration_minutes)}`, true, "details"],
    [
      "Problems",
      d.problems.length ? `${d.problems.length} problem${d.problems.length === 1 ? "" : "s"}` : "Add at least one",
      d.problems.length > 0,
      "problems",
    ],
    [
      "Hidden tests",
      d.problems.length === 0
        ? "Once you add problems"
        : !mine.data
          ? "Checking…"
          : untested.length
            ? `Missing for ${untested.map((p) => p.label).join(", ")}`
            : "Every problem can be judged",
      d.problems.length > 0 && mine.data ? untested.length === 0 : null,
      "problems",
    ],
    ["Editorial", "Released when the contest ends", null, "editorial", true],
    ["Co-authors", c.authors.length > 1 ? `${c.authors.length - 1} invited` : "Write and test it with others", c.authors.length > 1 ? true : null, "authors", true],
  ];
  const required = checks.filter(([, , , , optional]) => !optional);
  const done = required.filter(([, , ok]) => ok).length;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="card p-5 sm:p-6" aria-labelledby="ready-h">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 id="ready-h" className="font-display text-lg font-semibold text-ink">
              Getting it ready
            </h2>
            <p className="text-sm text-muted">Work down the list; click a step to jump to it.</p>
          </div>
          <Ring value={done} max={required.length} size={44} label={`${done} of ${required.length} done`} />
        </div>
        <ol className="relative">
          {checks.map(([label, hint, ok, t, optional], i) => (
            <li key={label} className="relative pb-1 last:pb-0">
              {i < checks.length - 1 && <span className="absolute left-[1.15rem] top-10 h-[calc(100%-1.5rem)] w-px bg-line" aria-hidden="true" />}
              <button type="button" onClick={() => onGo(t)} className="group flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-sunken/50">
                <span
                  className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-full ${
                    ok ? "bg-good text-white" : ok === false ? "border-2 border-warn bg-surface text-warn" : "border-2 border-line-strong bg-surface text-faint"
                  }`}
                >
                  {ok ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <span className="font-mono text-[0.6875rem] font-semibold">{i + 1}</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    {label}
                    {optional && <span className="rounded-full bg-sunken px-1.5 text-[0.625rem] font-medium text-faint">optional</span>}
                  </span>
                  <span className={`block text-xs ${ok === false ? "text-warn" : "text-faint"}`}>{hint}</span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      </section>
      <PublishPanel d={d} phase={phase} />
    </div>
  );
}

/** The top of each panel: an icon, the title, one line on what it's for, actions on the right. */
function PanelHead({ icon: Icon, id, title, children, right }: { icon: LucideIcon; id: string; title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 gap-3">
        <span className="icon-tile shrink-0">
          <Icon size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">{children}</p>
        </div>
      </div>
      {right && <div className="flex flex-wrap gap-2">{right}</div>}
    </div>
  );
}

// ---- details --------------------------------------------------------------------

function ContestForm({ existing, locked = false }: { existing?: ContestDetail; locked?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const c = existing?.contest;
  const [title, setTitle] = useState(c?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [format, setFormat] = useState<ContestFormat>(c?.format ?? "CODEFORCES");
  const [start, setStart] = useState(toLocalInput(c?.starts_at ?? defaultStart()));
  const [duration, setDuration] = useState(c?.duration_minutes ?? 120);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const body: ContestInput = { title: title.trim(), description };
      if (!locked) {
        body.format = format;
        body.starts_at = new Date(start).toISOString();
        body.duration_minutes = duration;
      }
      return c ? contestsApi.update(c.slug, body) : contestsApi.create(body);
    },
    onSuccess: (next) => {
      setError(null);
      setSaved(true);
      qc.setQueryData(["contest", next.contest.slug], next);
      void qc.invalidateQueries({ queryKey: ["contests"] });
      void qc.invalidateQueries({ queryKey: ["my-contests"] });
      if (!c) navigate(`/contests/${next.contest.slug}/manage`, { replace: true });
    },
    onError: (e) => setError(message(e)),
  });

  return (
    <form
      className="card space-y-5 p-5 sm:p-6"
      aria-labelledby="details-h"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        if (!title.trim()) {
          setError("Give the contest a title.");
          return;
        }
        save.mutate();
      }}
    >
      <PanelHead icon={Settings2} id="details-h" title="Details">
        The name, schedule and scoring rule. The schedule and rule are fixed once the contest starts.
      </PanelHead>
      {error && <Notice tone="bad">{error}</Notice>}
      {saved && !error && <Notice tone="good">Saved.</Notice>}
      <div>
        <label htmlFor="contest-title" className="label">
          Title
        </label>
        <input id="contest-title" className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Weekend Round #1" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="contest-start" className="label">
            Starts
          </label>
          <input
            id="contest-start"
            type="datetime-local"
            className="input"
            value={start}
            disabled={locked}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="contest-duration" className="label">
            Length
          </label>
          <select
            id="contest-duration"
            className="input"
            value={duration}
            disabled={locked}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {Array.from(new Set([...DURATIONS, duration])).sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {formatDuration(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="contest-format" className="label">
            Scoring
          </label>
          <select
            id="contest-format"
            className="input"
            value={format}
            disabled={locked}
            onChange={(e) => setFormat(e.target.value as ContestFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted">{FORMAT_HELP[format]}</p>
      <div>
        <label htmlFor="contest-description" className="label">
          Description and rules <span className="font-normal text-faint">(Markdown)</span>
        </label>
        <textarea
          id="contest-description"
          className="input min-h-[120px] font-mono text-[13px]"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What the round is about, who it is for, any announcements…"
        />
      </div>
      <div className="flex justify-end">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : c ? "Save details" : "Create draft"}
        </button>
      </div>
    </form>
  );
}

// ---- problems -------------------------------------------------------------------

type Chosen = { problem_id: string; slug: string; title: string; points: number };

function ProblemsPanel({ d, locked }: { d: ContestDetail; locked: boolean }) {
  const qc = useQueryClient();
  const c = d.contest;
  const { mine, bySlug, byId } = useMyProblems();
  const [chosen, setChosen] = useState<Chosen[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const addId = params.get("add");

  // Start from what the contest has, once we know the problems' ids.
  useEffect(() => {
    if (chosen !== null || !mine.data) return;
    setChosen(
      d.problems.flatMap((p) => {
        const known = bySlug.get(p.slug);
        return known ? [{ problem_id: known.id, slug: p.slug, title: p.title, points: p.points }] : [];
      }),
    );
  }, [chosen, mine.data, d.problems, bySlug]);

  const save = useMutation({
    mutationFn: (list: Chosen[]) =>
      contestsApi.setProblems(
        c.slug,
        list.map((p) => ({ problem_id: p.problem_id, points: c.format === "ICPC" ? undefined : p.points })),
      ),
    onSuccess: (next) => {
      qc.setQueryData(["contest", c.slug], next);
      setError(null);
      setChosen(null);
    },
    onError: (e) => setError(message(e)),
  });

  // Back from writing or importing a problem for this contest: put it in straight away.
  useEffect(() => {
    if (!addId || chosen === null || !mine.data || locked) return;
    const p = byId.get(addId);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("add");
        next.set("tab", "problems");
        return next;
      },
      { replace: true },
    );
    if (!p || chosen.some((x) => x.problem_id === p.id)) return;
    const next = [...chosen, { problem_id: p.id, slug: p.slug, title: p.title, points: defaultPoints(c.format, chosen.length) }];
    setChosen(next);
    save.mutate(next, { onSuccess: () => setAdded(p.title) });
  }, [addId, chosen, mine.data, byId, locked, c.format, save, setParams]);

  const list = chosen ?? [];
  const available = (mine.data?.items ?? []).filter((p) => !list.some((x) => x.problem_id === p.id));
  const move = (i: number, by: number) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x);
    setChosen(next);
  };
  const dirty =
    chosen !== null &&
    (chosen.length !== d.problems.length ||
      chosen.some((p, i) => p.slug !== d.problems[i]?.slug || p.points !== d.problems[i]?.points));
  const newProblem = `/studio/problems/new?contest=${encodeURIComponent(c.slug)}`;
  const pick = (id: string) => {
    const p = available.find((x) => x.id === id);
    if (p) setChosen([...list, { problem_id: p.id, slug: p.slug, title: p.title, points: defaultPoints(c.format, list.length) }]);
  };

  return (
    <section aria-labelledby="problems-h" className="space-y-4">
      <div className="card p-5 sm:p-6">
        <PanelHead icon={ListChecks} id="problems-h" title="Problems">
          Hidden from everyone but the authors until the start, and open for practice once the contest ends. Each one
          needs hidden tests before you can publish.
        </PanelHead>
        {error && (
          <div className="mb-3">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
        {added && !error && (
          <div className="mb-3">
            <Notice tone="good">“{added}” was added to the contest.</Notice>
          </div>
        )}
        {mine.isPending ? (
          <Spinner label="Loading your problems…" />
        ) : list.length === 0 ? (
          locked ? (
            <p className="rounded-xl border border-dashed border-line-strong/70 px-4 py-8 text-center text-sm text-muted">This contest has no problems.</p>
          ) : (
            <AddProblems big newProblem={newProblem} available={available} onPick={pick} />
          )
        ) : (
          <ol className="space-y-3" aria-label="Contest problems">

            {list.map((p, i) => {
              const info = byId.get(p.problem_id);
              const tests = info ? info.sample_count + info.hidden_count : 0;
              const ready = info ? info.hidden_count > 0 : true;
              return (
                <li
                  key={p.problem_id}
                  className={`group flex flex-col gap-4 rounded-2xl border bg-paper/40 p-4 transition-colors sm:flex-row sm:items-center ${
                    ready ? "border-line/80 hover:border-line-strong" : "border-warn/40"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 font-display text-xl font-semibold text-accent ring-1 ring-accent/20">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/studio/problems/${p.problem_id}`} className="truncate font-semibold text-ink hover:text-accent">
                          {p.title}
                        </Link>
                        {info && <span className="chip">{info.difficulty[0] + info.difficulty.slice(1).toLowerCase()}</span>}
                        {info?.source_url && (
                          <a href={info.source_url} target="_blank" rel="noopener noreferrer" className="chip hover:text-ink">
                            {sourceName(info.source_url)} ↗
                          </a>
                        )}
                      </div>
                      {info && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          <span className="flex items-center gap-1.5 text-muted">
                            <Eye size={13} aria-hidden="true" /> {info.sample_count} sample{info.sample_count === 1 ? "" : "s"}
                          </span>
                          <span className={`flex items-center gap-1.5 ${ready ? "text-muted" : "font-medium text-warn"}`}>
                            <Lock size={13} aria-hidden="true" /> {info.hidden_count} hidden
                          </span>
                          {!ready && (
                            <Link to={`/studio/problems/${p.problem_id}#tests`} className="font-medium text-warn underline-offset-2 hover:underline">
                              needs hidden tests
                            </Link>
                          )}
                          {ready && tests > 0 && (
                            <span className="flex items-center gap-1 text-good">
                              <Check size={13} strokeWidth={3} aria-hidden="true" /> ready to judge
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 sm:pl-2">
                    {c.format !== "ICPC" && (
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        <span className="sr-only">Points for {p.title}</span>
                        <input
                          type="number"
                          min={1}
                          max={10000}
                          className="input min-h-[34px] w-20 py-1 text-sm tabular"
                          value={p.points}
                          disabled={locked}
                          onChange={(e) =>
                            setChosen(list.map((x, j) => (j === i ? { ...x, points: Number(e.target.value) || 1 } : x)))
                          }
                        />
                        pts
                      </label>
                    )}
                    <Link to={`/studio/problems/${p.problem_id}`} className="btn btn-outline min-h-[34px] px-3 text-xs">
                      <PenSquare size={13} aria-hidden="true" /> Edit
                    </Link>
                    {!locked && (
                      <span className="flex rounded-lg border border-line/80 bg-surface">
                        <button type="button" className="grid h-8 w-8 place-items-center text-muted hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${p.title} up`}>
                          <ArrowUp size={14} />
                        </button>
                        <button type="button" className="grid h-8 w-8 place-items-center border-l border-line/80 text-muted hover:text-ink disabled:opacity-30" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${p.title} down`}>
                          <ArrowDown size={14} />
                        </button>
                        <button type="button" className="grid h-8 w-8 place-items-center border-l border-line/80 text-muted hover:text-bad" onClick={() => setChosen(list.filter((_, j) => j !== i))} aria-label={`Remove ${p.title}`}>
                          <X size={14} />
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {!locked && !mine.isPending && list.length > 0 && <AddProblems newProblem={newProblem} available={available} onPick={pick} />}

      {!locked && dirty && (
        <div className="panel sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm text-muted">You have unsaved changes to the problem list.</p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setChosen(null)} disabled={save.isPending}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(list)}>
              {save.isPending ? "Saving…" : "Save problems"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The three ways to add a problem: write one, import one, or use one you have.
 * Large as the empty state, a compact toolbar under a list.
 */
function AddProblems({
  big = false,
  newProblem,
  available,
  onPick,
}: {
  big?: boolean;
  newProblem: string;
  available: { id: string; title: string; sample_count: number; hidden_count: number }[];
  onPick: (id: string) => void;
}) {
  const picker = (
    <select id="add-problem" className={`input text-sm ${big ? "" : "min-h-[36px] w-auto"}`} aria-label="Add a problem" value="" onChange={(e) => onPick(e.target.value)}>
      <option value="">{available.length ? "Pick one of your problems…" : "No other problems of yours"}</option>
      {available.map((p) => (
        <option key={p.id} value={p.id}>
          {p.title} ({p.sample_count + p.hidden_count} tests)
        </option>
      ))}
    </select>
  );
  if (!big) {
    return (
      <div className="card flex flex-wrap items-center gap-2 p-3" aria-label="Add a problem to the contest">
        <span className="px-2 text-sm font-medium text-muted">Add another</span>
        <Link to={newProblem} className="btn btn-outline min-h-[36px] px-3 text-sm">
          <Plus size={14} aria-hidden="true" /> Write
        </Link>
        <Link to={`${newProblem}&import=1`} className="btn btn-outline min-h-[36px] px-3 text-sm">
          <DownloadCloud size={14} aria-hidden="true" /> Import
        </Link>
        <div className="min-w-[14rem] flex-1">{picker}</div>
      </div>
    );
  }
  const option = "group flex flex-col rounded-2xl border border-line bg-surface p-5 text-left transition-[border-color,box-shadow] hover:border-accent/40 hover:shadow-panel";
  return (
    <div className="dots rounded-2xl border border-dashed border-line-strong/70 bg-paper/40 p-5 sm:p-8" aria-label="Add a problem to the contest">
      <div className="mx-auto max-w-md text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
          <ListChecks size={22} aria-hidden="true" />
        </span>
        <p className="mt-3 font-display text-lg font-semibold text-ink">Add your first problem</p>
        <p className="mt-1 text-sm text-muted">Problems become A, B, C… in the order you add them. You can reorder them later.</p>
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <Link to={newProblem} className={option}>
          <span className="icon-tile">
            <Plus size={18} aria-hidden="true" />
          </span>
          <span className="mt-4 font-semibold text-ink">Write a new problem</span>
          <span className="mt-1 text-sm text-muted">From scratch. You come back here when it's created.</span>
          <span className="mt-4 text-sm font-medium text-accent">Start writing →</span>
        </Link>
        <Link to={`${newProblem}&import=1`} className={option}>
          <span className="icon-tile">
            <DownloadCloud size={18} aria-hidden="true" />
          </span>
          <span className="mt-4 font-semibold text-ink">Import from Codeforces / AtCoder</span>
          <span className="mt-1 text-sm text-muted">Paste a link; the statement, limits and samples are filled in.</span>
          <span className="mt-4 text-sm font-medium text-accent">Paste a link →</span>
        </Link>
        <div className={`${option} hover:shadow-none`}>
          <span className="icon-tile">
            <FolderOpen size={18} aria-hidden="true" />
          </span>
          <label htmlFor="add-problem" className="mt-4 font-semibold text-ink">
            Use one of yours
          </label>
          <span className="mt-1 text-sm text-muted">A problem you've already written in your studio.</span>
          <div className="mt-4">{picker}</div>
        </div>
      </div>
    </div>
  );
}

function defaultPoints(format: ContestFormat, index: number) {
  return format === "CODEFORCES" ? 500 * (index + 1) : format === "ATCODER" ? 100 * (index + 1) : format === "IOI" ? 100 : 1;
}

// ---- editorial ------------------------------------------------------------------

/** Write-ups only authors see until the end; then everyone, here and on each practice problem. */
function EditorialPanel({ d }: { d: ContestDetail }) {
  const c = d.contest;
  const qc = useQueryClient();
  const { bySlug } = useMyProblems();
  const current = useQuery({ queryKey: ["contest-editorial", c.slug], queryFn: () => contestsApi.editorial(c.slug) });
  const [intro, setIntro] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!current.data || intro !== null) return;
    setIntro(current.data.intro);
    setTexts(Object.fromEntries(current.data.problems.map((p) => [p.label, p.editorial])));
  }, [current.data, intro]);
  const save = useMutation({
    mutationFn: () => contestsApi.saveEditorial(c.slug, { intro: intro ?? "", problems: texts }),
    onSuccess: (next) => {
      qc.setQueryData(["contest-editorial", c.slug], next);
      void qc.invalidateQueries({ queryKey: ["contest", c.slug] });
      setSaved(true);
      setError(null);
    },
    onError: (e) => setError(message(e)),
  });
  const setText = (label: string, text: string) => {
    setSaved(false);
    setTexts((t) => ({ ...t, [label]: text }));
  };
  return (
    <section id="editorial" className="space-y-4" aria-labelledby="editorial-h">
      <div className="card p-5 sm:p-6">
        <PanelHead
          icon={BookOpen}
          id="editorial-h"
          title="Editorial"
          right={
            <Link to={`/contests/${c.slug}/editorial`} className="btn btn-ghost min-h-[36px] px-3 text-xs">
              <Eye size={14} aria-hidden="true" /> See it as contestants will
            </Link>
          }
        >
          Explain the intended solutions. Only authors can read it until the contest ends; then it appears on the contest
          and on each problem’s practice page. Markdown, with math and code blocks.
        </PanelHead>
        {error && <Notice tone="bad">{error}</Notice>}
        {saved && !error && <Notice tone="good">Editorial saved.</Notice>}
        {current.isPending || intro === null ? (
          <Spinner label="Loading the editorial…" />
        ) : (
          <div className="mt-4">
            <label htmlFor="editorial-intro" className="label">
              Introduction
            </label>
            <textarea
              id="editorial-intro"
              className="input min-h-[90px] font-mono text-[13px]"
              value={intro}
              onChange={(e) => {
                setSaved(false);
                setIntro(e.target.value);
              }}
              placeholder="Thanks for taking part! A few words on the round…"
            />
          </div>
        )}
      </div>

      {intro !== null && (
        <>
          {d.problems.length === 0 && (
            <p className="rounded-2xl border border-dashed border-line-strong/70 p-6 text-center text-sm text-muted">
              Add problems to write their solutions.
            </p>
          )}
          {d.problems.map((p) => (
            <EditorialCard
              key={p.label}
              label={p.label}
              title={p.title}
              text={texts[p.label] ?? ""}
              sourceUrl={bySlug.get(p.slug)?.source_url ?? null}
              onChange={(t) => setText(p.label, t)}
            />
          ))}
          <div className="panel sticky bottom-4 z-10 flex items-center justify-between gap-3 px-4 py-3">
            <p className="text-xs text-faint">Saved for authors only until the contest ends.</p>
            <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save editorial"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** One problem's write-up, with a preview and, for an imported problem, its original editorial on demand. */
function EditorialCard({
  label,
  title,
  text,
  sourceUrl,
  onChange,
}: {
  label: string;
  title: string;
  text: string;
  sourceUrl: string | null;
  onChange: (text: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "good" | "warn" | "bad"; text: string } | null>(null);
  const id = `editorial-${label}`;

  const importIt = async () => {
    if (!sourceUrl) return;
    if (text.trim() && !window.confirm("Replace what you have written for this problem with the imported editorial?")) return;
    setBusy(true);
    setNote(null);
    try {
      const e = await studioApi.importEditorial(sourceUrl);
      const credit = `*Based on the [original editorial](${e.editorial_url}).*`;
      onChange(e.text.trim() ? `${e.text.trim()}\n\n${credit}` : `${credit}\n`);
      setPreview(false);
      setNote(
        e.warnings.length
          ? { tone: "warn", text: e.warnings.join(" ") }
          : { tone: "good", text: "Imported. Rewrite it in your own words or keep the credit line, then save." },
      );
    } catch (err) {
      setNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't import the editorial." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 font-display font-semibold text-accent">
            {label}
          </span>
          <label htmlFor={id} className="truncate font-semibold text-ink">
            {label}. {title}
          </label>
        </div>
        <div className="flex items-center gap-2">
          {sourceUrl && (
            <button type="button" className="btn btn-outline min-h-[32px] px-3 text-xs" onClick={importIt} disabled={busy}>
              <DownloadCloud size={13} aria-hidden="true" />
              {busy ? "Importing…" : `Import from ${sourceName(sourceUrl)}`}
            </button>
          )}
          <div className="segmented" role="group" aria-label={`${label}: view`}>
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
        </div>
      </div>
      {note && (
        <p
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
            note.tone === "good" ? "border-good/30 bg-good/10 text-good" : note.tone === "warn" ? "border-warn/30 bg-warn/10 text-warn" : "border-bad/30 bg-bad/10 text-bad"
          }`}
        >
          {note.text}
        </p>
      )}
      {preview ? (
        <div className="md min-h-[8rem] rounded-xl border border-line bg-paper/40 p-4">
          {text.trim() ? <Markdown>{text}</Markdown> : <p className="text-faint">Nothing to preview yet.</p>}
        </div>
      ) : (
        <textarea
          id={id}
          className="input min-h-[140px] font-mono text-[13px] leading-relaxed"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder="The key observation is…"
        />
      )}
    </article>
  );
}

// ---- authors --------------------------------------------------------------------

function AuthorsPanel({ d }: { d: ContestDetail }) {
  const c = d.contest;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const owner = c.my_role === "OWNER";
  const refresh = (next?: ContestDetail) => {
    if (next) qc.setQueryData(["contest", c.slug], next);
    else void qc.invalidateQueries({ queryKey: ["contest", c.slug] });
  };
  const add = useMutation({
    mutationFn: () => contestsApi.addAuthor(c.slug, username.trim()),
    onSuccess: (next) => {
      setUsername("");
      setError(null);
      refresh(next);
    },
    onError: (e) => setError(message(e)),
  });
  const remove = useMutation({
    mutationFn: (name: string) => contestsApi.removeAuthor(c.slug, name),
    onSuccess: (_, name) => {
      if (name === user?.username) navigate("/host");
      else refresh();
    },
    onError: (e) => setError(message(e)),
  });
  return (
    <section className="card p-5 sm:p-6" aria-labelledby="authors-h">
      <PanelHead icon={Users} id="authors-h" title="Authors">
        Co-authors can edit the contest and its problems, and see them before the start. They cannot compete in it.
      </PanelHead>
      {error && (
        <div className="mt-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      <ul className="divide-y divide-line/70 rounded-xl border border-line">
        {c.authors.map((a, i) => (
          <li key={a} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2.5">
              <Avatar username={a} size={28} />
              <UserLink username={a} />
              {i === 0 && <span className="chip">owner</span>}
            </span>
            {i > 0 && (owner || a === user?.username) && (
              <button type="button" className="btn-ghost min-h-[30px] px-2 text-xs" onClick={() => remove.mutate(a)} disabled={remove.isPending}>
                {a === user?.username ? "Leave" : "Remove"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) add.mutate();
          }}
        >
          <label htmlFor="author-name" className="sr-only">
            Username to add as an author
          </label>
          <input id="author-name" className="input" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <button type="submit" className="btn btn-outline shrink-0" disabled={add.isPending}>
            <UserPlus size={15} aria-hidden="true" /> Add author
          </button>
        </form>
      )}
    </section>
  );
}

// ---- publishing -----------------------------------------------------------------

function PublishPanel({ d, phase }: { d: ContestDetail; phase: string }) {
  const c = d.contest;
  const qc = useQueryClient();
  const billing = useQuery({ queryKey: ["billing-me"], queryFn: () => billingApi.me(), enabled: !c.published });
  const [error, setError] = useState<string | null>(null);
  const publish = useMutation({
    mutationFn: (on: boolean) => contestsApi.publish(c.slug, on),
    onSuccess: (next) => {
      qc.setQueryData(["contest", c.slug], next);
      void qc.invalidateQueries({ queryKey: ["contests"] });
      setError(null);
    },
    onError: (e) => setError(message(e)),
  });
  if (c.published && phase !== "UPCOMING") return null;
  // Publishing a round needs a Host plan; say so up front rather than on the click.
  const needsPlan = !c.published && billing.data !== undefined && !billing.data.can_host;
  const refused = publish.error instanceof ApiError && publish.error.code === "HOST_PLAN_REQUIRED";
  if (needsPlan || refused) {
    const lapsed = billing.data?.hosting_until != null;
    return (
      <section
        className="relative overflow-hidden rounded-2xl border border-accent/40 bg-surface p-5 shadow-panel sm:p-6"
        aria-label="Publishing"
      >
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-accent/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="icon-tile shrink-0">
              <BadgeCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <p className="font-semibold text-ink">{lapsed ? "Your Host plan has ended" : "Publishing needs a Host plan"}</p>
              <p className="mt-0.5 max-w-xl text-sm text-muted">
                Your draft is saved and stays private. A plan publishes it, and gives your contestants a priority judge
                pool for the whole round.
              </p>
            </div>
          </div>
          <Link to="/pricing" className="btn btn-primary shrink-0">
            {lapsed ? "Renew the plan" : "See Host plans"}
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section
      className={`relative overflow-hidden rounded-2xl border p-5 shadow-panel sm:p-6 ${
        c.published ? "border-good/30 bg-surface" : "border-accent/30 bg-surface"
      }`}
      aria-label="Publishing"
    >
      <div
        className={`pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full blur-3xl ${c.published ? "bg-good/15" : "bg-accent/15"}`}
        aria-hidden="true"
      />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${c.published ? "bg-good/15 text-good" : "bg-accent/10 text-accent"}`}>
            <Rocket size={18} aria-hidden="true" />
          </span>
          <div>
            <p className="font-semibold text-ink">{c.published ? "Published" : "Draft: only its authors can see it"}</p>
            <p className="text-sm text-muted">
              {c.published
                ? "Anyone can find it and register. You can take it back until it starts."
                : `Publish when every problem has hidden tests. ${c.problem_count} problem${c.problem_count === 1 ? "" : "s"} so far.`}
            </p>
          </div>
        </div>
        <button
          type="button"
          className={c.published ? "btn btn-outline" : "btn btn-primary"}
          onClick={() => publish.mutate(!c.published)}
          disabled={publish.isPending}
        >
          {c.published ? "Unpublish" : "Publish contest"}
        </button>
      </div>
      {error && (
        <div className="relative mt-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
    </section>
  );
}

function DangerZone({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const del = useMutation({
    mutationFn: () => contestsApi.remove(slug),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contests"] });
      void qc.invalidateQueries({ queryKey: ["my-contests"] });
      navigate("/host");
    },
  });
  return (
    <section className="card flex flex-wrap items-center justify-between gap-3 border-bad/30 p-5" aria-label="Delete contest">
      <div>
        <p className="font-medium text-ink">Delete this contest</p>
        <p className="text-sm text-muted">Its problems stay in your studio.</p>
      </div>
      {confirming ? (
        <span className="flex gap-2">
          <button type="button" className="btn btn-danger" onClick={() => del.mutate()} disabled={del.isPending}>
            <Trash2 size={15} aria-hidden="true" /> Yes, delete
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
    </section>
  );
}
