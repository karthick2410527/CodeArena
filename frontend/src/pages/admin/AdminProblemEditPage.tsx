import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, Circle, DownloadCloud, Plus } from "lucide-react";
import { useHosting } from "../../components/hosting";
import Markdown, { sourceName } from "../../components/Markdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { authoring, type AuthoringScope } from "./authoring";
import type { AdminTestCase, Difficulty, ImportedProblem, ProblemInput } from "../../api/types";
import ConfirmDialog from "../../components/ConfirmDialog";
import { ErrorState, Spinner } from "../../components/Feedback";
import { Field, FormError } from "../AuthForm";

const DIFFICULTIES: Difficulty[] = ["EASY", "MEDIUM", "HARD"];

type Draft = {
  slug: string;
  title: string;
  description: string;
  constraints: string;
  difficulty: Difficulty;
  time_limit_ms: string;
  memory_limit_mb: string;
  tags: string;
  source_url: string;
};

const BLANK: Draft = {
  slug: "",
  title: "",
  description: "",
  constraints: "",
  difficulty: "EASY",
  time_limit_ms: "1000",
  memory_limit_mb: "256",
  tags: "",
  source_url: "",
};

type Errors = Partial<Record<keyof Draft, string>>;

/**
 * Client-side validation mirrors the server's rules so a mistake is caught
 * before a round trip. The server validates again regardless — this is a
 * convenience, never the enforcement point.
 */
function validate(d: Draft): Errors {
  const e: Errors = {};
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.slug.trim())) {
    e.slug = "Lowercase letters, digits and single hyphens, e.g. two-sum";
  }
  if (!d.title.trim()) e.title = "A title is required";
  if (d.title.length > 200) e.title = "At most 200 characters";
  if (!d.description.trim()) e.description = "A statement is required";
  const time = Number(d.time_limit_ms);
  if (!Number.isInteger(time) || time < 100 || time > 10000) {
    e.time_limit_ms = "Between 100 and 10000 ms";
  }
  const memory = Number(d.memory_limit_mb);
  if (!Number.isInteger(memory) || memory < 16 || memory > 512) {
    e.memory_limit_mb = "Between 16 and 512 MB";
  }
  const tags = parseTags(d.tags);
  if (tags.length > 10) e.tags = "At most 10 tags";
  if (tags.some((t) => !/^[a-z0-9-]{1,40}$/.test(t))) {
    e.tags = "Lowercase letters, digits and hyphens, comma separated";
  }
  return e;
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function toPayload(d: Draft): ProblemInput {
  return {
    slug: d.slug.trim(),
    title: d.title.trim(),
    description: d.description,
    constraints: d.constraints,
    difficulty: d.difficulty,
    time_limit_ms: Number(d.time_limit_ms),
    memory_limit_mb: Number(d.memory_limit_mb),
    tags: parseTags(d.tags),
    // An empty string clears a source the author removed.
    source_url: d.source_url.trim(),
  };
}

/** "Two Sum!" -> "two-sum", as a slug suggestion while the author hasn't typed one. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

type SampleDraft = { input: string; output: string };

export default function AdminProblemEditPage({
  scope = "admin",
}: {
  scope?: AuthoringScope;
}) {
  const { id } = useParams();
  const { api, base } = authoring(scope);
  const host = useHosting();
  const creating = !id || id === "new";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  // Opened from a contest's manage page: the new problem goes back there.
  const forContest = params.get("contest");

  const existing = useQuery({
    queryKey: ["admin-problem", id],
    queryFn: ({ signal }) => api.getProblem(id!, signal),
    enabled: !creating,
  });

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [slugTouched, setSlugTouched] = useState(!creating);
  const [samples, setSamples] = useState<SampleDraft[]>([]);
  const [imported, setImported] = useState<ImportedProblem | null>(null);

  useEffect(() => {
    const p = existing.data;
    if (!p) return;
    setDraft({
      slug: p.slug,
      title: p.title,
      description: p.description,
      constraints: p.constraints,
      difficulty: p.difficulty,
      time_limit_ms: String(p.time_limit_ms),
      memory_limit_mb: String(p.memory_limit_mb),
      tags: p.tags.join(", "),
      source_url: p.source_url ?? "",
    });
  }, [existing.data]);

  const save = useMutation({
    mutationFn: async (payload: ProblemInput) => {
      if (!creating) return api.updateProblem(id!, payload);
      const problem = await api.createProblem(payload);
      // Samples typed (or imported) before the problem existed become its public samples.
      for (const s of samples) {
        if (!s.output.trim()) continue;
        await api.createTestCase(problem.id, {
          input: s.input,
          expected_output: s.output,
          explanation: null,
          is_sample: true,
          points: 0,
        });
      }
      return problem;
    },
    onSuccess: (problem) => {
      setFormError(null);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["admin-problems"] });
      queryClient.invalidateQueries({
        queryKey: ["admin-problem", problem.id],
      });
      // Public views change too once a problem is edited or published.
      queryClient.invalidateQueries({ queryKey: ["problems"] });
      queryClient.invalidateQueries({ queryKey: ["problem", problem.slug] });
      if (creating) {
        navigate(
          forContest
            ? `/contests/${encodeURIComponent(forContest)}/manage?add=${problem.id}`
            : `${base}/${problem.id}`,
          { replace: true },
        );
      }
    },
    onError: (err) =>
      setFormError(
        err instanceof ApiError
          ? err.message
          : "Could not save. Please try again.",
      ),
  });

  const togglePublished = useMutation({
    mutationFn: (published: boolean) => api.updateProblem(id!, { published }),
    onSuccess: () => {
      setFormError(null);
      existing.refetch();
      queryClient.invalidateQueries({ queryKey: ["admin-problems"] });
      queryClient.invalidateQueries({ queryKey: ["problems"] });
    },
    onError: (err) =>
      setFormError(
        err instanceof ApiError
          ? err.message
          : "Could not change the publication state.",
      ),
  });

  if (!creating && existing.isPending)
    return <Spinner label="Loading problem…" />;
  if (!creating && existing.isError) {
    return (
      <ErrorState
        title="Couldn't load this problem"
        message={existing.error.message}
        onRetry={() => existing.refetch()}
      />
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const found = validate(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError("Please correct the highlighted fields.");
      return;
    }
    setFormError(null);
    save.mutate(toPayload(draft));
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setTitle = (title: string) =>
    setDraft((d) => ({ ...d, title, slug: slugTouched ? d.slug : slugify(title) }));

  const applyImport = (p: ImportedProblem) => {
    setImported(p);
    setDraft({
      slug: slugTouched && draft.slug ? draft.slug : p.slug,
      title: p.title,
      description: p.description,
      constraints: p.constraints,
      difficulty: p.difficulty,
      time_limit_ms: String(p.time_limit_ms),
      memory_limit_mb: String(p.memory_limit_mb),
      tags: p.tags.join(", "),
      source_url: p.source_url,
    });
    setSamples(p.samples.map((s) => ({ input: s.input, output: s.output })));
    setErrors({});
  };

  const p = existing.data;
  const sampleCount = creating ? samples.filter((s) => s.output.trim()).length : (p?.sample_count ?? 0);
  const checks: [string, boolean, string][] = [
    ["Title and slug", Boolean(draft.title.trim() && draft.slug.trim()), "Shown in lists and the URL"],
    ["Statement", Boolean(draft.description.trim()), "What to solve, input and output"],
    ["Public samples", sampleCount > 0, sampleCount > 0 ? `${sampleCount} sample${sampleCount === 1 ? "" : "s"}` : "Show solvers the format"],
    [
      "Hidden tests",
      (p?.hidden_count ?? 0) > 0,
      creating ? "Added after you create it" : `${p?.hidden_count ?? 0} hidden test${p?.hidden_count === 1 ? "" : "s"}`,
    ],
  ];
  const done = checks.filter(([, ok]) => ok).length;

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        to={forContest ? `/contests/${encodeURIComponent(forContest)}/manage` : base}
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        {forContest ? "Back to the contest" : scope === "studio" ? "My problems" : "All problems"}
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1.5">
            {scope === "studio" ? "Studio" : "Admin"}
            {forContest && " · for a contest"}
          </p>
          <h1 className="font-display text-[2rem] font-semibold leading-tight tracking-tight text-ink sm:text-[2.25rem]">
            {creating ? "New problem" : p?.title}
          </h1>
          {p ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className={`chip ${p.published ? "border-good/30 bg-good/10 text-good" : ""}`}>
                {p.published ? "Published" : "Draft"}
              </span>
              <span className="chip">{p.sample_count} sample{p.sample_count === 1 ? "" : "s"}</span>
              <span className="chip">{p.hidden_count} hidden test{p.hidden_count === 1 ? "" : "s"}</span>
              <span className="chip">{p.submission_count} submission{p.submission_count === 1 ? "" : "s"}</span>
              {p.contests.length > 0 && (
                <span className="chip">
                  in {p.contests.length} contest{p.contests.length === 1 ? "" : "s"}
                </span>
              )}
              {p.source_url && (
                <a href={p.source_url} target="_blank" rel="noopener noreferrer" className="chip hover:text-ink">
                  From {sourceName(p.source_url)} ↗
                </a>
              )}
            </div>
          ) : (
            <p className="mt-1.5 text-[0.9375rem] text-muted">
              Write it from scratch, or import one from Codeforces or AtCoder and make it yours.
            </p>
          )}
        </div>
        {p && (scope === "admin" || p.published) && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => togglePublished.mutate(!p.published)}
            disabled={togglePublished.isPending}
          >
            {p.published ? "Unpublish" : "Publish"}
          </button>
        )}
      </header>

      {p && !p.published && scope === "admin" && (
        <p className="mt-4 rounded-xl border border-line bg-surface/60 p-3 text-sm text-muted">
          Drafts are invisible to users. Publishing needs at least one hidden
          test case, so the problem can actually be judged.
        </p>
      )}
      {p && !p.published && scope === "studio" && (
        <p className="mt-4 rounded-xl border border-accent/25 bg-accent/[0.06] p-3 text-sm text-muted">
          <span className="font-medium text-ink">Problems go public through contests.</span>{" "}
          Add this one to a contest you host. Contestants see it during the round,
          and it joins the practice problemset when the contest ends.{" "}
          <Link to={host.to} className="font-medium text-accent hover:underline">
            {host.label}
          </Link>
        </p>
      )}

      {creating && (
        <ImportCard
          importProblem={api.importProblem}
          imported={imported}
          onImported={applyImport}
          autoFocus={params.get("import") === "1"}
        />
      )}

      <form onSubmit={onSubmit} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]" noValidate>
        <div className="min-w-0 space-y-5">
          <FormError message={formError} />
          {saved && !formError && (
            <p
              role="status"
              className="rounded-xl border border-good/30 bg-good/10 px-3 py-2 text-sm text-good"
            >
              Saved.
            </p>
          )}

          <EditorSection n={1} id="basics-h" title="Basics" hint="How the problem is listed and how much time and memory solutions get.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="title"
                label="Title"
                value={draft.title}
                error={errors.title}
                placeholder="Two Sum"
                onChange={(e) => setTitle(e.target.value)}
              />
              <Field
                id="slug"
                label="Slug (URL)"
                value={draft.slug}
                error={errors.slug}
                placeholder="two-sum"
                onChange={(e) => {
                  setSlugTouched(true);
                  set("slug", e.target.value);
                }}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="difficulty" className="label">
                  Difficulty
                </label>
                <select
                  id="difficulty"
                  className="input"
                  value={draft.difficulty}
                  onChange={(e) => set("difficulty", e.target.value as Difficulty)}
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {d[0] + d.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                id="time_limit_ms"
                label="Time limit (ms)"
                type="number"
                value={draft.time_limit_ms}
                error={errors.time_limit_ms}
                onChange={(e) => set("time_limit_ms", e.target.value)}
              />
              <Field
                id="memory_limit_mb"
                label="Memory limit (MB)"
                type="number"
                value={draft.memory_limit_mb}
                error={errors.memory_limit_mb}
                onChange={(e) => set("memory_limit_mb", e.target.value)}
              />
            </div>
            <Field
              id="tags"
              label="Tags (comma separated)"
              value={draft.tags}
              error={errors.tags}
              placeholder="arrays, two-pointers"
              onChange={(e) => set("tags", e.target.value)}
            />
          </EditorSection>

          <EditorSection n={2} id="statement-h" title="Statement" hint="The story, then the input and output formats. Markdown, with $math$ in TeX.">
            <TextArea
              id="description"
              label="Statement (Markdown)"
              rows={16}
              value={draft.description}
              error={errors.description}
              placeholder={"Given $n$ integers, find…\n\n## Input\n\nThe first line contains $n$ ($1 \\le n \\le 2 \\cdot 10^5$).\n\n## Output\n\nPrint one integer."}
              onChange={(v) => set("description", v)}
            />
          </EditorSection>

          <EditorSection n={3} id="constraints-h" title="Constraints" hint="Bounds on the input, shown under the statement. Optional when they are in the input section.">
            <TextArea
              id="constraints"
              label="Constraints (Markdown)"
              rows={5}
              value={draft.constraints}
              placeholder={"- $1 \\le n \\le 2 \\cdot 10^5$\n- $|a_i| \\le 10^9$"}
              onChange={(v) => set("constraints", v)}
            />
          </EditorSection>

          {creating && (
            <EditorSection n={4} id="samples-h" title="Samples" hint="Shown on the problem page. Hidden tests, which decide the verdict, are added after you create it.">
              <SamplesEditor samples={samples} onChange={setSamples} />
            </EditorSection>
          )}

          <div className="panel sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="text-xs text-faint">
              {creating
                ? samples.length > 0
                  ? `Creates the problem with ${samples.length} sample${samples.length === 1 ? "" : "s"}.`
                  : "Statements and constraints are Markdown: use Preview to check them."
                : "Statements and constraints are Markdown: use Preview to check them."}
            </p>
            <div className="flex gap-2">
              <Link to={forContest ? `/contests/${encodeURIComponent(forContest)}/manage` : base} className="btn btn-ghost">
                Cancel
              </Link>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? "Saving…" : creating ? "Create problem" : "Save changes"}
              </button>
            </div>
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Problem checklist">
          <div className="card p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-ink">Ready to judge</span>
              <span className="tabular text-faint">
                {done} of {checks.length}
              </span>
            </div>
            <div className="progress-track mt-2">
              <div className="progress-fill" style={{ width: `${(done / checks.length) * 100}%` }} />
            </div>
            <ul className="mt-4 space-y-3">
              {checks.map(([label, ok, hint]) => (
                <li key={label} className="flex gap-2.5">
                  {ok ? (
                    <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-good/15 text-good">
                      <Check size={10} strokeWidth={3} aria-hidden="true" />
                    </span>
                  ) : (
                    <Circle size={16} className="mt-0.5 shrink-0 text-line-strong" aria-hidden="true" />
                  )}
                  <span>
                    <span className={`block text-sm ${ok ? "text-muted" : "font-medium text-ink"}`}>{label}</span>
                    <span className="block text-xs text-faint">{hint}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card p-5">
            <label htmlFor="source_url" className="label">
              Source link <span className="font-normal text-faint">(optional)</span>
            </label>
            <input
              id="source_url"
              type="url"
              className="input"
              value={draft.source_url}
              placeholder="https://codeforces.com/…"
              onChange={(e) => set("source_url", e.target.value)}
            />
            <p className="mt-1.5 text-xs text-faint">Credits the original problem on its page.</p>
          </div>
          <div className="rounded-2xl border border-line/70 bg-surface/50 p-5 text-xs leading-relaxed text-muted">
            <p className="mb-2 text-sm font-semibold text-ink">Markdown cheatsheet</p>
            <p>
              <code className="text-ink">$n \le 10^5$</code> inline math
            </p>
            <p>
              <code className="text-ink">$$\sum a_i$$</code> on its own line
            </p>
            <p>
              <code className="text-ink">## Input</code> a section heading
            </p>
            <p>
              <code className="text-ink">**bold**</code>, <code className="text-ink">`code`</code>, <code className="text-ink">- list</code>
            </p>
          </div>
        </aside>
      </form>

      {!creating && id && <TestCaseEditor scope={scope} problemId={id} />}
    </div>
  );
}

function EditorSection({ n, id, title, hint, children }: { n: number; id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="card p-5 sm:p-6" aria-labelledby={id}>
      <div className="mb-5 flex gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 font-mono text-xs font-semibold text-accent" aria-hidden="true">
          {n}
        </span>
        <div>
          <h2 id={id} className="text-base font-semibold text-ink">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{hint}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** Paste a Codeforces or AtCoder link; the editor below is filled in to review and change. */
function ImportCard({
  importProblem,
  imported,
  onImported,
  autoFocus = false,
}: {
  importProblem: (url: string) => Promise<ImportedProblem>;
  imported: ImportedProblem | null;
  onImported: (p: ImportedProblem) => void;
  autoFocus?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);
    setBusy(true);
    try {
      onImported(await importProblem(url.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't import that link.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="relative mt-6 overflow-hidden rounded-2xl border border-accent/30 bg-surface p-5 shadow-panel sm:p-6"
      aria-labelledby="import-h"
    >
      <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/20 blur-3xl" aria-hidden="true" />
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center">
        <div className="flex gap-3 lg:w-[22rem] lg:shrink-0">
          <span className="icon-tile shrink-0">
            <DownloadCloud size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id="import-h" className="font-semibold text-ink">
              Import from Codeforces or AtCoder
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Fills in the title, limits, statement, constraints, samples and tags for you to edit.
            </p>
          </div>
        </div>
        <form onSubmit={run} className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
          <label htmlFor="import-url" className="sr-only">
            Problem link
          </label>
          <input
            id="import-url"
            type="url"
            className="input h-11 flex-1"
            placeholder="https://codeforces.com/problemset/problem/4/A"
            autoFocus={autoFocus}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className="btn btn-primary h-11 shrink-0" disabled={busy || !url.trim()}>
            {busy ? "Importing…" : "Import"}
          </button>
        </form>
      </div>

      {error && <p className="relative mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
      {imported && !error && (
        <div className="relative mt-4 space-y-2">
          <p role="status" className="flex flex-wrap items-center gap-1.5 rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-sm text-good">
            <Check size={15} aria-hidden="true" /> Imported “{imported.title}” from{" "}
            <a href={imported.source_url} target="_blank" rel="noopener noreferrer" className="font-medium underline">
              {sourceName(imported.source_url)}
            </a>
            . Review it below.
          </p>
          {imported.warnings.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
              {imported.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-faint">
            The statement belongs to its original authors. Rewrite it in your own words, or have their permission,
            before your contest goes public; the source link stays as credit.
          </p>
        </div>
      )}
    </section>
  );
}

function SamplesEditor({ samples, onChange }: { samples: SampleDraft[]; onChange: (s: SampleDraft[]) => void }) {
  const update = (i: number, next: Partial<SampleDraft>) => onChange(samples.map((s, j) => (j === i ? { ...s, ...next } : s)));
  return (
    <div className="space-y-3">
      {samples.length === 0 && <p className="rounded-xl border border-dashed border-line-strong/70 p-4 text-sm text-muted">No samples yet.</p>}
      {samples.map((s, i) => (
        <div key={i} className="rounded-xl border border-line/80 bg-paper/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-xs font-semibold text-faint">Sample {i + 1}</span>
            <button type="button" className="text-xs text-bad hover:underline" onClick={() => onChange(samples.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`sample-${i}-in`} className="mb-1 block text-xs text-muted">
                Sample {i + 1} input
              </label>
              <textarea id={`sample-${i}-in`} rows={3} className="input font-mono text-sm" value={s.input} onChange={(e) => update(i, { input: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`sample-${i}-out`} className="mb-1 block text-xs text-muted">
                Sample {i + 1} output
              </label>
              <textarea id={`sample-${i}-out`} rows={3} className="input font-mono text-sm" value={s.output} onChange={(e) => update(i, { output: e.target.value })} />
            </div>
          </div>
        </div>
      ))}
      <button type="button" className="btn btn-outline min-h-[36px] px-3 text-sm" onClick={() => onChange([...samples, { input: "", output: "" }])}>
        <Plus size={15} aria-hidden="true" /> Add a sample
      </button>
    </div>
  );
}

/** A Markdown field with Write / Preview tabs, so authors see the statement as solvers will. */
function TextArea({
  id,
  label,
  rows,
  value,
  error,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  rows: number;
  value: string;
  error?: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        <div className="segmented" role="group" aria-label={`${label}: view`}>
          <button
            type="button"
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Write
          </button>
          <button
            type="button"
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
        </div>
      </div>
      {preview ? (
        <div className="md min-h-[8rem] rounded-xl border border-line bg-paper/40 p-4">
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-faint">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <textarea
          id={id}
          rows={rows}
          className="input font-mono text-[13px] leading-relaxed"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && (
        <p id={`${id}-err`} className="mt-1 text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------- test cases

function TestCaseEditor({
  problemId,
  scope,
}: {
  problemId: string;
  scope: AuthoringScope;
}) {
  const { api } = authoring(scope);
  const queryClient = useQueryClient();
  const cases = useQuery({
    queryKey: ["admin-test-cases", problemId],
    queryFn: ({ signal }) => api.listTestCases(problemId, signal),
  });

  const [input, setInput] = useState("");
  const [expected, setExpected] = useState("");
  const [explanation, setExplanation] = useState("");
  const [isSample, setIsSample] = useState(false);
  const [points, setPoints] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminTestCase | null>(
    null,
  );

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: ["admin-test-cases", problemId],
    });
    queryClient.invalidateQueries({ queryKey: ["admin-problem", problemId] });
    queryClient.invalidateQueries({ queryKey: ["admin-problems"] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.createTestCase(problemId, {
        input,
        expected_output: expected,
        explanation: explanation.trim() || null,
        is_sample: isSample,
        points: Number(points),
      }),
    onSuccess: () => {
      setInput("");
      setExpected("");
      setExplanation("");
      setError(null);
      refresh();
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : "Could not add the test case.",
      ),
  });

  const remove = useMutation({
    mutationFn: (caseId: string) => api.deleteTestCase(caseId),
    onSuccess: () => {
      setPendingDelete(null);
      setError(null);
      refresh();
    },
    onError: (err) => {
      setPendingDelete(null);
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not delete the test case.",
      );
    },
  });

  return (
    <section id="tests" className="card mt-10 scroll-mt-24 p-5 sm:p-6" aria-labelledby="tests-h">
      <div className="flex gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 font-mono text-xs font-semibold text-accent" aria-hidden="true">
          4
        </span>
        <div>
          <h2 id="tests-h" className="text-base font-semibold text-ink">Test cases</h2>
          <p className="mt-0.5 text-sm text-muted">
            Samples are shown publicly on the problem page. Hidden cases are used
            only by the judge and are never returned by a public endpoint.
          </p>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad"
        >
          {error}
        </p>
      )}

      {cases.isPending ? (
        <Spinner label="Loading test cases…" />
      ) : cases.isError ? (
        <ErrorState
          title="Couldn't load the test cases"
          message={cases.error.message}
          onRetry={() => cases.refetch()}
        />
      ) : (
        <div className="mt-4 space-y-3">
          {cases.data.length === 0 && (
            <p className="card p-4 text-sm text-muted">No test cases yet.</p>
          )}
          {cases.data.map((c) => (
            <div key={c.id} className="card p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-faint">
                    #{c.position}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
                      c.is_sample
                        ? "bg-accent/10 text-accent ring-accent/30"
                        : "bg-sunken text-muted ring-line-strong/30"
                    }`}
                  >
                    {c.is_sample ? "Public sample" : "Hidden"}
                  </span>
                  <span className="text-xs text-faint">
                    {c.points} point(s)
                  </span>
                </div>
                <button
                  type="button"
                  className="text-xs text-bad hover:underline"
                  onClick={() => setPendingDelete(c)}
                >
                  Delete
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ReadOnlyBlock label="Input" text={c.input} />
                <ReadOnlyBlock
                  label="Expected output"
                  text={c.expected_output}
                />
              </div>
              {c.explanation && (
                <p className="mt-2 text-xs text-muted">{c.explanation}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <form
        className="mt-6 space-y-4 rounded-xl border border-dashed border-line-strong/70 bg-paper/40 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!expected.trim()) {
            setError("Expected output must not be empty.");
            return;
          }
          create.mutate();
        }}
      >
        <h3 className="text-sm font-semibold text-ink">Add a test case</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="tc-input" className="mb-1 block text-xs text-muted">
              Input
            </label>
            <textarea
              id="tc-input"
              rows={4}
              className="input font-mono text-sm"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="tc-expected"
              className="mb-1 block text-xs text-muted"
            >
              Expected output
            </label>
            <textarea
              id="tc-expected"
              rows={4}
              className="input font-mono text-sm"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </div>
        </div>
        <div className="grid items-end gap-4 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={isSample}
              onChange={(e) => {
                setIsSample(e.target.checked);
                // Samples illustrate; they do not score.
                setPoints(e.target.checked ? "0" : "1");
              }}
            />
            Public sample
          </label>
          <div>
            <label
              htmlFor="tc-points"
              className="mb-1 block text-xs text-muted"
            >
              Points
            </label>
            <input
              id="tc-points"
              type="number"
              className="input"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="tc-explanation"
              className="mb-1 block text-xs text-muted"
            >
              Explanation (samples only)
            </label>
            <input
              id="tc-explanation"
              className="input"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            />
          </div>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={create.isPending}
        >
          {create.isPending ? "Adding…" : "Add test case"}
        </button>
      </form>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this test case?"
        message={
          pendingDelete
            ? `Test #${pendingDelete.position} (${
                pendingDelete.is_sample ? "public sample" : "hidden"
              }) will be removed permanently. Submissions already judged keep their verdicts.`
            : ""
        }
        busy={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </section>
  );
}

function ReadOnlyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-faint">{label}</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface p-2 font-mono text-xs text-ink">
        {text}
      </pre>
    </div>
  );
}
