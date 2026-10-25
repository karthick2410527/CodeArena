import type { ReactNode } from "react";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-muted">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="card mx-auto my-10 max-w-lg p-8 text-center">
      <h2 className="text-lg font-semibold text-bad">{title}</h2>
      {message && <p className="mt-2 text-sm text-muted">{message}</p>}
      {onRetry && (
        <button type="button" className="btn btn-outline mt-5" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
  icon,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
  /** A lucide icon element, shown in a tinted tile above the title. */
  icon?: ReactNode;
}) {
  return (
    <div className="card mx-auto my-6 max-w-lg p-8 text-center">
      {icon && <div className="icon-tile mx-auto mb-4 h-12 w-12 rounded-2xl">{icon}</div>}
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {message && <p className="mt-2 text-sm text-muted">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
