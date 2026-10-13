import type { ReactNode } from "react";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-slate-400">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
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
      <h2 className="text-lg font-semibold text-red-300">{title}</h2>
      {message && <p className="mt-2 text-sm text-slate-400">{message}</p>}
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
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card mx-auto my-6 max-w-lg p-8 text-center">
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      {message && <p className="mt-2 text-sm text-slate-400">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
