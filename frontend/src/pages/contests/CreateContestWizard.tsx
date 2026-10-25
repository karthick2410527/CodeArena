import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, BadgeCheck, Check, Clock, FileText, ListChecks, Trophy, Users } from "lucide-react";
import { billingApi, contestsApi } from "../../api/endpoints";
import type { ContestFormat } from "../../api/types";
import { FORMAT_HELP, FORMAT_LABELS, formatDuration, formatWhen } from "../../components/contest";
import { HubHero } from "../../components/ContestHub";
import { Notice } from "../../components/ui";
import { DURATIONS, FORMATS, defaultStart, message, toLocalInput } from "./contestForm";

const STEPS = [
  { key: "basics", label: "Basics", caption: "Title and description", icon: FileText },
  { key: "scoring", label: "Scoring", caption: "How people are ranked", icon: Trophy },
  { key: "schedule", label: "Schedule", caption: "Start time and length", icon: Clock },
  { key: "review", label: "Review", caption: "Check and create the draft", icon: ListChecks },
] as const;

/** Who each scoring rule suits, shown on its card. */
const FORMAT_FOR: Record<ContestFormat, string> = {
  CODEFORCES: "Fast rounds where speed matters",
  ICPC: "Team-style, solve count first",
  ATCODER: "Clean points, light penalty",
  IOI: "Olympiad-style partial credit",
};

/**
 * Hosting starts here, one decision per step, with a live preview of the
 * contest card beside it. It creates a private draft; problems, co-authors
 * and publishing follow on the manage page.
 */
export default function CreateContestWizard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState<ContestFormat>("CODEFORCES");
  const [start, setStart] = useState(toLocalInput(defaultStart()));
  const [duration, setDuration] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const billing = useQuery({ queryKey: ["billing-me"], queryFn: () => billingApi.me() });

  const startsAt = new Date(start);
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);
  const validStart = !Number.isNaN(startsAt.getTime());

  const create = useMutation({
    mutationFn: () =>
      contestsApi.create({
        title: title.trim(),
        description,
        format,
        starts_at: startsAt.toISOString(),
        duration_minutes: duration,
      }),
    onSuccess: (next) => {
      qc.setQueryData(["contest", next.contest.slug], next);
      void qc.invalidateQueries({ queryKey: ["contests"] });
      void qc.invalidateQueries({ queryKey: ["my-contests"] });
      navigate(`/contests/${next.contest.slug}/manage`, { replace: true });
    },
    onError: (e) => setError(message(e)),
  });

  /** Why the current step can't move on yet, if it can't. */
  const blocker = (i: number): string | null => {
    if (i === 0 && !title.trim()) return "Give the contest a title.";
    if (i === 2 && !validStart) return "Pick a start date and time.";
    if (i === 2 && startsAt.getTime() <= Date.now()) return "The start has to be in the future.";
    return null;
  };

  const next = () => {
    const why = blocker(step);
    setError(why);
    if (!why) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  if (billing.data && !billing.data.can_host) {
    return <NeedsPlan lapsed={billing.data.hosting_until !== null} ready={billing.data.enabled} />;
  }

  return (
    <div>
      <Link to="/contests" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft size={14} aria-hidden="true" /> Contests
      </Link>
      <HubHero
        eyebrow="Host a contest"
        title={
          <>
            Set up your <span className="text-accent-shine">round</span>
          </>
        }
        description="Four quick steps. It starts as a private draft, so nothing is public until you publish it from the manage page."
        aside={<Stepper step={step} onJump={(i) => i < step && (setError(null), setStep(i))} />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <form
          className="card overflow-hidden"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (step < STEPS.length - 1) next();
            else create.mutate();
          }}
        >
          <div key={step} className="animate-step space-y-5 p-5 sm:p-7">
            {error && <Notice tone="bad">{error}</Notice>}

            {step === 0 && (
              <>
                <StepTitle n={1} title="Name it" hint="Short and recognisable: it shows on the contests page and in the standings." />
                <div>
                  <label htmlFor="contest-title" className="label">
                    Title
                  </label>
                  <input
                    id="contest-title"
                    className="input h-12 text-base"
                    autoFocus
                    value={title}
                    maxLength={120}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Weekend Round #1"
                  />
                  <p className="mt-1 text-right text-xs text-faint">{title.length}/120</p>
                </div>
                <div>
                  <label htmlFor="contest-description" className="label">
                    Description and rules <span className="font-normal text-faint">(Markdown, optional)</span>
                  </label>
                  <textarea
                    id="contest-description"
                    className="input min-h-[140px] font-mono text-[13px]"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What the round is about, who it is for, any rules…"
                  />
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <StepTitle n={2} title="Choose the scoring" hint="It decides how the standings rank people. You can change it until the contest starts." />
                <fieldset>
                  <legend className="sr-only">Scoring</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {FORMATS.map((f) => (
                      <label
                        key={f}
                        className={`choice-card ${format === f ? "choice-card-on" : ""}`}
                      >
                        <input
                          type="radio"
                          name="format"
                          value={f}
                          checked={format === f}
                          onChange={() => setFormat(f)}
                          className="sr-only"
                          aria-label={FORMAT_LABELS[f]}
                        />
                        <span className="flex items-center justify-between">
                          <span className="font-semibold text-ink">{FORMAT_LABELS[f]}</span>
                          <span
                            className={`grid h-5 w-5 place-items-center rounded-full border transition-colors ${
                              format === f ? "border-accent bg-accent text-accent-ink" : "border-line-strong"
                            }`}
                            aria-hidden="true"
                          >
                            {format === f && <Check size={12} strokeWidth={3} />}
                          </span>
                        </span>
                        <span className="mt-1 block text-xs font-medium text-accent">{FORMAT_FOR[f]}</span>
                        <span className="mt-2 block text-sm leading-relaxed text-muted">{FORMAT_HELP[f]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </>
            )}

            {step === 2 && (
              <>
                <StepTitle n={3} title="Pick a time" hint="Registration stays open until the end, so people can join late." />
                <div>
                  <label htmlFor="contest-start" className="label">
                    Starts
                  </label>
                  <input
                    id="contest-start"
                    type="datetime-local"
                    className="input h-12"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-faint">
                    Your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
                  </p>
                </div>
                <div>
                  <span className="label" id="length-label">
                    Length
                  </span>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="length-label">
                    {DURATIONS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={duration === m}
                        onClick={() => setDuration(m)}
                        className={`pill-choice ${duration === m ? "pill-choice-on" : ""}`}
                      >
                        {formatDuration(m)}
                      </button>
                    ))}
                  </div>
                </div>
                {validStart && (
                  <div className="rounded-xl border border-line/70 bg-sunken/60 p-4 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">Opens</span>
                      <span className="font-medium text-ink">{formatWhen(startsAt.toISOString())}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-muted">Closes</span>
                      <span className="font-medium text-ink">{formatWhen(endsAt.toISOString())}</span>
                    </div>
                  </div>
                )}
              </>
            )}

            {step === 3 && (
              <>
                <StepTitle n={4} title="Check and create" hint="This creates a private draft. Next you add problems, invite co-authors and publish." />
                <dl className="divide-y divide-line/70 rounded-xl border border-line/70">
                  <ReviewRow label="Title" onEdit={() => setStep(0)}>{title.trim()}</ReviewRow>
                  <ReviewRow label="Scoring" onEdit={() => setStep(1)}>{FORMAT_LABELS[format]}</ReviewRow>
                  <ReviewRow label="Starts" onEdit={() => setStep(2)}>{formatWhen(startsAt.toISOString())}</ReviewRow>
                  <ReviewRow label="Length" onEdit={() => setStep(2)}>{formatDuration(duration)}</ReviewRow>
                </dl>
                <ol className="grid gap-2 text-sm text-muted sm:grid-cols-3">
                  {["Add problems from your studio", "Invite co-authors", "Publish to open registration"].map((t, i) => (
                    <li key={t} className="flex items-start gap-2 rounded-xl bg-sunken/60 p-3">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                        {i + 1}
                      </span>
                      {t}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line/70 bg-sunken/40 px-5 py-4 sm:px-7">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => (setError(null), setStep((s) => s - 1))}
              disabled={step === 0}
            >
              <ArrowLeft size={16} aria-hidden="true" /> Back
            </button>
            <span className="text-xs text-faint tabular">
              Step {step + 1} of {STEPS.length}
            </span>
            {step < STEPS.length - 1 ? (
              <button type="submit" className="btn btn-primary">
                Continue <ArrowRight size={16} aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create draft"}
              </button>
            )}
          </div>
        </form>

        <aside aria-label="Preview" className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div>
            <p className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.14em] text-faint">
              Live preview <span className="font-normal normal-case tracking-normal">as it will list</span>
            </p>
            <div className="card relative overflow-hidden">
              <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-accent/25 blur-2xl" aria-hidden="true" />
              <div className="relative flex gap-4 p-5">
                <div className="flex w-14 shrink-0 flex-col items-center self-start overflow-hidden rounded-xl border border-line bg-surface" aria-hidden="true">
                  <span className="w-full bg-accent py-0.5 text-center text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-accent-ink">
                    {validStart ? startsAt.toLocaleDateString(undefined, { month: "short" }) : "—"}
                  </span>
                  <span className="py-1 text-xl font-semibold text-ink">{validStart ? startsAt.getDate() : "?"}</span>
                </div>
                <div className="min-w-0">
                  <span className="chip border-dashed">Draft</span>
                  <p className="mt-2 break-words font-display text-lg font-semibold leading-snug tracking-tight text-ink">
                    {title.trim() || <span className="text-faint">Untitled contest</span>}
                  </p>
                  <p className="mt-1 text-xs text-muted">{FORMAT_LABELS[format]}</p>
                </div>
              </div>
              <div className="relative grid grid-cols-2 gap-px border-t border-line/70 bg-line/70">
                <PreviewFact icon={<Clock size={13} aria-hidden="true" />} label="Length" value={formatDuration(duration)} />
                <PreviewFact icon={<Users size={13} aria-hidden="true" />} label="Registered" value="0" />
              </div>
              <p className="relative border-t border-line/70 px-5 py-3 text-xs text-faint">
                {validStart ? (
                  <>
                    {formatWhen(startsAt.toISOString())} → {formatWhen(endsAt.toISOString())}
                  </>
                ) : (
                  "No start time yet"
                )}
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-line/70 bg-surface/60 p-5">
            <p className="text-sm font-semibold text-ink">After you create it</p>
            <ul className="mt-3 space-y-2.5 text-sm text-muted">
              {[
                [ListChecks, "Add problems from your studio and set their points"],
                [Users, "Invite co-authors to write and test with you"],
                [Trophy, "Publish: people can register right away"],
              ].map(([Icon, text]) => {
                const I = Icon as typeof Users;
                return (
                  <li key={text as string} className="flex gap-2.5">
                    <I size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                    {text as string}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Stepper({ step, onJump }: { step: number; onJump: (i: number) => void }) {
  return (
    <div className="rounded-2xl border border-line/70 bg-surface/80 p-2 backdrop-blur">
      <div className="px-3 pb-2 pt-2">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="font-medium text-ink">
            Step {step + 1} of {STEPS.length}
          </span>
          <span className="text-faint tabular">{Math.round((step / (STEPS.length - 1)) * 100)}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${(step / (STEPS.length - 1)) * 100}%` }} />
        </div>
      </div>
      <ol aria-label="Steps">
        {STEPS.map((s, i) => {
          const done = i < step;
          const on = i === step;
          const Icon = s.icon;
          return (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onJump(i)}
                disabled={!done}
                aria-current={on ? "step" : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors disabled:cursor-default ${
                  on ? "bg-accent/[0.08]" : done ? "hover:bg-sunken" : ""
                }`}
              >
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors ${
                    done ? "bg-accent text-accent-ink" : on ? "bg-accent/15 text-accent ring-4 ring-accent/10" : "bg-sunken text-faint"
                  }`}
                  aria-hidden="true"
                >
                  {done ? <Check size={13} strokeWidth={3} /> : <Icon size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium ${on || done ? "text-ink" : "text-muted"}`}>{s.label}</span>
                  <span className="block truncate text-xs text-faint">{s.caption}</span>
                </span>
                {done && <span className="text-xs font-medium text-accent">Edit</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepTitle({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-accent">Step {n}</p>
      <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-1 text-sm text-muted">{hint}</p>
    </div>
  );
}

function ReviewRow({ label, children, onEdit }: { label: string; children: ReactNode; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <dt className="w-20 shrink-0 text-sm text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{children}</dd>
      <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}

function PreviewFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="bg-surface px-5 py-3">
      <p className="flex items-center gap-1 text-xs text-faint">
        {icon} {label}
      </p>
      <p className="mt-0.5 font-semibold text-ink">{value}</p>
    </div>
  );
}

/** In place of the wizard for someone without an active Host plan. */
function NeedsPlan({ lapsed, ready }: { lapsed: boolean; ready: boolean }) {
  return (
    <div>
      <Link to="/contests" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft size={14} aria-hidden="true" /> Contests
      </Link>
      <HubHero
        eyebrow="Host a contest"
        title={lapsed ? "Renew to host again" : <>Hosting starts with a <span className="text-accent-shine">Host plan</span></>}
        description={
          ready
            ? "A live round gets its own priority judge pool, so hosting is part of a paid plan. Practising and competing stay free."
            : "Hosting needs a Host plan, and payments aren't switched on for this site yet. Check back soon."
        }
        actions={
          <>
            <Link to="/pricing" className="btn btn-primary min-h-[44px] px-5">
              <BadgeCheck size={16} aria-hidden="true" /> {lapsed ? "Renew the plan" : "See Host plans"}
            </Link>
            <Link to="/studio/problems" className="btn btn-outline min-h-[44px] px-5">
              Write problems meanwhile
            </Link>
          </>
        }
        aside={
          <ul className="space-y-3 rounded-2xl border border-line/70 bg-surface/80 p-5 text-sm text-muted backdrop-blur">
            {[
              "Publish unlimited contests, any scoring rule",
              "Priority judging for your contestants",
              "Live standings, co-authors and editorials",
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" /> {t}
              </li>
            ))}
            <li className="border-t border-line/70 pt-3 font-medium text-ink">From ₹499 a month</li>
          </ul>
        }
      />
    </div>
  );
}
