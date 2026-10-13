import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { adminApi } from "../../api/endpoints";
import type { AdminTestCase, Difficulty, ProblemInput } from "../../api/types";
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
  };
}

export default function AdminProblemEditPage() {
  const { id } = useParams();
  const creating = !id || id === "new";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const existing = useQuery({
    queryKey: ["admin-problem", id],
    queryFn: ({ signal }) => adminApi.getProblem(id!, signal),
    enabled: !creating,
  });

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
    });
  }, [existing.data]);

  const save = useMutation({
    mutationFn: (payload: ProblemInput) =>
      creating
        ? adminApi.createProblem(payload)
        : adminApi.updateProblem(id!, payload),
    onSuccess: (problem) => {
      setFormError(null);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["admin-problems"] });
      queryClient.invalidateQueries({ queryKey: ["admin-problem", problem.id] });
      // Public views change too once a problem is edited or published.
      queryClient.invalidateQueries({ queryKey: ["problems"] });
      queryClient.invalidateQueries({ queryKey: ["problem", problem.slug] });
      if (creating) navigate(`/admin/problems/${problem.id}`, { replace: true });
    },
    onError: (err) =>
      setFormError(
        err instanceof ApiError ? err.message : "Could not save. Please try again.",
      ),
  });

  const togglePublished = useMutation({
    mutationFn: (published: boolean) => adminApi.updateProblem(id!, { published }),
    onSuccess: () => {
      setFormError(null);
      existing.refetch();
      queryClient.invalidateQueries({ queryKey: ["admin-problems"] });
      queryClient.invalidateQueries({ queryKey: ["problems"] });
    },
    onError: (err) =>
      setFormError(
        err instanceof ApiError ? err.message : "Could not change the publication state.",
      ),
  });

  if (!creating && existing.isPending) return <Spinner label="Loading problem…" />;
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

  const p = existing.data;

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/admin/problems" className="text-sm text-slate-400 hover:text-white">
        ← All problems
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">
          {creating ? "New problem" : p?.title}
        </h1>
        {p && (
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs ring-1 ring-inset ${
                p.published
                  ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                  : "bg-slate-500/15 text-slate-300 ring-slate-500/30"
              }`}
            >
              {p.published ? "Published" : "Draft"}
            </span>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => togglePublished.mutate(!p.published)}
              disabled={togglePublished.isPending}
            >
              {p.published ? "Unpublish" : "Publish"}
            </button>
          </div>
        )}
      </div>

      {p && !p.published && (
        <p className="mt-3 rounded-md border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-400">
          Drafts are invisible to users. Publishing needs at least one hidden test case, so the
          problem can actually be judged.
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <FormError message={formError} />
        {saved && !formError && (
          <p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            Saved.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="slug"
            label="Slug (URL)"
            value={draft.slug}
            error={errors.slug}
            onChange={(e) => set("slug", e.target.value)}
          />
          <Field
            id="title"
            label="Title"
            value={draft.title}
            error={errors.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="difficulty" className="mb-1 block text-sm font-medium text-slate-300">
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

        <TextArea
          id="description"
          label="Statement (Markdown)"
          rows={12}
          value={draft.description}
          error={errors.description}
          onChange={(v) => set("description", v)}
        />
        <TextArea
          id="constraints"
          label="Constraints (Markdown)"
          rows={5}
          value={draft.constraints}
          onChange={(v) => set("constraints", v)}
        />

        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : creating ? "Create problem" : "Save changes"}
          </button>
          <Link to="/admin/problems" className="btn btn-outline">
            Cancel
          </Link>
        </div>
      </form>

      {!creating && id && <TestCaseEditor problemId={id} />}
    </div>
  );
}

function TextArea({
  id,
  label,
  rows,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  rows: number;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-300">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        className="input font-mono text-sm"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p id={`${id}-err`} className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------- test cases

function TestCaseEditor({ problemId }: { problemId: string }) {
  const queryClient = useQueryClient();
  const cases = useQuery({
    queryKey: ["admin-test-cases", problemId],
    queryFn: ({ signal }) => adminApi.listTestCases(problemId, signal),
  });

  const [input, setInput] = useState("");
  const [expected, setExpected] = useState("");
  const [explanation, setExplanation] = useState("");
  const [isSample, setIsSample] = useState(false);
  const [points, setPoints] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminTestCase | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-test-cases", problemId] });
    queryClient.invalidateQueries({ queryKey: ["admin-problem", problemId] });
    queryClient.invalidateQueries({ queryKey: ["admin-problems"] });
  };

  const create = useMutation({
    mutationFn: () =>
      adminApi.createTestCase(problemId, {
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
      setError(err instanceof ApiError ? err.message : "Could not add the test case."),
  });

  const remove = useMutation({
    mutationFn: (caseId: string) => adminApi.deleteTestCase(caseId),
    onSuccess: () => {
      setPendingDelete(null);
      setError(null);
      refresh();
    },
    onError: (err) => {
      setPendingDelete(null);
      setError(err instanceof ApiError ? err.message : "Could not delete the test case.");
    },
  });

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-white">Test cases</h2>
      <p className="mt-1 text-sm text-slate-400">
        Samples are shown publicly on the problem page. Hidden cases are used only by the judge
        and are never returned by a public endpoint.
      </p>

      {error && (
        <p role="alert" className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
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
            <p className="card p-4 text-sm text-slate-400">No test cases yet.</p>
          )}
          {cases.data.map((c) => (
            <div key={c.id} className="card p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-500">#{c.position}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
                      c.is_sample
                        ? "bg-sky-500/15 text-sky-300 ring-sky-500/30"
                        : "bg-slate-500/15 text-slate-300 ring-slate-500/30"
                    }`}
                  >
                    {c.is_sample ? "Public sample" : "Hidden"}
                  </span>
                  <span className="text-xs text-slate-500">{c.points} point(s)</span>
                </div>
                <button
                  type="button"
                  className="text-xs text-rose-400 hover:underline"
                  onClick={() => setPendingDelete(c)}
                >
                  Delete
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ReadOnlyBlock label="Input" text={c.input} />
                <ReadOnlyBlock label="Expected output" text={c.expected_output} />
              </div>
              {c.explanation && (
                <p className="mt-2 text-xs text-slate-400">{c.explanation}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <form
        className="card mt-6 space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!expected.trim()) {
            setError("Expected output must not be empty.");
            return;
          }
          create.mutate();
        }}
      >
        <h3 className="text-sm font-semibold text-white">Add a test case</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="tc-input" className="mb-1 block text-xs text-slate-400">
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
            <label htmlFor="tc-expected" className="mb-1 block text-xs text-slate-400">
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
          <label className="flex items-center gap-2 text-sm text-slate-300">
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
            <label htmlFor="tc-points" className="mb-1 block text-xs text-slate-400">
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
            <label htmlFor="tc-explanation" className="mb-1 block text-xs text-slate-400">
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
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
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
      <div className="mb-1 text-xs text-slate-500">{label}</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-2 font-mono text-xs text-slate-200">
        {text}
      </pre>
    </div>
  );
}
