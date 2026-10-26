import { useRef, type MouseEvent, type ReactNode } from "react";

/** Two digits that roll in from above each time they change. */
function Rolling({ value }: { value: string }) {
  return (
    <span className="inline-flex overflow-hidden" aria-hidden="true">
      {value.split("").map((d, i) => (
        // Keyed by the digit, so only a changed digit re-mounts and rolls.
        <span key={`${i}-${d}`} className="inline-block animate-[vr-roll_380ms_cubic-bezier(0.22,1,0.36,1)]">
          {d}
        </span>
      ))}
    </span>
  );
}

/** A countdown in rolling tiles: days, hours, minutes, seconds. */
export function RollingClock({ ms, label, tone = "accent" }: { ms: number; label: string; tone?: "accent" | "good" }) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const parts: [string, number][] = [
    ["days", Math.floor(t / 86400)],
    ["hrs", Math.floor((t % 86400) / 3600)],
    ["min", Math.floor((t % 3600) / 60)],
    ["sec", t % 60],
  ];
  return (
    <div role="timer" aria-label={label} className="flex items-start gap-1.5">
      {parts.map(([unit, n], i) => (
        <div key={unit} className="flex items-start gap-1.5">
          {i > 0 && <span className={`pt-2 font-mono text-lg ${tone === "good" ? "text-good/50" : "text-accent/40"}`}>:</span>}
          <span className="flex flex-col items-center">
            <span className="grid min-w-[2.9rem] place-items-center rounded-xl border border-line/80 bg-paper px-1.5 py-1.5 font-mono text-2xl font-semibold tabular text-ink shadow-[inset_0_-2px_0_rgb(var(--c-line)/0.6)]">
              <Rolling value={String(n).padStart(2, "0")} />
            </span>
            <span className="mt-1 text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-faint">{unit}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** A surface with a soft light that follows the pointer. */
export function Spotlight({ className = "", children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  const onMove = (e: MouseEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <section ref={ref} onMouseMove={onMove} className={`spotlight ${className}`} {...rest}>
      {children}
    </section>
  );
}

/** Initials in overlapping circles, for the people behind a round. */
export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const tones = ["bg-accent/15 text-accent", "bg-good/15 text-good", "bg-warn/15 text-warn", "bg-sunken text-muted"];
  return (
    <span className="flex -space-x-2" aria-hidden="true">
      {shown.map((n, i) => (
        <span key={n} className={`grid h-7 w-7 place-items-center rounded-full text-[0.6875rem] font-bold uppercase ring-2 ring-surface ${tones[i % tones.length]}`}>
          {n[0]}
        </span>
      ))}
      {names.length > max && (
        <span className="grid h-7 w-7 place-items-center rounded-full bg-sunken text-[0.625rem] font-semibold text-muted ring-2 ring-surface">
          +{names.length - max}
        </span>
      )}
    </span>
  );
}

/** A progress ring: how far a draft is from going live. */
export function Ring({ value, max, size = 34, label }: { value: number; max: number; size?: number; label: string }) {
  const r = (size - 5) / 2;
  const c = 2 * Math.PI * r;
  const done = value >= max;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={4} className="stroke-line/80" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(1, value / max))}
          className={`transition-[stroke-dashoffset] duration-700 ${done ? "stroke-good" : "stroke-accent"}`}
        />
      </svg>
      <span className="absolute font-mono text-[0.625rem] font-semibold text-ink">
        {value}/{max}
      </span>
    </span>
  );
}
