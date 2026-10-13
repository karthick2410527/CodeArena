import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { metaApi } from "../api/endpoints";
import type { ProblemDetail, RunCase } from "../api/types";
import { useRun, useSubmit } from "../hooks/useJudge";
import { useAuth } from "../auth/AuthContext";
import CodeEditor from "./CodeEditor";
import VerdictBadge from "./VerdictBadge";

/** Drafts survive a reload, so a half-written solution is not lost. */
function draftKey(slug: string, language: string) {
  return `codearena.draft.${slug}.${language}`;
}

function readDraft(slug: string, language: string): string | null {
  try {
    return localStorage.getItem(draftKey(slug, language));
  } catch {
    return null;
  }
}

function writeDraft(slug: string, language: string, source: string) {
  try {
    localStorage.setItem(draftKey(slug, language), source);
  } catch {
    /* storage unavailable: the draft simply won't survive a reload */
  }
}

type Tab = "input" | "result";

export default function Workspace({ problem }: { problem: ProblemDetail }) {
  const { status: authStatus } = useAuth();
  const authenticated = authStatus === "authenticated";

  const languages = useQuery({
    queryKey: ["languages"],
    queryFn: () => metaApi.languages(),
    staleTime: Infinity,
  });
  const limits = useQuery({
    queryKey: ["limits"],
    queryFn: () => metaApi.limits(),
    staleTime: Infinity,
  });

  const [languageId, setLanguageId] = useState<string>("cpp17");
  const language = useMemo(
    () => languages.data?.find((l) => l.id === languageId) ?? languages.data?.[0],
    [languages.data, languageId],
  );

  const [source, setSource] = useState("");
  const [mode, setMode] = useState<"samples" | "custom">("samples");
  const [stdin, setStdin] = useState(problem.samples[0]?.input ?? "");
  const [tab, setTab] = useState<Tab>("input");

  const run = useRun();
  const submit = useSubmit();

  // If the server's language list does not contain the default, follow the
  // server rather than leaving the selector showing something unavailable.
  useEffect(() => {
    const available = languages.data;
    if (available?.length && !available.some((l) => l.id === languageId)) {
      setLanguageId(available[0].id);
    }
  }, [languages.data, languageId]);

  // Seed the editor from the saved draft, or the language's starter code.
  //
  // This must happen exactly once per (problem, language): keying it on the
  // query result would re-run whenever TanStack Query refetched the language
  // list and silently discard whatever the user had typed.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!language) return;
    const key = `${problem.slug}/${language.id}`;
    if (seeded.current === key) return;
    seeded.current = key;
    setSource(readDraft(problem.slug, language.id) ?? language.starter_code);
  }, [language, problem.slug]);

  useEffect(() => {
    if (!language || !source) return;
    const t = setTimeout(() => writeDraft(problem.slug, language.id, source), 400);
    return () => clearTimeout(t);
  }, [source, language, problem.slug]);

  const sourceBytes = new TextEncoder().encode(source).length;
  const maxSource = limits.data?.max_source_bytes;
  const tooLong = maxSource !== undefined && sourceBytes > maxSource;
  const busy = run.busy || submit.busy;
  const canAct = authenticated && !busy && source.trim().length > 0 && !tooLong;

  const onRun = () => {
    if (!language) return;
    submit.reset();
    setTab("result");
    run.start({
      problemSlug: problem.slug,
      language: language.id,
      source,
      mode,
      stdin,
    });
  };

  const onSubmit = () => {
    if (!language) return;
    run.reset();
    setTab("result");
    submit.start({ problemSlug: problem.slug, language: language.id, source });
  };

  const onReset = () => {
    if (!language) return;
    setSource(language.starter_code);
    writeDraft(problem.slug, language.id, language.starter_code);
  };

  return (
    <div className="space-y-4">
      <CodeEditor
        value={source}
        onChange={setSource}
        language={language?.monaco_id ?? "cpp"}
        label={language?.display_name ?? "Editor"}
        toolbar={
          <>
            <label className="sr-only" htmlFor="language">
              Language
            </label>
            <select
              id="language"
              className="input w-auto py-1 text-xs"
              value={languageId}
              onChange={(e) => setLanguageId(e.target.value)}
              disabled={(languages.data?.length ?? 1) <= 1}
            >
              {(languages.data ?? [{ id: "cpp17", display_name: "C++17" }]).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.display_name}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-outline py-1 text-xs" onClick={onReset}>
              Reset
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={`text-xs ${tooLong ? "text-rose-400" : "text-slate-500"}`}>
          {sourceBytes.toLocaleString()} bytes
          {maxSource !== undefined && ` of ${maxSource.toLocaleString()} allowed`}
          {tooLong && " — shorten your code before running it"}
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn btn-outline" onClick={onRun} disabled={!canAct}>
            {run.busy ? "Running…" : "Run"}
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={!canAct}>
            {submit.busy ? "Judging…" : "Submit"}
          </button>
        </div>
      </div>

      {!authenticated && (
        <p className="card border-dashed p-4 text-sm text-slate-400">
          <Link to="/login" className="text-indigo-400 hover:underline">
            Log in
          </Link>{" "}
          to run and submit your solution.
        </p>
      )}

      <div className="card overflow-hidden">
        <div
          role="tablist"
          aria-label="Editor panels"
          className="flex border-b border-slate-800 bg-slate-900/80"
        >
          <TabButton active={tab === "input"} onClick={() => setTab("input")} id="tab-input">
            Test input
          </TabButton>
          <TabButton active={tab === "result"} onClick={() => setTab("result")} id="tab-result">
            Result
          </TabButton>
        </div>

        {tab === "input" ? (
          <div id="panel-input" role="tabpanel" aria-labelledby="tab-input" className="space-y-3 p-4">
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                What to run against
              </legend>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="run-mode"
                    value="samples"
                    checked={mode === "samples"}
                    onChange={() => setMode("samples")}
                    disabled={problem.samples.length === 0}
                  />
                  <span className={problem.samples.length === 0 ? "text-slate-500" : ""}>
                    Public samples ({problem.samples.length})
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="run-mode"
                    value="custom"
                    checked={mode === "custom"}
                    onChange={() => setMode("custom")}
                  />
                  <span>Custom input</span>
                </label>
              </div>
            </fieldset>

            {mode === "custom" ? (
              <div>
                <label htmlFor="stdin" className="mb-1 block text-xs text-slate-400">
                  Standard input
                </label>
                <textarea
                  id="stdin"
                  rows={6}
                  spellCheck={false}
                  className="input font-mono text-sm"
                  value={stdin}
                  onChange={(e) => setStdin(e.target.value)}
                  placeholder="Type the input your program should read…"
                />
                {limits.data && (
                  <p className="mt-1 text-xs text-slate-500">
                    Up to {limits.data.max_input_bytes.toLocaleString()} bytes.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-400">
                Your code runs against the published examples only. Hidden test cases are used
                when you <span className="text-slate-200">Submit</span>.
              </p>
            )}
          </div>
        ) : (
          <div id="panel-result" role="tabpanel" aria-labelledby="tab-result" className="p-4">
            <ResultPanel run={run} submit={submit} />
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  id,
  children,
}: {
  active: boolean;
  onClick: () => void;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium transition ${
        active
          ? "border-b-2 border-indigo-400 text-white"
          : "border-b-2 border-transparent text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function ResultPanel({
  run,
  submit,
}: {
  run: ReturnType<typeof useRun>;
  submit: ReturnType<typeof useSubmit>;
}) {
  if (submit.busy || submit.result || submit.error) {
    return <SubmitResult state={submit} />;
  }
  if (run.busy || run.result || run.error) {
    return <RunResult state={run} />;
  }
  return (
    <p className="py-6 text-center text-sm text-slate-500">
      Run your code to see its output here.
    </p>
  );
}

function RunResult({ state }: { state: ReturnType<typeof useRun> }) {
  const { busy, result, error } = state;
  if (error && !result) return <Problem message={error} />;
  if (busy && !result?.cases.length) {
    return <Pending label={result?.status === "RUNNING" ? "Running your code…" : "Queued…"} />;
  }
  if (!result) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <VerdictBadge status={result.outcome ?? result.status} />
        {result.compile_time_ms !== null && (
          <span className="text-xs text-slate-500">compiled in {result.compile_time_ms} ms</span>
        )}
      </div>

      {result.message && <p className="text-sm text-slate-300">{result.message}</p>}

      {result.compile_output.trim() && (
        <Block
          label={result.outcome === "COMPILATION_ERROR" ? "Compiler errors" : "Compiler warnings"}
          text={result.compile_output}
          tone={result.outcome === "COMPILATION_ERROR" ? "error" : "muted"}
        />
      )}

      {result.cases.map((c) => (
        <CaseResult key={c.position} testCase={c} />
      ))}

      {error && <p className="text-sm text-amber-300">{error}</p>}
    </div>
  );
}

function CaseResult({ testCase: c }: { testCase: RunCase }) {
  const failed = c.passed === false || c.exec_status !== "OK";
  return (
    <section
      className={`rounded-md border p-3 ${
        failed ? "border-rose-500/30 bg-rose-500/5" : "border-slate-800 bg-slate-950/60"
      }`}
    >
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">{c.label}</h3>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {c.time_ms !== null && <span>{c.time_ms} ms</span>}
          {c.memory_bytes !== null && <span>{formatBytes(c.memory_bytes)}</span>}
          {c.passed === true && <span className="text-emerald-300">passed</span>}
          {c.passed === false && <span className="text-rose-300">failed</span>}
          {c.exec_status !== "OK" && <VerdictBadge status={c.exec_status} size="sm" />}
        </div>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <Block label="Input" text={c.input} />
        <Block
          label="Your output"
          text={c.stdout || "(no output)"}
          truncated={c.stdout_truncated}
          tone={c.passed === false ? "error" : "default"}
        />
        {c.expected_output !== null && <Block label="Expected output" text={c.expected_output} />}
        {c.stderr.trim() && (
          <Block label="Standard error" text={c.stderr} truncated={c.stderr_truncated} tone="muted" />
        )}
      </div>
    </section>
  );
}

function SubmitResult({ state }: { state: ReturnType<typeof useSubmit> }) {
  const { busy, result, error } = state;
  if (error && !result) return <Problem message={error} />;
  if (!result) return <Pending label="Submitting…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <VerdictBadge status={result.status} />
        {result.total_tests > 0 && (
          <span className="text-sm text-slate-400">
            {result.passed_tests} / {result.total_tests} tests passed
          </span>
        )}
        {result.execution_time_ms !== null && (
          <span className="text-xs text-slate-500">{result.execution_time_ms} ms</span>
        )}
        {result.memory_bytes !== null && (
          <span className="text-xs text-slate-500">{formatBytes(result.memory_bytes)}</span>
        )}
      </div>

      {busy && <Pending label="Judging against the hidden tests…" />}
      {result.message && <p className="text-sm text-slate-300">{result.message}</p>}

      {result.failed_case_position !== null && (
        <p className="text-sm text-slate-400">
          Failed on test {result.failed_case_position}. Hidden test data is not shown.
        </p>
      )}

      {result.compile_output?.trim() && (
        <Block
          label={
            result.verdict === "COMPILATION_ERROR" ? "Compiler errors" : "Compiler warnings"
          }
          text={result.compile_output}
          tone={result.verdict === "COMPILATION_ERROR" ? "error" : "muted"}
        />
      )}

      {!busy && (
        <Link
          to={`/submissions/${result.submission_id}`}
          className="inline-block text-sm text-indigo-400 hover:underline"
        >
          View full submission →
        </Link>
      )}
      {error && <p className="text-sm text-amber-300">{error}</p>}
    </div>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-4 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      {label}
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {message}
    </div>
  );
}

function Block({
  label,
  text,
  truncated,
  tone = "default",
}: {
  label: string;
  text: string;
  truncated?: boolean;
  tone?: "default" | "error" | "muted";
}) {
  const toneClass =
    tone === "error"
      ? "text-rose-200"
      : tone === "muted"
        ? "text-amber-200"
        : "text-slate-100";
  return (
    <div>
      <div className="mb-1 text-xs text-slate-500">{label}</div>
      <pre
        className={`max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-3 font-mono text-xs ${toneClass}`}
      >
        {text}
      </pre>
      {truncated && (
        <p className="mt-1 text-xs text-amber-400">Output was truncated at the size limit.</p>
      )}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
