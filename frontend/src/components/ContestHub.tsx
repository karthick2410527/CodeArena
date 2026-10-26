import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { BadgeCheck, FileCode2, Swords, type LucideIcon } from "lucide-react";
import { useViewer } from "../auth/AuthContext";

/** The hosting pages (contests, problems, plan) share a tab row. */
export function HostTabs() {
  const { signedIn } = useViewer();
  if (!signedIn) return null;
  return (
    <TabRow
      label="Host pages"
      tabs={[
        ["/host", "Contests", Swords],
        ["/studio/problems", "Problems", FileCode2],
        ["/pricing", "Plan", BadgeCheck],
      ]}
    />
  );
}

function TabRow({ label, tabs }: { label: string; tabs: [string, string, LucideIcon][] }) {
  return (
    <nav aria-label={label} className="mb-5 inline-flex rounded-full border border-line/70 bg-surface/60 p-1 backdrop-blur">
      {tabs.map(([to, label, Icon]) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({ isActive }) =>
            `inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors ${
              isActive ? "bg-ink text-paper shadow-sm" : "text-muted hover:text-ink"
            }`
          }
        >
          <Icon size={14} aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export type HeroStat = { label: string; value: ReactNode; hint?: ReactNode; tone?: "accent" | "good" };

export function HubHero({
  eyebrow,
  title,
  description,
  actions,
  stats,
  aside,
  asideClassName = "lg:w-[22rem]",
}: {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  stats?: HeroStat[];
  aside?: ReactNode;
  /** The side column's width on large screens. */
  asideClassName?: string;
}) {
  return (
    <section className="relative mb-10 overflow-hidden rounded-[1.75rem] border border-line/70 bg-surface shadow-panel">
      <div className="hero-grid absolute inset-0 opacity-80" aria-hidden="true" />
      <div className="pointer-events-none absolute -right-20 -top-28 h-80 w-80 rounded-full bg-accent/25 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-40 left-1/4 h-72 w-72 rounded-full bg-good/10 blur-3xl" aria-hidden="true" />

      <div className="relative grid gap-8 px-6 pb-7 pt-8 sm:px-10 sm:pt-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="stagger max-w-2xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/[0.07] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            {eyebrow}
          </p>
          <h1 className="mt-4 font-display text-[2.25rem] font-semibold leading-[1.05] tracking-tight text-ink sm:text-[3rem]">{title}</h1>
          <p className="mt-3 max-w-xl text-[0.9375rem] leading-relaxed text-muted sm:text-base">{description}</p>
          {actions && <div className="mt-6 flex flex-wrap items-center gap-2.5">{actions}</div>}
        </div>
        {aside && <div className={`animate-step min-w-0 ${asideClassName}`}>{aside}</div>}
      </div>

      {stats && stats.length > 0 && (
        <dl className="relative grid grid-cols-2 border-t border-line/70 bg-paper/40 backdrop-blur sm:grid-cols-4">
          {stats.map((s, i) => (
            <div
              key={s.label}
              className={`px-6 py-4 sm:px-10 ${i % 2 === 1 ? "border-l border-line/70" : ""} ${i >= 2 ? "border-t border-line/70 sm:border-t-0" : ""} ${
                i > 0 ? "sm:border-l" : ""
              }`}
            >
              <dt className="text-xs font-medium text-faint">{s.label}</dt>
              <dd
                className={`mt-1 font-display text-2xl font-semibold tracking-tight tabular ${
                  s.tone === "accent" ? "text-accent" : s.tone === "good" ? "text-good" : "text-ink"
                }`}
              >
                {s.value}
              </dd>
              {s.hint && <dd className="mt-0.5 text-xs text-faint">{s.hint}</dd>}
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** A heading for a section under the hero, with an optional count and right-hand slot. */
export function SectionHead({ id, icon: Icon, title, count, right, live }: { id?: string; icon?: LucideIcon; title: string; count?: number; right?: ReactNode; live?: boolean }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 id={id} className="flex items-center gap-2.5 font-display text-xl font-semibold tracking-tight text-ink">
        {live ? (
          <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-good" />
          </span>
        ) : (
          Icon && <Icon size={18} className="text-accent" aria-hidden="true" />
        )}
        {title}
        {count !== undefined && <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium text-muted">{count}</span>}
      </h2>
      {right}
    </div>
  );
}

/** A big "next round" countdown, in tiles. */
export function ClockTiles({ ms, label }: { ms: number; label: string }) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const parts: [string, number][] = [
    ["days", Math.floor(t / 86400)],
    ["hrs", Math.floor((t % 86400) / 3600)],
    ["min", Math.floor((t % 3600) / 60)],
    ["sec", t % 60],
  ];
  return (
    <div role="timer" aria-label={label} className="grid grid-cols-4 gap-2">
      {parts.map(([unit, n]) => (
        <div key={unit} className="rounded-xl border border-line/70 bg-paper/70 py-2 text-center">
          <div className="font-mono text-2xl font-semibold tabular text-ink">{String(n).padStart(2, "0")}</div>
          <div className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-faint">{unit}</div>
        </div>
      ))}
    </div>
  );
}
