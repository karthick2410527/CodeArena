import type { SubmissionStatus } from "../api/types";

/**
 * One consistent vocabulary for judge state across the whole app.
 *
 * Colour is never the only signal: every badge also carries its label, so the
 * state is readable without relying on being able to distinguish red and green.
 */
const STYLES: Record<string, string> = {
  QUEUED: "bg-sunken text-muted ring-line-strong/30",
  RUNNING: "bg-accent/10 text-accent ring-accent/30",
  ACCEPTED: "bg-good/15 text-good ring-good/30",
  WRONG_ANSWER: "bg-bad/15 text-bad ring-bad/30",
  COMPILATION_ERROR: "bg-warn/15 text-warn ring-warn/30",
  RUNTIME_ERROR: "bg-warn/15 text-warn ring-warn/30",
  TIME_LIMIT_EXCEEDED: "bg-accent/10 text-accent ring-accent/30",
  MEMORY_LIMIT_EXCEEDED: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
  INTERNAL_ERROR: "bg-bad/15 text-bad ring-bad/30",
  OUTPUT_LIMIT_EXCEEDED: "bg-warn/15 text-warn ring-warn/30",
  OK: "bg-good/15 text-good ring-good/30",
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
        STYLES[status] ?? "bg-sunken text-muted ring-line-strong/30"
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
