import { useMemo, useState } from "react";
import { Crosshair, Crown, Search, Trophy, Users, Zap } from "lucide-react";
import type { ContestPhase, StandingsCell, StandingsRow, StandingsView } from "../../api/types";
import { FORMAT_LABELS, formatElapsed } from "../../components/contest";
import { Avatar, UserLink } from "../../components/people";

/** What the table knows about each problem beyond its label and points. */
export interface ProblemInfo {
  label: string;
  title: string;
}

const MEDAL: Record<number, string> = {
  1: "from-amber-200 to-amber-400 text-amber-950 ring-amber-400/40",
  2: "from-slate-100 to-slate-300 text-slate-900 ring-slate-400/40",
  3: "from-orange-200 to-orange-400 text-orange-950 ring-orange-500/40",
};
const HALO: Record<number, string> = {
  1: "from-amber-200 to-amber-500",
  2: "from-slate-200 to-slate-400",
  3: "from-orange-200 to-orange-500",
};

/**
 * The scoreboard: a podium for the leaders, a summary line, then the table.
 * Each problem cell shows, per format: ICPC "+1 / 0:42" (solved after one
 * wrong try) or "−2" (two wrong, unsolved); points formats the points and the
 * solve time; a submission still being judged shows "?". The first solve of a
 * problem is marked, and the viewer's own row is highlighted.
 */
export default function StandingsTable({
  view,
  me,
  problems = [],
}: {
  view: StandingsView;
  me?: string;
  problems?: ProblemInfo[];
}) {
  const icpc = view.format === "ICPC";
  const penalty = icpc || view.format === "ATCODER";
  const [query, setQuery] = useState("");
  const titles = useMemo(() => new Map(problems.map((p) => [p.label, p.title])), [problems]);
  const stats = useMemo(() => problemStats(view), [view]);

  if (view.rows.length === 0) {
    return (
      <div className="card grid place-items-center gap-3 px-6 py-14 text-center">
        <span className="icon-tile">
          <Users size={18} aria-hidden="true" />
        </span>
        <p className="font-semibold text-ink">Nobody has registered yet</p>
        <p className="max-w-sm text-sm text-muted">Contestants appear here the moment they register, and move as their verdicts arrive.</p>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const rows = q
    ? view.rows.filter(
        (r) => r.participant.username.toLowerCase().includes(q) || (r.participant.display_name ?? "").toLowerCase().includes(q),
      )
    : view.rows;
  const mine = view.rows.find((r) => r.participant.username === me);
  const accepted = stats.reduce((n, s) => n + s.solved, 0);

  return (
    <div className="space-y-5">
      {view.rows.length >= 2 && <Podium rows={view.rows.slice(0, 3)} icpc={icpc} phase={view.phase} me={me} />}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-ink">
              {view.phase === "ENDED" ? "Final standings" : "Live standings"}
              {view.phase === "RUNNING" && <span className="h-2 w-2 animate-pulse rounded-full bg-good" aria-hidden="true" />}
            </h2>
            <p className="text-xs text-muted">
              {FORMAT_LABELS[view.format]} · {view.rows.length} {view.rows.length === 1 ? "contestant" : "contestants"} ·{" "}
              {accepted} accepted
              {view.phase === "RUNNING" &&
                ` · as of ${new Date(view.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {mine && (
              <button
                type="button"
                className="btn btn-outline min-h-[34px] px-3 text-xs"
                onClick={() => {
                  setQuery("");
                  requestAnimationFrame(() =>
                    document.getElementById(`standing-${mine.participant.user_id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
                  );
                }}
              >
                <Crosshair size={14} aria-hidden="true" /> You are #{mine.rank}
              </button>
            )}
            {view.rows.length > 8 && (
              <label className="relative">
                <span className="sr-only">Find a contestant</span>
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a contestant"
                  className="input min-h-[34px] w-48 py-1 pl-8 text-xs"
                />
              </label>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-separate border-spacing-0 text-sm [&_tr>*:last-child]:pr-3" aria-label="Standings">
            <thead className="text-[0.6875rem] uppercase tracking-[0.08em] text-faint">
              <tr>
                <th className="sticky left-0 z-10 w-16 bg-paper px-3 py-3 text-center font-semibold">Rank</th>
                <th className="sticky left-16 z-10 bg-paper px-3 py-3 text-left font-semibold">Contestant</th>
                <th className="bg-paper px-3 py-3 text-right font-semibold">{icpc ? "Solved" : "Score"}</th>
                {penalty && <th className="bg-paper px-3 py-3 text-right font-semibold">Penalty</th>}
                {view.problems.map((p, i) => {
                  const s = stats[i];
                  const title = titles.get(p.label);
                  return (
                    <th key={p.label} className="w-[5.5rem] bg-paper px-1.5 py-2.5 text-center font-semibold" title={title ? `${p.label}. ${title}` : undefined}>
                      <span className="block font-display text-base normal-case tracking-normal text-ink">{p.label}</span>
                      {!icpc && <span className="block font-mono normal-case tracking-normal">{p.points}</span>}
                      <span className="mx-auto mt-1 block h-1 w-12 overflow-hidden rounded-full bg-line/70" aria-hidden="true">
                        <span className="block h-full rounded-full bg-good/70" style={{ width: `${(s.solved / view.rows.length) * 100}%` }} />
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Row key={r.participant.user_id} r={r} icpc={icpc} penalty={penalty} mine={r.participant.username === me} index={i} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3 + (penalty ? 1 : 0) + view.problems.length} className="px-4 py-8 text-center text-muted">
                    Nobody matches “{query}”.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="text-xs text-muted">
              <tr>
                <td className="sticky left-0 z-10 border-t border-line bg-paper" />
                <td className="sticky left-16 z-10 border-t border-line bg-paper px-3 py-2.5 text-left font-medium text-ink">Solved / tried</td>
                <td className="border-t border-line bg-paper" />
                {penalty && <td className="border-t border-line bg-paper" />}
                {stats.map((s) => (
                  <td key={s.label} className="border-t border-line bg-paper px-1 py-2.5 text-center">
                    <span className="block font-mono font-semibold text-ink tabular">
                      {s.solved}
                      <span className="font-normal text-faint">/{s.tried}</span>
                    </span>
                    <span className="block font-mono text-[0.625rem] text-faint">{s.first !== null ? `1st ${formatElapsed(s.first)}` : "—"}</span>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        <Legend icpc={icpc} />
      </div>
    </div>
  );
}

function Row({ r, icpc, penalty, mine, index }: { r: StandingsRow; icpc: boolean; penalty: boolean; mine: boolean; index: number }) {
  // Sticky cells need an opaque background, so the tint is layered over the surface colour.
  const bg = mine ? "bg-surface bg-[linear-gradient(rgb(var(--c-accent)/0.08),rgb(var(--c-accent)/0.08))]" : "bg-surface";
  const cellBase = `border-t border-line/60 ${bg}`;
  const name = r.participant.display_name?.trim();
  return (
    <tr
      id={`standing-${r.participant.user_id}`}
      aria-current={mine ? "true" : undefined}
      className="animate-step group"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
    >
      <td className={`sticky left-0 z-10 px-3 py-2 text-center ${cellBase} ${mine ? "shadow-[inset_3px_0_0_rgb(var(--c-accent))]" : ""}`}>
        <RankBadge rank={r.rank} />
      </td>
      <td className={`sticky left-16 z-10 px-3 py-2 ${cellBase}`}>
        <span className="flex items-center gap-2.5">
          <Avatar username={r.participant.username} url={r.participant.avatar_url} size={30} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <UserLink username={r.participant.username} />
              {mine && <span className="rounded-full bg-accent px-1.5 py-px text-[0.625rem] font-semibold uppercase tracking-wide text-accent-ink">you</span>}
            </span>
            {name && name !== r.participant.username && <span className="block truncate text-xs text-faint">{name}</span>}
          </span>
        </span>
      </td>
      <td className={`px-3 py-2 text-right ${cellBase}`}>
        <span className="font-display text-lg font-semibold text-ink tabular">{r.score}</span>
        {!icpc && <span className="block text-[0.6875rem] text-faint">{r.solved} solved</span>}
      </td>
      {penalty && (
        <td className={`px-3 py-2 text-right font-mono text-xs text-muted ${cellBase}`}>
          {r.penalty === null ? "" : icpc ? r.penalty : formatElapsed(r.penalty)}
        </td>
      )}
      {r.cells.map((cell) => (
        <td key={cell.label} className={`px-1 py-1.5 text-center ${cellBase}`}>
          <Cell cell={cell} icpc={icpc} />
        </td>
      ))}
    </tr>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const medal = MEDAL[rank];
  if (!medal) return <span className="font-mono text-sm text-muted tabular">{rank}</span>;
  return (
    <span className={`inline-grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br font-display text-xs font-bold ring-2 ${medal}`}>
      {rank}
    </span>
  );
}

const CELL = "relative mx-auto grid h-12 w-[4.75rem] place-content-center rounded-xl leading-tight";

function Cell({ cell, icpc }: { cell: StandingsCell; icpc: boolean }) {
  if (cell.solved) {
    const top = icpc ? (cell.wrong > 0 ? `+${cell.wrong}` : "+") : String(cell.score ?? "");
    return (
      <span
        className={`${CELL} ${cell.first_solve ? "bg-good/25 ring-1 ring-inset ring-good/50" : "bg-good/10"}`}
        title={cell.first_solve ? "First to solve" : undefined}
        data-cell="solved"
      >
        {cell.first_solve && (
          <Zap size={11} className="absolute right-1 top-1 fill-amber-400 text-amber-500" aria-label="First to solve" />
        )}
        <span className="block font-semibold text-good tabular">{top}</span>
        <span className="block font-mono text-[0.6875rem] text-muted">
          {cell.solved_at !== null ? formatElapsed(cell.solved_at) : ""}
          {!icpc && cell.wrong > 0 ? <span className="text-bad"> −{cell.wrong}</span> : null}
        </span>
      </span>
    );
  }
  if (cell.pending > 0) {
    return (
      <span className={`${CELL} bg-warn/10 font-semibold text-warn`} title="Being judged" data-cell="pending">
        <span className="animate-pulse">?{cell.wrong > 0 ? <span className="ml-0.5 text-xs text-bad">−{cell.wrong}</span> : null}</span>
      </span>
    );
  }
  if (cell.score !== null && cell.score > 0) {
    // IOI partial credit
    return (
      <span className={`${CELL} bg-warn/10 font-semibold text-warn tabular`} data-cell="partial">
        {cell.score}
      </span>
    );
  }
  if (cell.wrong > 0) {
    return (
      <span className={`${CELL} bg-bad/[0.07] font-semibold text-bad`} data-cell="wrong">
        −{cell.wrong}
      </span>
    );
  }
  return <span className="text-line-strong" aria-label="Not tried">–</span>;
}

/** The top three, standing on blocks: second, first, third. */
function Podium({ rows, icpc, phase, me }: { rows: StandingsRow[]; icpc: boolean; phase: ContestPhase; me?: string }) {
  const order = [rows[1], rows[0], rows[2]].filter(Boolean) as StandingsRow[];
  const height: Record<number, string> = { 1: "h-24", 2: "h-16", 3: "h-12" };
  return (
    <section className="card dots overflow-hidden px-4 pt-6 sm:px-8" aria-label={phase === "ENDED" ? "Winners" : "Leaders"}>
      <p className="eyebrow flex items-center justify-center gap-1.5">
        <Trophy size={13} aria-hidden="true" /> {phase === "ENDED" ? "Winners" : "Leading now"}
      </p>
      <ol className="mx-auto mt-5 grid max-w-2xl grid-cols-3 items-end gap-3 sm:gap-5">
        {order.map((r, i) => {
          const pos = r.rank <= 3 ? r.rank : 3;
          return (
            <li key={r.participant.user_id} className="animate-step flex min-w-0 flex-col items-center" style={{ animationDelay: `${i * 90}ms` }}>
              <span className="relative">
                <span className={`block rounded-full p-[3px] bg-gradient-to-br ${HALO[pos]}`}>
                  <span className="block rounded-full bg-surface p-0.5">
                    <Avatar username={r.participant.username} url={r.participant.avatar_url} size={pos === 1 ? 56 : 44} />
                  </span>
                </span>
                {pos === 1 && (
                  <Crown size={20} className="absolute -top-4 left-1/2 -translate-x-1/2 fill-amber-300 text-amber-500" aria-hidden="true" />
                )}
              </span>
              <span className="mt-2 flex max-w-full items-center gap-1 truncate text-sm">
                <UserLink username={r.participant.username} className="truncate" />
                {r.participant.username === me && <span className="text-[0.625rem] font-semibold uppercase text-accent">you</span>}
              </span>
              <span className="font-mono text-xs text-muted tabular">
                {icpc ? `${r.score} solved · ${r.penalty ?? 0} min` : `${r.score} pts`}
              </span>
              <span
                className={`mt-2 grid w-full place-items-center rounded-t-xl border border-b-0 border-line bg-gradient-to-b from-sunken to-paper font-display text-2xl font-semibold text-ink/70 ${height[pos]}`}
                aria-label={`Rank ${r.rank}`}
              >
                {r.rank}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Legend({ icpc }: { icpc: boolean }) {
  const item = "flex items-center gap-1.5";
  const swatch = "inline-block h-3 w-3 rounded";
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line bg-paper/40 px-4 py-2.5 text-xs text-muted sm:px-5">
      <span className={item}>
        <span className={`${swatch} bg-good/25 ring-1 ring-inset ring-good/50`} /> First to solve
        <Zap size={11} className="fill-amber-400 text-amber-500" aria-hidden="true" />
      </span>
      <span className={item}>
        <span className={`${swatch} bg-good/10`} /> Solved {icpc ? "(+n wrong tries, time)" : "(points, time, −wrong tries)"}
      </span>
      <span className={item}>
        <span className={`${swatch} bg-bad/10`} /> Not solved yet
      </span>
      <span className={item}>
        <span className={`${swatch} bg-warn/15`} /> Being judged
      </span>
      <span className="ml-auto text-faint">Times are from the start of the contest</span>
    </div>
  );
}

function problemStats(view: StandingsView) {
  return view.problems.map((p, i) => {
    let solved = 0;
    let tried = 0;
    let first: number | null = null;
    for (const r of view.rows) {
      const c = r.cells[i];
      if (!c) continue;
      if (c.solved || c.wrong > 0 || c.pending > 0 || (c.score ?? 0) > 0) tried++;
      if (c.solved) {
        solved++;
        if (c.solved_at !== null && (first === null || c.solved_at < first)) first = c.solved_at;
      }
    }
    return { label: p.label, solved, tried, first };
  });
}
