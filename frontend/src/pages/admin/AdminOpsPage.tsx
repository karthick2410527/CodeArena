import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { adminApi } from "../../api/endpoints";
import ConfirmDialog from "../../components/ConfirmDialog";
import { ErrorState, Spinner } from "../../components/Feedback";

/**
 * Operations view: are the workers alive, is the queue keeping up, and what
 * failed? This is the screen that answers "where did my submission go".
 */
export default function AdminOpsPage() {
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const [replayId, setReplayId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workers = useQuery({
    queryKey: ["admin-workers"],
    queryFn: () => adminApi.workers(),
    // Liveness is only useful if it is current.
    refetchInterval: 5000,
  });

  const deadLetters = useQuery({
    queryKey: ["admin-dead-letters", showResolved],
    queryFn: () =>
      adminApi.deadLetters({ page: 1, limit: 25, include_resolved: showResolved }),
  });

  const replay = useMutation({
    mutationFn: (id: number) => adminApi.replayDeadLetter(id, "replayed from the admin console"),
    onSuccess: (result) => {
      setReplayId(null);
      setError(null);
      setNotice(`Submission ${result.submission_id.slice(0, 8)}… re-queued.`);
      queryClient.invalidateQueries({ queryKey: ["admin-dead-letters"] });
      queryClient.invalidateQueries({ queryKey: ["admin-workers"] });
    },
    onError: (err) => {
      setReplayId(null);
      setNotice(null);
      setError(err instanceof ApiError ? err.message : "Could not replay that job.");
    },
  });

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Judge operations</h1>
      <p className="mt-1 text-sm text-slate-400">
        Worker liveness, queue lag and the failures that need a human.
      </p>

      {notice && (
        <p role="status" className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {workers.isPending ? (
        <Spinner label="Loading worker health…" />
      ) : workers.isError ? (
        <ErrorState
          title="Couldn't load worker health"
          message={workers.error.message}
          onRetry={() => workers.refetch()}
        />
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Workers alive" value={String(workers.data.workers.filter((w) => w.healthy).length)} />
            <Stat label="Queued" value={String(workers.data.queued_submissions)} />
            <Stat label="Running" value={String(workers.data.running_submissions)} />
            <Stat
              label="Queue backlog"
              value={String(workers.data.queue_backlog)}
              hint={
                workers.data.oldest_pending_secs !== null
                  ? `oldest ${workers.data.oldest_pending_secs}s`
                  : undefined
              }
            />
            <Stat
              label="Dead letters"
              value={String(workers.data.unresolved_dead_letters)}
              tone={workers.data.unresolved_dead_letters > 0 ? "warn" : "default"}
            />
          </dl>

          <h2 className="mb-3 mt-8 text-lg font-semibold text-white">Workers</h2>
          {workers.data.workers.length === 0 ? (
            <p className="card p-4 text-sm text-amber-300">
              No worker has reported in. Submissions will stay queued until
              <code className="mx-1 rounded bg-slate-800 px-1">codearena-worker</code>
              is running.
            </p>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-2">Worker</th>
                    <th scope="col" className="px-4 py-2">Health</th>
                    <th scope="col" className="px-4 py-2">Queue</th>
                    <th scope="col" className="px-4 py-2">Runner</th>
                    <th scope="col" className="px-4 py-2">Judged</th>
                    <th scope="col" className="px-4 py-2">Runs</th>
                    <th scope="col" className="px-4 py-2">Failures</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {workers.data.workers.map((w) => (
                    <tr key={w.worker_id}>
                      <td className="px-4 py-2 font-mono text-xs text-slate-300">
                        {w.worker_id}
                        <div className="text-slate-500">v{w.version}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
                            w.healthy
                              ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                              : "bg-rose-500/15 text-rose-300 ring-rose-500/30"
                          }`}
                        >
                          {w.healthy ? "Healthy" : "Stale"}
                        </span>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {Math.round(w.seconds_since_heartbeat)}s ago
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-400">{w.queue_driver}</td>
                      <td className="px-4 py-2 text-xs text-slate-400">{w.runner_strategy}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-400">
                        {w.submissions_judged}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-400">
                        {w.runs_executed}
                      </td>
                      <td
                        className={`px-4 py-2 font-mono text-xs ${
                          w.failures > 0 ? "text-amber-300" : "text-slate-400"
                        }`}
                      >
                        {w.failures}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">Dead-lettered jobs</h2>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Include resolved
        </label>
      </div>

      {deadLetters.isPending ? (
        <Spinner label="Loading dead letters…" />
      ) : deadLetters.isError ? (
        <ErrorState
          title="Couldn't load the dead-letter queue"
          message={deadLetters.error.message}
          onRetry={() => deadLetters.refetch()}
        />
      ) : deadLetters.data.items.length === 0 ? (
        <p className="card p-4 text-sm text-slate-400">
          Nothing here — no judge job has exhausted its retries.
        </p>
      ) : (
        <ul className="card divide-y divide-slate-800">
          {deadLetters.data.items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm text-slate-200">{d.reason}</div>
                <div className="mt-0.5 font-mono text-xs text-slate-500">
                  #{d.id} · {new Date(d.created_at).toLocaleString()}
                  {d.submission_id && ` · ${d.submission_id.slice(0, 8)}…`}
                  {d.correlation_id && ` · trace ${d.correlation_id}`}
                </div>
                {d.resolution && (
                  <div className="mt-0.5 text-xs text-emerald-300">{d.resolution}</div>
                )}
              </div>
              {d.resolved_at === null && d.submission_id && (
                <button
                  type="button"
                  className="btn btn-outline py-1 text-xs"
                  onClick={() => setReplayId(d.id)}
                >
                  Replay
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={replayId !== null}
        title="Replay this job?"
        message="The submission is reset to QUEUED with a fresh attempt budget and judged again. Its previous verdict is replaced."
        confirmLabel="Replay"
        busy={replay.isPending}
        onCancel={() => setReplayId(null)}
        onConfirm={() => replayId !== null && replay.mutate(replayId)}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className="card p-4">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={`mt-1 font-mono text-2xl ${
          tone === "warn" ? "text-amber-300" : "text-slate-100"
        }`}
      >
        {value}
      </dd>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
