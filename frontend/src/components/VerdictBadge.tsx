import type { SubmissionStatus } from "../api/types";

/**
 * One consistent vocabulary for judge state across the whole app.
 *
 * Colour is never the only signal: every badge also carries its label, so the
 * state is readable without relying on being able to distinguish red and green.
 */
const STYLES: Record<string, string> = {
  QUEUED: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  RUNNING: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  ACCEPTED: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  WRONG_ANSWER: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  COMPILATION_ERROR: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  RUNTIME_ERROR: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  TIME_LIMIT_EXCEEDED: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  MEMORY_LIMIT_EXCEEDED: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
  INTERNAL_ERROR: "bg-red-500/15 text-red-300 ring-red-500/30",
  OUTPUT_LIMIT_EXCEEDED: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  OK: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
};

const LABELS: Record<string, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  ACCEPTED: "Accepted",
  WRONG_ANSWER: "Wrong Answer",
  COMPILATION_ERROR: "Compilation Error",
  RUNTIME_ERROR: "Runtime Error",
  TIME_LIMIT_EXCEEDED: "Time Limit Exceeded",
  MEMORY_LIMIT_EXCEEDED: "Memory Limit Exceeded",
  INTERNAL_ERROR: "Judge Error",
  OUTPUT_LIMIT_EXCEEDED: "Output Limit Exceeded",
  OK: "Ran successfully",
};

export function verdictLabel(status: string): string {
  return LABELS[status] ?? status;
}

export default function VerdictBadge({
  status,
  size = "md",
}: {
  status: SubmissionStatus | string;
  size?: "sm" | "md";
}) {
  const pending = status === "QUEUED" || status === "RUNNING";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset ${
        STYLES[status] ?? "bg-slate-500/15 text-slate-300 ring-slate-500/30"
      } ${size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"}`}
    >
      {pending && (
        <span
          aria-hidden="true"
          className="h-2 w-2 animate-pulse rounded-full bg-current"
        />
      )}
      {verdictLabel(status)}
    </span>
  );
}
