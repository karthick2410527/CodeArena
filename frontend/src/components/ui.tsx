import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Leaf, Moon, MoonStar, Sun, Sunset, type LucideIcon } from "lucide-react";
import { THEMES, useDisplay, type ThemeName } from "../display";

const THEME_ICONS: Record<ThemeName, LucideIcon> = { light: Sun, sand: Sunset, dark: Moon, midnight: MoonStar, emerald: Leaf };

/** The mark: a ring with a dot, the "void" a run starts from. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span
      className="relative grid shrink-0 place-items-center rounded-[7px] text-accent-ink"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, rgb(var(--c-accent)) 0%, rgb(var(--c-accent-hover)) 100%)",
        boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.3), 0 4px 12px -4px rgb(var(--c-accent) / 0.7)",
      }}
      aria-hidden="true"
    >
      <span className="rounded-full border-2 border-current" style={{ width: size * 0.46, height: size * 0.46 }} />
    </span>
  );
}

export function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <Logo />
      <span className="font-display text-[1.0625rem] font-semibold leading-none tracking-tight text-ink">VoidRun</span>
    </Link>
  );
}

export function ThemeSwitcher() {
  const [display, setDisplay] = useDisplay();
  return (
    <div role="radiogroup" aria-label="Colour theme" className="flex rounded-xl border border-line bg-paper/70 p-0.5">
      {THEMES.map(([t, label]) => {
        const Icon = THEME_ICONS[t];
        const on = display.theme === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={label}
            onClick={() => setDisplay({ theme: t })}
            className={`flex h-7 flex-1 items-center justify-center rounded-[10px] transition-colors ${
              on ? "bg-surface text-accent shadow-panel" : "text-faint hover:text-ink"
            }`}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

/** Small kicker line above a heading. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow mb-1.5">{children}</p>;
}

export function Notice({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "warn" | "bad" | "good";
  title?: string;
}) {
  const t = { neutral: "border-l-line-strong", warn: "border-l-warn", bad: "border-l-bad", good: "border-l-good" }[tone];
  return (
    <div
      role={tone === "bad" ? "alert" : "note"}
      className={`rounded-2xl border border-line/80 border-l-[3px] bg-surface p-4 shadow-sm ${t}`}
    >
      {title && <p className="mb-1 font-display font-semibold text-ink">{title}</p>}
      <div className="text-[0.95rem] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

/** Headline number with a caption, as on a dashboard. */
export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="panel px-5 py-4">
      <p className="text-xs font-medium leading-tight text-muted">{label}</p>
      <p className="tabular mt-2 font-display text-3xl font-semibold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
    </div>
  );
}

/** Provider marks, drawn inline so sign-in never depends on a third-party asset host. */
export function ProviderIcon({ provider, size = 18 }: { provider: string; size?: number }) {
  if (provider === "github") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.27a12 12 0 0 0 0 10.78l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.61 4.59 1.8l3.43-3.43A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4 3.1C6.22 6.87 8.87 4.76 12 4.76Z" />
    </svg>
  );
}
