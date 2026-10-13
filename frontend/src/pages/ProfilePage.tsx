import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/endpoints";
import { TERMINAL_VERDICTS } from "../api/types";
import { ErrorState, Spinner } from "../components/Feedback";
import { verdictLabel } from "../components/VerdictBadge";

/** Protected page: profile plus statistics computed from persisted submissions. */
export default function ProfilePage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => authApi.me() });
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => authApi.stats() });

  if (me.isPending) return <Spinner label="Loading profile…" />;
  if (me.isError) {
    return (
      <ErrorState
        title="Couldn't load your profile"
        message={me.error.message}
        onRetry={() => me.refetch()}
      />
    );
  }

  const u = me.data;
  const s = stats.data;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold text-white">Your profile</h1>

      <div className="card divide-y divide-slate-800">
        <Row label="Username" value={u.username} />
        <Row label="Email" value={u.email} />
        <Row label="Role" value={u.role} />
        <Row label="Member since" value={new Date(u.created_at).toLocaleDateString()} />
      </div>

      <h2 className="mb-4 mt-8 text-lg font-semibold text-white">Statistics</h2>

      {stats.isPending ? (
        <Spinner label="Loading statistics…" />
      ) : stats.isError ? (
        <ErrorState
          title="Couldn't load your statistics"
          message={stats.error.message}
          onRetry={() => stats.refetch()}
        />
      ) : !s ? null : s.total_submissions === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-slate-400">
            You haven't submitted anything yet.{" "}
            <Link to="/problems" className="text-indigo-400 hover:underline">
              Pick a problem
            </Link>{" "}
            to get started.
          </p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Problems solved"
              value={`${s.problems_solved}`}
              hint={`of ${s.problems_available} published`}
            />
            <Stat label="Submissions" value={`${s.total_submissions}`} />
            <Stat label="Accepted" value={`${s.accepted_submissions}`} />
            <Stat label="Acceptance rate" value={`${s.acceptance_rate}%`} />
          </dl>

          <div className="card mt-4 p-5">
            <h3 className="mb-4 text-sm font-semibold text-white">Solved by difficulty</h3>
            <div className="space-y-3">
              <DifficultyBar
                label="Easy"
                solved={s.solved_easy}
                total={s.available_easy}
                barClass="bg-emerald-500"
              />
              <DifficultyBar
                label="Medium"
                solved={s.solved_medium}
                total={s.available_medium}
                barClass="bg-amber-500"
              />
              <DifficultyBar
                label="Hard"
                solved={s.solved_hard}
                total={s.available_hard}
                barClass="bg-rose-500"
              />
            </div>
          </div>

          <div className="card mt-4 p-5">
            <h3 className="mb-3 text-sm font-semibold text-white">Verdicts</h3>
            <ul className="grid gap-2 sm:grid-cols-2">
              {TERMINAL_VERDICTS.filter((v) => (s.verdict_counts[v] ?? 0) > 0).map((v) => (
                <li key={v} className="flex items-center justify-between text-sm">
                  <span className="text-slate-400">{verdictLabel(v)}</span>
                  <span className="font-mono text-slate-200">{s.verdict_counts[v]}</span>
                </li>
              ))}
            </ul>
          </div>

          {s.last_submission_at && (
            <p className="mt-4 text-xs text-slate-500">
              Last submission {new Date(s.last_submission_at).toLocaleString()}.{" "}
              <Link to="/submissions" className="text-indigo-400 hover:underline">
                See your history
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-100">{value}</span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 font-mono text-2xl text-slate-100">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function DifficultyBar({
  label,
  solved,
  total,
  barClass,
}: {
  label: string;
  solved: number;
  total: number;
  barClass: string;
}) {
  const pct = total > 0 ? Math.round((solved / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-300">
          {solved} / {total}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-label={`${label} problems solved`}
        aria-valuenow={solved}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
