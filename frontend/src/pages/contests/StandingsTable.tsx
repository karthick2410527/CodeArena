import type { StandingsCell, StandingsView } from "../../api/types";
import { formatElapsed } from "../../components/contest";
import { Avatar, UserLink } from "../../components/people";

/**
 * The scoreboard. Each problem cell shows, per format:
 * ICPC "+1 / 0:42" (solved after one wrong try) or "-2" (two wrong, unsolved);
 * points formats the points and the solve time; a submission still being
 * judged shows "?". The first solve of a problem is marked, and the viewer's
 * own row is highlighted.
 */
export default function StandingsTable({ view, me }: { view: StandingsView; me?: string }) {
  const icpc = view.format === "ICPC";
  if (view.rows.length === 0) {
    return <p className="card p-6 text-center text-muted">Nobody has registered yet.</p>;
  }
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-max text-sm" aria-label="Standings">
        <thead className="border-b border-line bg-paper/40 text-[0.6875rem] uppercase tracking-[0.08em] text-faint">
          <tr>
            <th className="w-14 px-3 py-2.5 text-right font-semibold">#</th>
            <th className="px-3 py-2.5 text-left font-semibold">Contestant</th>
            <th className="px-3 py-2.5 text-right font-semibold">{icpc ? "Solved" : "Score"}</th>
            {(icpc || view.format === "ATCODER") && <th className="px-3 py-2.5 text-right font-semibold">Penalty</th>}
            {view.problems.map((p) => (
              <th key={p.label} className="w-20 px-2 py-2.5 text-center font-semibold">
                <span className="block text-sm text-ink">{p.label}</span>
                {!icpc && <span className="font-mono normal-case tracking-normal">{p.points}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {view.rows.map((r) => {
            const mine = r.participant.username === me;
            return (
              <tr key={r.participant.user_id} className={mine ? "bg-accent/10" : undefined} aria-current={mine ? "true" : undefined}>
                <td className="px-3 py-2 text-right font-mono text-muted">{r.rank}</td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Avatar username={r.participant.username} url={r.participant.avatar_url} size={24} />
                    <UserLink username={r.participant.username} />
                    {mine && <span className="text-xs text-accent">you</span>}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-display text-base font-semibold text-ink tabular">{r.score}</td>
                {(icpc || view.format === "ATCODER") && (
                  <td className="px-3 py-2 text-right font-mono text-xs text-muted">
                    {r.penalty === null ? "" : icpc ? r.penalty : formatElapsed(r.penalty)}
                  </td>
                )}
                {r.cells.map((cell) => (
                  <td key={cell.label} className="px-1 py-1 text-center">
                    <Cell cell={cell} icpc={icpc} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ cell, icpc }: { cell: StandingsCell; icpc: boolean }) {
  if (cell.solved) {
    const top = icpc ? (cell.wrong > 0 ? `+${cell.wrong}` : "+") : String(cell.score ?? "");
    return (
      <span
        className={`block rounded-lg px-1 py-1 ${cell.first_solve ? "bg-good/25 ring-1 ring-good/40" : "bg-good/10"}`}
        title={cell.first_solve ? "First to solve" : undefined}
        data-cell="solved"
      >
        <span className="block font-semibold text-good">{top}</span>
        <span className="block font-mono text-[0.6875rem] text-muted">
          {cell.solved_at !== null ? formatElapsed(cell.solved_at) : ""}
          {!icpc && cell.wrong > 0 ? ` (−${cell.wrong})` : ""}
        </span>
      </span>
    );
  }
  if (cell.pending > 0) {
    return (
      <span className="block rounded-lg bg-warn/10 px-1 py-1 font-semibold text-warn" title="Being judged" data-cell="pending">
        ?{cell.wrong > 0 ? <span className="ml-0.5 text-xs text-bad">−{cell.wrong}</span> : null}
      </span>
    );
  }
  if (cell.score !== null && cell.score > 0) {
    // IOI partial credit
    return (
      <span className="block rounded-lg bg-warn/10 px-1 py-1 font-semibold text-warn" data-cell="partial">
        {cell.score}
      </span>
    );
  }
  if (cell.wrong > 0) {
    return (
      <span className="block font-semibold text-bad" data-cell="wrong">
        −{cell.wrong}
      </span>
    );
  }
  return <span className="text-faint">·</span>;
}
