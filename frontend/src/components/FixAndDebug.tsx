import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bug, CircleAlert, Info, RotateCcw } from "lucide-react";
import { replaysApi } from "../api/endpoints";
import type { Replay } from "../api/types";
import CodeEditor, { type EditorMarker } from "./CodeEditor";
import { writeDraft } from "./Workspace";

export type Diagnostic = EditorMarker & { text: string };

/**
 * The compiler's `file:line:col: error: message` lines (g++ and clang), in
 * order, without duplicates. Context lines (the source excerpt and carets)
 * are left out: the editor shows the source itself.
 */
export function parseDiagnostics(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const re = /^[^\s:][^:\n]*:(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/gm;
  for (const m of output.matchAll(re)) {
    const line = Number(m[1]);
    const column = m[2] ? Number(m[2]) : undefined;
    const severity = m[3] === "warning" ? "warning" : m[3] === "note" ? "note" : "error";
    const message = m[4].trim();
    const key = `${line}:${column}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, column, severity, message, text: m[0] });
  }
  return out;
}

const ICON = { error: CircleAlert, warning: AlertTriangle, note: Info } as const;
const TONE = {
  error: "border-bad/30 bg-bad/[0.06] text-bad",
  warning: "border-warn/30 bg-warn/[0.07] text-warn",
  note: "border-line bg-sunken/60 text-muted",
} as const;

/**
 * Edit the recorded program and record it again, without leaving the
 * debugger. Compiler errors are listed beside the code and marked on their
 * lines; the new version is also saved as the problem's draft.
 */
export default function FixAndDebug({ replay: r, onCancel }: { replay: Replay; onCancel?: () => void }) {
  const navigate = useNavigate();
  const [source, setSource] = useState(r.source_code);
  const [stdin, setStdin] = useState(r.stdin);
  const [jump, setJump] = useState<{ line: number; column?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diagnostics = useMemo(() => parseDiagnostics(r.compile_output), [r.compile_output]);
  // Once the code changes, the old line numbers may point at the wrong place.
  const edited = source !== r.source_code;
  const errors = diagnostics.filter((d) => d.severity === "error").length;

  const debugAgain = async () => {
    setError(null);
    setBusy(true);
    try {
      const { replay_id } = await replaysApi.create({
        problem_id: r.problem_slug ?? undefined,
        language: r.language,
        source_code: source,
        stdin,
      });
      if (r.problem_slug) writeDraft(r.problem_slug, r.language, source);
      navigate(`/replays/${replay_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the debugger.");
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0">
        <CodeEditor
          value={source}
          onChange={setSource}
          language="cpp"
          label="Your code · C++17"
          heightClass="h-[26rem] lg:h-[34rem]"
          markers={edited ? undefined : diagnostics}
          jump={jump}
          toolbar={
            edited && (
              <button
                type="button"
                className="btn btn-ghost min-h-[30px] px-2.5 text-xs"
                onClick={() => {
                  setSource(r.source_code);
                  setJump(null);
                }}
              >
                <RotateCcw size={13} aria-hidden="true" /> Undo my changes
              </button>
            )
          }
        />
      </div>

      <aside className="flex flex-col gap-4" aria-label="Fix and debug again">
        {diagnostics.length > 0 && (
          <section className="card overflow-hidden" aria-labelledby="diag-h">
            <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
              <h2 id="diag-h" className="text-sm font-semibold text-ink">
                {errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "Compiler messages"}
              </h2>
              {edited && <span className="text-xs text-faint">from the last compile</span>}
            </div>
            <ul className="max-h-72 space-y-2 overflow-y-auto p-3" aria-label="Compiler errors">
              {diagnostics.map((d) => {
                const Icon = ICON[d.severity];
                return (
                  <li key={d.text}>
                    <button
                      type="button"
                      onClick={() => setJump({ line: d.line, column: d.column })}
                      className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors hover:brightness-95 ${TONE[d.severity]}`}
                      aria-label={`Line ${d.line}: ${d.message}`}
                    >
                      <Icon size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="font-mono text-[0.6875rem] font-semibold uppercase tracking-wide">
                          Line {d.line}
                          {d.column ? `:${d.column}` : ""}
                        </span>
                        <span className="mt-0.5 block break-words text-sm text-ink">{d.message}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <details className="border-t border-line/70 px-4 py-3 text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">Full compiler output</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[0.6875rem] text-muted">{r.compile_output}</pre>
            </details>
          </section>
        )}
        {diagnostics.length === 0 && r.compile_output.trim() && (
          <pre className="card max-h-72 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs text-bad">{r.compile_output}</pre>
        )}

        <section className="card p-4">
          <label htmlFor="replay-stdin" className="label">
            Input <span className="font-normal text-faint">(stdin)</span>
          </label>
          <textarea
            id="replay-stdin"
            className="input min-h-[96px] font-mono text-[13px]"
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            placeholder="What the program reads"
            spellCheck={false}
          />
          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </p>
          )}
          <button type="button" className="btn btn-primary mt-4 w-full" onClick={debugAgain} disabled={busy || !source.trim()}>
            <Bug size={16} aria-hidden="true" /> {busy ? "Starting…" : "Debug again"}
          </button>
          <p className="mt-2 text-center text-xs text-faint">
            {r.problem_slug ? "Also saved as your draft for this problem." : "Records the new version from the start."}
          </p>
          {onCancel && (
            <button type="button" className="btn btn-ghost mt-2 w-full" onClick={onCancel}>
              Back to the replay
            </button>
          )}
        </section>
      </aside>
    </div>
  );
}
