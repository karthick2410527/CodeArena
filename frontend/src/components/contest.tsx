import { useEffect, useState } from "react";
import type { ContestFormat, ContestPhase } from "../api/types";

export const FORMAT_LABELS: Record<ContestFormat, string> = {
  CODEFORCES: "Codeforces rules",
  ICPC: "ICPC rules",
  ATCODER: "AtCoder rules",
  IOI: "IOI rules",
};

export const FORMAT_HELP: Record<ContestFormat, string> = {
  CODEFORCES: "Points fall as time passes and with each wrong try, down to 30% of the problem’s value.",
  ICPC: "Most problems solved wins; ties go to the lowest penalty: minutes to each solve plus 20 per wrong try.",
  ATCODER: "Points of solved problems; ties go to the earliest last solve, plus 5 minutes per wrong try.",
  IOI: "Partial credit: each problem scores the share of its tests your best submission passes.",
};

/** "2 h", "1 h 30 min", "45 min", "3 d". */
export function formatDuration(minutes: number): string {
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} d`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "01:23:45" for less than a day, "3d 04:05:06" beyond. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d > 0 ? `${d}d ` : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** "1:05" from seconds, as standings show solve times. */
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The current time, ticking every second and corrected by the server's clock
 * when one is known, so a countdown hits zero when the server says the
 * contest starts rather than when this laptop thinks it does.
 */
export function useNow(serverTime?: string): number {
  const [offset] = useState(() => (serverTime ? new Date(serverTime).getTime() - Date.now() : 0));
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}

/** The phase now, which can move on while the page is open. */
export function livePhase(startsAt: string, endsAt: string, now: number): ContestPhase {
  if (now < new Date(startsAt).getTime()) return "UPCOMING";
  if (now < new Date(endsAt).getTime()) return "RUNNING";
  return "ENDED";
}

export function PhaseBadge({ phase, published = true }: { phase: ContestPhase; published?: boolean }) {
  if (!published) {
    return <span className="chip border-dashed">Draft</span>;
  }
  const style: Record<ContestPhase, string> = {
    UPCOMING: "border-accent/30 bg-accent/10 text-accent",
    RUNNING: "border-good/30 bg-good/10 text-good",
    ENDED: "",
  };
  const label: Record<ContestPhase, string> = { UPCOMING: "Upcoming", RUNNING: "Live", ENDED: "Ended" };
  return (
    <span className={`chip ${style[phase]}`}>
      {phase === "RUNNING" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" />}
      {label[phase]}
    </span>
  );
}

/** "Starts in 01:02:03" / "Ends in 00:41:10" / "Ended". */
export function Countdown({ startsAt, endsAt, now }: { startsAt: string; endsAt: string; now: number }) {
  const phase = livePhase(startsAt, endsAt, now);
  if (phase === "ENDED") return <span className="text-muted">Ended</span>;
  const target = new Date(phase === "UPCOMING" ? startsAt : endsAt).getTime();
  return (
    <span className="tabular">
      <span className="text-muted">{phase === "UPCOMING" ? "Starts in " : "Ends in "}</span>
      <span className="font-mono font-medium text-ink">{formatClock(target - now)}</span>
    </span>
  );
}
