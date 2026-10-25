import type { ReactNode } from "react";

/**
 * The top of every page, so they all read the same: a kicker, the title, one
 * line on what the page is for, actions on the right, and an optional strip
 * below (stats, tabs).
 */
export default function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
          <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-tight text-ink sm:text-[2rem]">{title}</h1>
          {description && <p className="mt-1.5 max-w-2xl text-[0.9375rem] text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}

/** A small figure in a header strip: "128 submissions". */
export function HeaderStat({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-line/70 bg-surface/70 px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tracking-tight ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink"}`}>
        {value}
      </p>
    </div>
  );
}
